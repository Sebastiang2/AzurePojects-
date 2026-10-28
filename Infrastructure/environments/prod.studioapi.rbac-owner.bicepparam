using '../modules/studioapi-rbac.bicep'

// Deployment B: role assignments for the Studio API. NEEDS AN OWNER (or User Access Administrator, or Role Based Access
// Control Administrator). Contributor cannot run it: it fails with AuthorizationFailed and changes nothing.
//
// Touches only the role assignments below. Not the Studio API, which is `existing`, and not the vault or any secret.
// Through the safety gate only:
//
//   bash Infrastructure/scripts/deploy.sh --deployment studioapi-b-rbac --dry-run
//   bash Infrastructure/scripts/deploy.sh --deployment studioapi-b-rbac
//
// Run it after deployment A (prod.studioapi.bicepparam), which creates both identities, and after every secret listed here
// exists: Azure refuses a role assignment on a secret that is not there yet. The list must match the secret names in
// keyVaultReferences of prod.studioapi.bicepparam. Removing a secret from this list later does not remove its role
// assignment (Incremental mode never deletes); delete it with az role assignment delete.

param workloadName = 'invi'
param environment = 'prod'
param instance = '001'

param secretNames = [
  'database-password'
  'studio-api-key'
  'studio-admin-api-key'
  'resend-api-key'
  'openai-api-key'
]

// Output githubDeployPrincipalId of deployment A (an object id, not a secret). Empty until A has run.
param githubDeployPrincipalId = ''
