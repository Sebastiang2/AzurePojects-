using '../modules/studio-platform-rbac.bicep'

// Deployment `studio-platform-rbac`: access for the Studio app and the onboarding API. NEEDS AN OWNER (or User Access Administrator, or Role
// Based Access Control Administrator). Contributor cannot run it: it fails with AuthorizationFailed and changes nothing. Run it only through
// the safety gate:
//
//   bash Infrastructure/scripts/deploy.sh --deployment studio-platform-rbac --dry-run
//   bash Infrastructure/scripts/deploy.sh --deployment studio-platform-rbac
//
// Touches only the role assignments it declares, on named secrets and on the two apps. Not the apps or the identities (all `existing`), not
// the vault, not any other secret. Run it after the `onboardingapi` and `studio` deployments (they create the identities) and after every
// secret named here exists: Azure refuses a role assignment on a secret that is not there. Where each secret comes from:
//   studio-api-key          new, created by a person with access to the private vault (random, 32+ characters); the same value is read
//                           by Studio and by the onboarding API
//   studio-session-secret   new, created the same way (random, 48+ characters); read by Studio only
//   database-password       exists (the Data API and the Auth API read it too)
// The role is Key Vault Secrets User on each secret and not on the vault. It takes a few minutes to reach the vault's data plane.
// Removing a name from a list later does not remove its assignment (Incremental mode never deletes); delete it with az role assignment delete.
//
// Website Contributor on the app goes to the user-assigned identity the app's GitHub workflow signs in with, and only on that one app.

param workloadName = 'invi'
param environment = 'prod'
param instance = '001'

param studioSecretNames = [
  'studio-api-key'
  'studio-session-secret'
]

param onboardingApiSecretNames = [
  'studio-api-key'
  'database-password'
]
