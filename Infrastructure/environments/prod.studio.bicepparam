using '../modules/webapp.bicep'

// Deployment `studio`: Invi Studio (invi-studio, Next.js on Node), app-invi-studio-prod-001, served as https://studio.invi.lol, on the
// existing plan asp-invi-prod-001. CONTRIBUTOR IS ENOUGH: no role assignment is created here. Run it only through the safety gate:
//
//   bash Infrastructure/scripts/deploy.sh --deployment studio --dry-run
//   bash Infrastructure/scripts/deploy.sh --deployment studio
//
// It creates the site (system-assigned identity, VNet integration with Route All, HTTPS only, FTP and basic SCM credentials off), its
// Application Insights resource and diagnostic setting, and the user-assigned identity id-gha-invi-studio-prod-001 with a federated
// credential for the GitHub environment `production` of CetchApp/invi-studio. It changes neither API, the plan, the network, MySQL or the
// Key Vault. The host name studio.invi.lol is bound by the `studio-domain` deployments after DNS exists.
//
// Studio runs as a standalone Next.js server, built and zipped by its own workflow, and started with `node launch.mjs`: that file reads the
// secrets from Key Vault (see settingSecretNames below) and then starts server.js. It reaches only one backend: the onboarding API, server to
// server, at the API's default host name. The browser never sees the Studio key.
//
// Order of work: see prod.onboardingapi.bicepparam and docs/studio-and-onboarding-api.md.
//
// Not set on purpose, until each has a Key Vault secret and a role on it (add the name to settingSecretNames here and to
// studio-platform-rbac in the same change): GOOGLE_PLACES_API_KEY and OPENAI_API_KEY (sign-up look-up and profile text, both optional),
// STRIPE_SECRET_KEY (billing). STRIPE_PRICE_ID, STRIPE_MERCH_PRICE_ID and STUDIO_BILLING_EXEMPT are not secret and go in appSettings. Studio
// runs without them; each feature stays off or degrades. Billing is off until STRIPE_SECRET_KEY and a plan's price are both set, and while it
// is off the plans are free (booking resources and club merch can be added and published without paying). STUDIO_BILLING_PREVIEW is a
// development switch that does nothing in production and must not be set here.

param workloadName = 'invi'
param environment = 'prod'
param instance = '001'
param location = 'swedencentral'

param tags = {
  environment: 'prod'
  application: 'invi'
  component: 'studio'
  managedBy: 'bicep'
}

param appKey = 'studio'

// Node 24 LTS (supported to 2028-04); the admin app is on 22.
param linuxFxVersion = 'NODE|24-lts'
// launch.mjs (next to server.js in the package) loads the secrets from Key Vault into the environment, then starts the standalone server. HOSTNAME
// makes the server listen on all interfaces; the port comes from the platform (PORT).
param appCommandLine = 'node launch.mjs'

param appSettings = {
  NODE_ENV: 'production'
  HOSTNAME: '0.0.0.0'
  NEXT_TELEMETRY_DISABLED: '1'

  // The onboarding API's default host name (the siteHostname output of the `onboardingapi` deployment).
  ONBOARDING_API_BASE_URL: 'https://app-invi-onboarding-api-prod-001.azurewebsites.net'

  // The origin Studio is served from. The same-origin check on sign-in and other changes trusts this and nothing else: request.url
  // behind the proxy says localhost, and the default azurewebsites.net host name is deliberately not accepted for sign-in.
  STUDIO_PUBLIC_ORIGIN: 'https://studio.invi.lol'

  // Must have the same value as in the onboarding API (prod.onboardingapi.bicepparam).
  STUDIO_REQUIRE_EMAIL: 'false'
}

// environment variable name -> Key Vault secret name, read by launch.mjs when Studio starts (KEY_VAULT_URI and KEY_VAULT_MAP are generated from this;
// see prod.onboardingapi.bicepparam). Studio and the onboarding API read the SAME studio-api-key: it is the shared key between them.
param settingSecretNames = {
  STUDIO_API_KEY: 'studio-api-key'
  STUDIO_SESSION_SECRET: 'studio-session-secret'
}

param githubRepository = 'CetchApp/invi-studio'
