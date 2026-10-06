using '../modules/adminapp.bicep'

// Deployment A: the production admin web app, app-invi-admin-prod-001, on the existing plan
// asp-invi-prod-001. CONTRIBUTOR IS ENOUGH: this deployment creates no role assignment, so it never
// waits for an Owner.
//
// Bound to the admin app module on purpose: a deployment of this file can only touch the admin app,
// its Application Insights resource and its diagnostic setting, unlike main.bicep. It creates no App
// Service plan, network or Key Vault and changes neither API. Default Incremental mode (never
// Complete, which would delete everything else in the group), subscription pinned:
//
//   az deployment group what-if -g rg-invi-prod-swc-001 \
//     --subscription <SUBSCRIPTION_ID> \
//     --parameters Infrastructure/environments/prod.adminapp.bicepparam
//
//   az deployment group create -g rg-invi-prod-swc-001 \
//     --subscription <SUBSCRIPTION_ID> \
//     --name invi-prod-adminapp-001 \
//     --parameters Infrastructure/environments/prod.adminapp.bicepparam
//
// The admin app takes three deployments, each with its own file:
//   A  prod.adminapp.bicepparam                            Contributor            (this file)
//   B  prod.adminapp.rbac-owner.bicepparam                 OWNER ONLY             Key Vault access
//   C  prod.adminapp.domain-admin-cetchapp-com.bicepparam  Contributor            hostname and TLS
//
// Order of work:
//   1. A with both Entra parameters empty (done: invi-prod-adminapp-001 and -002). The site exists and
//      refuses all inbound traffic: no authentication is configured yet. Application code deployed
//      before step 6 is safe, because nothing can reach it, but it cannot be tested either.
//   2. Entra, by hand: a single-tenant app registration with a Web redirect URI
//      https://admin.cetchapp.com/.auth/login/aad/callback, ID tokens enabled (App Service uses the
//      hybrid flow once there is a client secret), a client secret, and the app role Invi.Admin; on
//      the enterprise application set "Assignment required" to Yes and assign the administrators
//      with that role. To test sign-in before DNS exists, add the redirect URI of the default host
//      name too, https://<adminAppHostname>/.auth/login/aad/callback, and remove it afterwards.
//   3. Key Vault, by hand: create the secret admin-publishing-api-key (32+ random characters). The
//      Data API reads the same value as ADMIN_PUBLISHING_API_KEY.
//   4. B, by an Owner.
//   5. DNS, by hand, and C: bind the hostname, then TLS (see prod.adminapp.domain-*.bicepparam).
//      Can also be done after step 6.
//   6. A with Easy Auth: the two parameters at the bottom of this file are set (2026-10-06); export
//      the secret and deploy again. Sign-in is then required for every path and the site opens.
//   7. Application code, built in CI and deployed as a built package; nothing builds on the instance.
//
// After every deployment of this file, read back what Azure actually applied. A successful deployment
// does not prove it: on 2026-10-06 Azure dropped Route All (see modules/adminapp.bicep). Expect
// routeAll true, and inboundDefault "Deny" until Easy Auth is configured, "Allow" after:
//
//   az webapp config show -g rg-invi-prod-swc-001 -n app-invi-admin-prod-001 \
//     --subscription <SUBSCRIPTION_ID> \
//     --query "{routeAll:vnetRouteAllEnabled, inboundDefault:ipSecurityRestrictionsDefaultAction}"
//
// The Entra client secret is a secret. It is read from the deploying shell, never written in this file
// or anywhere in Git (same mechanism as MYSQL_ADMIN_PASSWORD in prod.bicepparam), and it is stored
// as an App Setting, which anyone who can read this site's App Settings can read. It has an expiry
// date: rotate it before then, or sign-in stops.

param workloadName = 'invi'
param environment = 'prod'
param instance = '001'
param location = 'swedencentral'

param tags = {
  environment: 'prod'
  application: 'invi'
  managedBy: 'bicep'
}

param adminPublicUrl = 'https://admin.cetchapp.com'
param dataApiBaseUrl = 'https://api.cetchapp.com'

// Step 6, Easy Auth. "Invi Production Admin" exists in Entra: the client ID is its application (client)
// ID, not its object ID. Easy Auth is on only while both values are non-empty; an empty value drops the
// Easy Auth settings and the site is closed again (inbound Deny). The secret is read from the deploying
// shell and is never written anywhere: export ADMIN_ENTRA_CLIENT_SECRET first (Entra credential
// easyauth-prod-2026-10, expires 2027-04-01: rotate it before then or sign-in stops). With no default,
// an unset variable stops the deployment (BCP427) instead of removing the secret from the site.
param entraClientId = '7da1f9db-3f02-4e08-85aa-3c6743ddc5cb'
param entraClientSecret = readEnvironmentVariable('ADMIN_ENTRA_CLIENT_SECRET')
