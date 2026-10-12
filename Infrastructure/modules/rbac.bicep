targetScope = 'resourceGroup'

param keyVaultName string

param authApiPrincipalId string

param dataApiPrincipalId string

@description('Principal ID of Data API staging slot (empty if slot is not enabled)')
param dataApiStagingSlotPrincipalId string = ''



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

// Data API staging slot -> Key Vault Secrets User
// The staging slot has its own managed identity with a separate principal ID, so it needs
// its own role assignment. Only created when the staging slot is enabled.
resource dataApiStagingSlotKeyVaultSecretsUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (dataApiStagingSlotPrincipalId != '') {
  name: guid(
    keyVault.id,
    dataApiStagingSlotPrincipalId,
    keyVaultSecretsUserRoleDefinitionId
  )

  scope: keyVault

  properties: {
    roleDefinitionId: keyVaultSecretsUserRoleDefinitionId
    principalId: dataApiStagingSlotPrincipalId
    principalType: 'ServicePrincipal'
  }
}


