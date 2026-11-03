using '../modules/studio-web.bicep'

// Deployment E: open the main site of the Studio web app to everybody. Not part of the first launch: apply it only after deployment A to D
// are done, the code is deployed and verified from inside the app (Kudu SSH, /api/health and /api/health?deep=1 on localhost) and the
// certificate is issued. The what-if of this file shows exactly one change, siteConfig.ipSecurityRestrictionsDefaultAction Deny to Allow.
// Rollback: deploy prod.studio-web.bicepparam (ingressMode closed). Nothing else of this app, no other site and no other service changes.
param workloadName = 'invi'
param environment = 'prod'
param instance = '001'
param location = 'swedencentral'

// public: everybody may reach the main site (default action Allow, no rule). The only difference from prod.studio-web.bicepparam;
// a test compares the two files.
param ingressMode = 'public'

param tags = {
  environment: 'prod'
  application: 'invi-studio'
  managedBy: 'bicep'
}

param linuxFxVersion = 'NODE|22-lts'

// PR #1 packages .next/standalone and copies launch.mjs beside server.js. The launcher loads secrets through the
// private Key Vault endpoint before importing server.js.
param appCommandLine = 'node launch.mjs'

param appSettings = {
  NODE_ENV: 'production'
  STUDIO_ENVIRONMENT: 'production'
  HOSTNAME: '0.0.0.0'
  NEXT_TELEMETRY_DISABLED: '1'
  ONBOARDING_API_BASE_URL: 'https://invi-studio-api.onrender.com'
  STUDIO_PUBLIC_URL: 'https://studio.invi.lol'
  STUDIO_PUBLIC_ORIGIN: 'https://studio.invi.lol'
  STUDIO_REQUIRE_EMAIL: 'false'
}

// These names are metadata. Values stay in Key Vault. The API must use the same studio-api-key value.
param settingSecretNames = [
  {
    setting: 'STUDIO_API_KEY'
    secretName: 'studio-api-key'
  }
  {
    setting: 'STUDIO_SESSION_SECRET'
    secretName: 'studio-session-secret'
  }
]

param githubRepository = 'CetchApp/invi-studio'
param githubEnvironment = 'production'
