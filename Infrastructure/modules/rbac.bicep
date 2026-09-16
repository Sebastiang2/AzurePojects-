targetScope = 'resourceGroup'

param keyVaultName string

param authApiPrincipalId string

param dataApiPrincipalId string



var keyVaultSecretsUserRoleDefinitionId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  '4633458b-17de-408a-b874-0445c86b69e6'
)



resource keyVault 'Microsoft.KeyVault/vaults@2024-11-01' existing = {
  name: keyVaultName
}


// Auth API -> Key Vault Secrets User
resource authApiKeyVaultSecretsUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(
    keyVault.id,
    authApiPrincipalId,
    keyVaultSecretsUserRoleDefinitionId
  )

  scope: keyVault

  properties: {
    roleDefinitionId: keyVaultSecretsUserRoleDefinitionId
    principalId: authApiPrincipalId
    principalType: 'ServicePrincipal'
  }
}

// Data API -> Key Vault Secrets User
resource dataApiKeyVaultSecretsUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(
    keyVault.id,
    dataApiPrincipalId,
    keyVaultSecretsUserRoleDefinitionId
  )

  scope: keyVault

  properties: {
    roleDefinitionId: keyVaultSecretsUserRoleDefinitionId
    principalId: dataApiPrincipalId
    principalType: 'ServicePrincipal'
  }
}


