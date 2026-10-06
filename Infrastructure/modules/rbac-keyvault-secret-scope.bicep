targetScope = 'resourceGroup'

@description('Name of the existing Key Vault')
param keyVaultName string

@description('Name of the existing secret the identity may read. The secret has to exist: Azure refuses a role assignment on a scope that does not')
param secretName string

@description('Object ID of the managed identity that gets read access to the secret')
param principalId string

// Key Vault Secrets User on one secret instead of the whole vault, which rbac.bicep does for
// the APIs. Same role and the same assignment-name shape (principalId in the guid, so a
// recreated identity gets a new assignment instead of colliding with the orphaned one).
var keyVaultSecretsUserRoleDefinitionId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  '4633458b-17de-408a-b874-0445c86b69e6'
)

resource keyVault 'Microsoft.KeyVault/vaults@2024-11-01' existing = {
  name: keyVaultName
}

resource secret 'Microsoft.KeyVault/vaults/secrets@2024-11-01' existing = {
  parent: keyVault
  name: secretName
}

resource keyVaultSecretsUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(secret.id, principalId, keyVaultSecretsUserRoleDefinitionId)

  scope: secret

  properties: {
    roleDefinitionId: keyVaultSecretsUserRoleDefinitionId
    principalId: principalId
    principalType: 'ServicePrincipal'
  }
}
