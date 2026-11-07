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
  // Render/Aiven synthetic pilot: signed-in organizers outside this list are denied.
  STUDIO_PILOT_ORGANIZER_IDS: '90,91'
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

// The repository in GitHub's immutable OIDC subject form, owner@ownerId/repo@repoId, because that is what GitHub presents for this
// repository (Actions OIDC setting use_immutable_subject = true; deployment #12 failed with AADSTS700213 against the name form
// CetchApp/invi-studio). The ids identify the owner and the repository and survive a rename. The federated credential subject is
// repo:<this value>:environment:<githubEnvironment>.
param githubRepository = 'CetchApp@262199775/invi-studio@1305967652'
param githubEnvironment = 'production'
