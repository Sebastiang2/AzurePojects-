targetScope = 'resourceGroup'

// Key Vault access for the admin app. Deployment B of three, and the only one that needs
// more than Contributor: creating a role assignment takes Owner, User Access Administrator or
// Role Based Access Control Administrator. As Contributor it fails with AuthorizationFailed and
// changes nothing. The base deployment (adminapp.bicep) creates no role assignment, so it never
// waits for this one.
//
// Grants Key Vault Secrets User (read secret values, nothing else) to the admin app's
// system-assigned identity, on each named secret and not on the vault. The admin app can read
// admin-publishing-api-key and nothing else in kv-invi-prod-001; it cannot read jwt-signing-key,
// database-password or any other secret, which a vault-wide assignment (what the APIs have in
// rbac.bicep) would allow. The price is ordering: Azure refuses a role assignment on a scope that
// does not exist, so every secret named here has to exist first. Run it after the secret has
// been created and after the base deployment, which creates the identity. If the identity does not
// exist yet the deployment stops while evaluating the template.
//
// The admin app is `existing`: this file can never create or change it. The Data API already reads
// the same secret through its own vault-wide role (rbac.bicep) and needs nothing here.
//
// Role assignments can take a few minutes to take effect for the vault's data plane, so the
// app has to tolerate a failed first read.

@description('Workload name')
param workloadName string

@description('Deployment environment')
param environment string

@description('Resource instance number')
param instance string

@description('Names of the Key Vault secrets the admin app may read. Every one has to exist')
@minLength(1)
param secretNames string[]

var keyVaultName = 'kv-${workloadName}-${environment}-${instance}'
var adminAppName = 'app-${workloadName}-admin-${environment}-${instance}'

resource adminApp 'Microsoft.Web/sites@2024-11-01' existing = {
  name: adminAppName
}

module secretAccess 'rbac-keyvault-secret-scope.bicep' = [
  for secretName in secretNames: {
    name: 'rbac-${adminAppName}-${secretName}'

    params: {
      keyVaultName: keyVaultName
      secretName: secretName
      principalId: adminApp.identity.principalId
    }
  }
]
