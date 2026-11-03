using '../modules/studio-web.bicep'

// Deployment A: Studio web resources only. No RBAC, DNS or certificate changes.
param workloadName = 'invi'
param environment = 'prod'
param instance = '001'
param location = 'swedencentral'

// closed: the main site refuses every request. This is also the rollback of prod.studio-web.ingress-public.bicepparam, which
// is this file with 'public'. Keep the two files identical apart from this line (a test compares them).
param ingressMode = 'closed'

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
