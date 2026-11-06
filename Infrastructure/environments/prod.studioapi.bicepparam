using '../modules/studioapi.bicep'

// Deployment A: the production Invi Studio API, app-invi-studio-api-prod-001, on the existing plan asp-invi-prod-001.
// CONTRIBUTOR IS ENOUGH: this deployment creates no role assignment, so it never waits for an Owner.
//
// Bound to the Studio module on purpose: a deployment of this file can only touch the Studio API, its Application Insights
// resource, its diagnostic setting and its GitHub deploy identity, unlike main.bicep. Through the safety gate only:
//
//   bash Infrastructure/scripts/deploy.sh --deployment studioapi-a --dry-run
//   bash Infrastructure/scripts/deploy.sh --deployment studioapi-a
//
// The Studio API takes two deployments, each with its own file:
//   A  prod.studioapi.bicepparam              Contributor   (this file)
//   B  prod.studioapi.rbac-owner.bicepparam   OWNER ONLY    Key Vault access, GitHub deploy right
//
// Order of work (the whole of it is in docs/studio-web-rollout.md, "The Studio API on Azure"):
//   1. Key Vault, by hand: studio-api-key already exists (Studio web reads it, and this API reads the same secret, so the key Studio
//      sends is the key the API expects). Create studio-admin-api-key (a new production value, openssl rand -base64 32). The vault is
//      private: this has to run from inside the VNet. database-password, resend-api-key and openai-api-key exist and are shared with
//      the Data API. The admin app gets the studio-admin-api-key value when it calls this API.
//   2. A as below: closed (inbound Deny), no code. Creates the site, its system identity, Application Insights and the GitHub
//      deploy identity with its credential for the production environment of the onboarding repository. Its outputs
//      githubDeployPrincipalId and githubDeployClientId are needed in steps 3 and 5. The startup command is set from the start;
//      until the first code arrives the site has nothing to run, so do step 3 and 5 in the same window and do not leave A alone for days.
//   3. B, by an Owner. Then check that every Key Vault reference shows as Resolved (portal: Environment variables).
//      Optional features, added when they are wanted (the API starts without them; only that feature answers "not set
//      up"): MAILBOX_PASSWORD (inbox), FACEBOOK_APP_SECRET and FACEBOOK_TOKEN_ENCRYPTION_KEY (Facebook). Add each to
//      keyVaultReferences and to B, then deploy A and B. FACEBOOK_TOKEN_ENCRYPTION_KEY is generated once and NEVER
//      changed: the Facebook tokens in the DB are encrypted with it.
//   4. The database, before the first code deployment, because the first start changes it (Studio tables, one ResourceTable row, the
//      ended-activities job). In the onboarding repository: "Launch preflight and database changes" in the README and
//      Migrations/BILLING-EXEMPTION-RUNBOOK.md. Read-only preflight, backup point, the billing-exemption migration, check.
//   5. The workflow in the onboarding repository (.github/workflows/deploy-azure.yml): azure/login (OIDC, client id
//      githubDeployClientId), dotnet publish, azure/webapps-deploy to app-invi-studio-api-prod-001, in the GitHub environment
//      githubEnvironment. After the deployment it fails unless the service reports mysql-invi-prod-001 / invi as its database.
//   6. Test from inside (Kudu/SSH: curl http://localhost:8080/api/health and /health), then studioInboundOpen = true and deploy A.
//      Then point Studio web (ONBOARDING_API_BASE_URL in prod.studio-web*.bicepparam) and the admin app at this API.
//   7. Once stable: studioHealthCheckEnabled = true.
//
// After every deployment of this file, read back what Azure actually applied:
//
//   az webapp config show -g rg-invi-prod-swc-001 -n app-invi-studio-api-prod-001 \
//     --subscription <SUBSCRIPTION_ID> \
//     --query "{routeAll:vnetRouteAllEnabled, inboundDefault:ipSecurityRestrictionsDefaultAction, rules:length(ipSecurityRestrictions)}"

param workloadName = 'invi'
param environment = 'prod'
param instance = '001'
param location = 'swedencentral'

param tags = {
  environment: 'prod'
  application: 'invi'
  managedBy: 'bicep'
}

// Core DB, as the APIs use it (prod.bicepparam: databaseName, mysqlAdminUsername).
param databaseName = 'invi'
param databaseUser = 'inviadmin'

// Same verified Invi Activities user as the Data API (prod.bicepparam: dataApiActivityCreatorId).
param activityCreatorId = 1636

// App Setting -> Key Vault secret. database-password, resend-api-key and openai-api-key exist and are shared with the Data
// API (same accounts); the studio-* secrets are new. Only what the API needs to start, plus OpenAI and Resend (existing
// secrets); the optional inbox and Facebook secrets are added when wanted (see step 4 above). Every secret here must also be
// in prod.studioapi.rbac-owner.bicepparam.
param keyVaultReferences = [
  {
    setting: 'ONBOARDING_DB_PASSWORD'
    secretName: 'database-password'
  }
  {
    setting: 'STUDIO_API_KEY'
    secretName: 'studio-api-key'
  }
  {
    setting: 'STUDIO_ADMIN_API_KEY'
    secretName: 'studio-admin-api-key'
  }
  {
    setting: 'RESEND_API_KEY'
    secretName: 'resend-api-key'
  }
  {
    setting: 'OPENAI_API_KEY'
    secretName: 'openai-api-key'
  }
]

// The assembly of CetchApp/cetchapp-onboarding-api (invi-studio-api.csproj), published as a zip with the files at its root.
param appCommandLine = 'dotnet invi-studio-api.dll'

// The repository whose `production` environment may deploy to this site. GitHub presents the plain subject for it:
// gh api repos/CetchApp/cetchapp-onboarding-api/actions/oidc/customization/sub said use_immutable_subject false on 2026-11-06, so the
// credential subject is repo:CetchApp/cetchapp-onboarding-api:environment:production. If that setting is ever turned on for the
// repository, azure/login fails with AADSTS700213 and this value must take the form CetchApp@<ownerId>/cetchapp-onboarding-api@<repoId>,
// as for Studio web (docs/studio-web-rollout.md, "GitHub OIDC subject").
param githubRepository = 'CetchApp/cetchapp-onboarding-api'

// Non-secret settings. Everything else the API reads is off or defaulted when absent (README of the onboarding repository, "Settings the
// code reads"). Left absent on purpose: STUDIO_REQUIRE_EMAIL (Studio web has it false, so no e-mail is sent and STUDIO_EMAIL_FROM is not
// needed), STUDIO_SERVER_ONLY and ADMIN_ROUTES_ENABLED (opt-in lock-down of the shared Render service, not wanted here), RESERVATION_*
// and FACEBOOK_* (features that are off).
param studioSettings = {
  // The admin and approval routes need X-Studio-Admin-Key (studio-admin-api-key). Without that secret they answer 503, never open.
  ADMIN_ACCESS_MODE: 'enforce'
}

// Closed until the code is deployed and tested; Health check off until the app has run stably.
param studioInboundOpen = false
param allowedInboundCidrs = []
param studioHealthCheckEnabled = false
