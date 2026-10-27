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
// Order of work:
//   Phase 1, infrastructure
//   1. A as below: closed (inbound Deny), no code, no federated credential. Creates the site, its system identity and the
//      GitHub deploy identity. Its outputs githubDeployPrincipalId and githubDeployClientId are needed in steps 3 and 5.
//   2. Key Vault, by hand: create studio-api-key and studio-admin-api-key (new production values, openssl rand -base64 32).
//      The vault is private: this has to run from inside the VNet. The callers (admin app, later studio-web) get the same
//      values.
//   3. B, by an Owner. Then check that every Key Vault reference shows as Resolved (portal: Environment variables).
//   Phase 2, the Studio repository
//   4. Set appCommandLine, githubRepository and studioSettings below. Deploy A.
//      Optional features, added when they are wanted (the API starts without them; only that feature answers "not set
//      up"): MAILBOX_PASSWORD (inbox), FACEBOOK_APP_SECRET and FACEBOOK_TOKEN_ENCRYPTION_KEY (Facebook). Add each to
//      keyVaultReferences and to B, then deploy A and B. FACEBOOK_TOKEN_ENCRYPTION_KEY is generated once and NEVER
//      changed: the Facebook tokens in the DB are encrypted with it.
//   5. The workflow in the Studio repository: azure/login (OIDC, client id githubDeployClientId), dotnet publish -c Release,
//      azure/webapps-deploy to app-invi-studio-api-prod-001, in the GitHub environment githubEnvironment.
//   6. Test (Kudu/SSH: /health), then studioInboundOpen = true and deploy A. Point the admin app at the Studio API.
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

// Phase 2 (from the Studio repository): startup command, deploy repository, and the non-secret settings.
param appCommandLine = ''
param githubRepository = ''
param studioSettings = {}

// Closed until the code is deployed and tested; Health check off until the app has run stably.
param studioInboundOpen = false
param allowedInboundCidrs = []
param studioHealthCheckEnabled = false
