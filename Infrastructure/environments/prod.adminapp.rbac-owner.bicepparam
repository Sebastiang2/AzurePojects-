using '../modules/adminapp-rbac.bicep'

// Deployment B: Key Vault access for the admin app. NEEDS AN OWNER (or User Access Administrator, or
// Role Based Access Control Administrator). Contributor cannot run it: it fails with AuthorizationFailed
// and changes nothing. It is not part of prod.adminapp.bicepparam, so that deployment (A) never waits
// for this one, and this one is not mistaken for it.
//
// Touches only the role assignments below, one per secret. Not the admin app, which is `existing`, and
// not the vault or any other secret. Default Incremental mode, subscription pinned, never Complete:
//
//   az deployment group what-if -g rg-invi-prod-swc-001 \
//     --subscription <SUBSCRIPTION_ID> \
//     --parameters Infrastructure/environments/prod.adminapp.rbac-owner.bicepparam
//
//   az deployment group create -g rg-invi-prod-swc-001 \
//     --subscription <SUBSCRIPTION_ID> \
//     --name invi-prod-adminapp-rbac-owner-001 \
//     --parameters Infrastructure/environments/prod.adminapp.rbac-owner.bicepparam
//
// Run it after deployment A, which creates the identity, and after every secret listed here exists.
// Azure refuses a role assignment on a secret that is not there yet. Where each secret comes from:
//   admin-publishing-api-key   created by hand; the Data API reads the same value as
//                              ADMIN_PUBLISHING_API_KEY
// The role is Key Vault Secrets User, on each secret and not on the vault, so the admin app cannot read
// any other secret in kv-invi-prod-001. The role takes a few minutes to reach the vault's data plane.
// Removing a secret from this list later does not remove its role assignment (Incremental mode never
// deletes); delete it with az role assignment delete.

param workloadName = 'invi'
param environment = 'prod'
param instance = '001'

param secretNames = [
  'admin-publishing-api-key'
]
