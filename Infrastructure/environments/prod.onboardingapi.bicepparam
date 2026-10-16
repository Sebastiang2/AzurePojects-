using '../modules/webapp.bicep'

// Deployment `onboardingapi`: the production onboarding API (cetchapp-onboarding-api, ASP.NET), app-invi-onboarding-api-prod-001, on the
// existing plan asp-invi-prod-001. CONTRIBUTOR IS ENOUGH: no role assignment is created here. Run it only through the safety gate:
//
//   bash Infrastructure/scripts/deploy.sh --deployment onboardingapi --dry-run
//   bash Infrastructure/scripts/deploy.sh --deployment onboardingapi
//
// It creates the site (system-assigned identity, VNet integration with Route All, HTTPS only, FTP and basic SCM credentials off), its
// Application Insights resource and diagnostic setting, and the user-assigned identity id-gha-invi-onboarding-api-prod-001 with a federated
// credential for the GitHub environment `production` of CetchApp/cetchapp-onboarding-api. It changes neither API, the plan, the network,
// MySQL or the Key Vault. The Studio server is the only caller; there is no custom domain, and Studio uses the default host name.
//
// Order of work (details in docs/studio-and-onboarding-api.md):
//   1. this deployment, then the Studio app deployment (prod.studio.bicepparam)
//   2. the Key Vault secrets (by a person with access to the private vault): studio-api-key (new). database-password exists already.
//   3. studio-platform-rbac (needs an Owner): reads studio-api-key and database-password
//   4. the first code deployment from the app's own workflow (manual)
//   5. verify the Key Vault references resolved:  az rest --method get --url "<site resource id>/config/configreferences/appsettings?api-version=2024-04-01"
//
// The code locks itself down with two settings below (the API was written for a trusted network): STUDIO_SERVER_ONLY makes every route except
// /api/health need the Studio key, and ADMIN_ROUTES_ENABLED=false makes /api/admin/* answer 404. If STUDIO_API_KEY is not resolved the API
// answers 503, never "open".
//
// Not set on purpose: OPENAI_API_KEY, MAILBOX_*, RESEND_API_KEY and STUDIO_EMAIL_FROM (admin and e-mail features that stay off), and
// RESERVATION_* automation. The settings bag is replaced as a whole by every deployment: add a setting here, never in the portal.

param workloadName = 'invi'
param environment = 'prod'
param instance = '001'
param location = 'swedencentral'

param tags = {
  environment: 'prod'
  application: 'invi'
  component: 'onboarding-api'
  managedBy: 'bicep'
}

param appKey = 'onboarding-api'

// The same runtime as the Data API and the Auth API. The API targets net10.0 (.NET 8 leaves support on 2026-11-10).
param linuxFxVersion = 'DOTNETCORE|10.0'
param appCommandLine = 'dotnet invi-studio-api.dll'

param appSettings = {
  ASPNETCORE_ENVIRONMENT: 'Production'
  Urls: 'http://*:8080'

  // The production MySQL server (private: reachable through the VNet only) and its database. The Data API and the Auth API use the same
  // login. A dedicated MySQL user with only the grants this API needs would be better and is a separate change (MySQL users are outside ARM).
  ONBOARDING_DB_HOST: 'mysql-invi-prod-001.mysql.database.azure.com'
  ONBOARDING_DB_PORT: '3306'
  ONBOARDING_DB_DATABASE: 'invi'
  ONBOARDING_DB_USER: 'inviadmin'
  ONBOARDING_DB_SSL_MODE: 'Required'

  // Lock-down for hosting on the internet.
  STUDIO_SERVER_ONLY: 'true'
  ADMIN_ROUTES_ENABLED: 'false'
  ENABLE_SWAGGER: 'false'

  // Studio's resource set-up, calendar and reservations. Outside Development the API serves them only with this set.
  STUDIO_RESOURCES_ENABLED: 'true'

  // Must have the same value as in Studio (prod.studio.bicepparam). false: no e-mail step at first sign-in, no "forgot password". It
  // becomes true when Resend is ready (verified sending domain, RESEND_API_KEY, STUDIO_EMAIL_FROM), in both apps in the same change.
  STUDIO_REQUIRE_EMAIL: 'false'

  // Studio calls from its server, so no browser origin is needed in practice; this is the one origin that could ever be right.
  Cors__AllowedOrigins__0: 'https://studio.invi.lol'

  // Reservation automation stays off (these are the code's defaults, written down so the gate can pin them).
  RESERVATION_NOTIFICATIONS_MODE: 'Disabled'
  RESERVATION_JOBS_ENABLED: 'false'

  XDT_MicrosoftApplicationInsights_Mode: 'recommended'
  XDT_MicrosoftApplicationInsights_PreemptSdk: '1'
}

// setting name -> Key Vault secret name. Key Vault references: the platform resolves them with the app's own identity once
// studio-platform-rbac has given it a role on that one secret.
param settingSecretNames = {
  ONBOARDING_DB_PASSWORD: 'database-password'
  STUDIO_API_KEY: 'studio-api-key'
}

param githubRepository = 'CetchApp/cetchapp-onboarding-api'
