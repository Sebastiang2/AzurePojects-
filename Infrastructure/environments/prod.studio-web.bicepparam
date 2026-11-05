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
  // Optional: without them Studio starts and skips the Google lookup and the cAI texts (launch.mjs requires only the two
  // above). openai-api-key is the existing vault secret the Studio API and the Data API already use; the Google key is
  // Studio's own. No map token and no billing test-mode flag: Studio reads no map token, and test mode is ignored on every
  // Azure site (docs/studio-web-rollout.md).
  {
    setting: 'GOOGLE_PLACES_API_KEY'
    secretName: 'studio-google-places-api-key'
  }
  {
    setting: 'OPENAI_API_KEY'
    secretName: 'openai-api-key'
  }
]

param githubRepository = 'CetchApp/invi-studio'
param githubEnvironment = 'production'
