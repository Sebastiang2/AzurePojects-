targetScope = 'resourceGroup'

param workloadName string

param environment string

param instance string

param location string

param tags object


param privateEndpointSubnetId string



param privateDnsZoneKeyVaultId string



var keyVaultName = 'kv-${workloadName}-${environment}-${instance}'

var keyVaultPrivateEndpointName = 'pe-${workloadName}-${environment}-${instance}-kv'


// Key Vault resource. Here i s where we define the Key Vault resource with its properties,
// including network access controls and RBAC authorization.
resource keyVault 'Microsoft.KeyVault/vaults@2024-11-01' = {
  name: keyVaultName
  location: location
  tags: tags

  properties: {
    tenantId: subscription().tenantId
    sku: {
      family: 'A'
      name: 'standard'
    }
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 90

    publicNetworkAccess: 'Disabled'

    accessPolicies: []

  }
}


// Private Endpoint for Key Vault
resource keyVaultPrivateEndpoint 'Microsoft.Network/privateEndpoints@2024-05-01' = {
  name: keyVaultPrivateEndpointName
  location: location
  tags: tags  


  properties: {
    subnet: {
      id: privateEndpointSubnetId
    }

    privateLinkServiceConnections: [
      {
        name: 'keyvault-connection'
        properties: {
          privateLinkServiceId: keyVault.id

          groupIds: [
            'vault'
          ]

          privateLinkServiceConnectionState: {
            status: 'Approved'
            description: 'Connection for the Key Vault private endpoint'
            actionsRequired: 'None'
          }
        }
      }
    ]
  }



}

resource keyVaultDnsZoneGroup 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2024-05-01' = {
  parent: keyVaultPrivateEndpoint
  name: 'default'

  properties: {
    privateDnsZoneConfigs: [
      {
        name: 'keyvault-dns'

        properties: {
          privateDnsZoneId: privateDnsZoneKeyVaultId
        }
      }
    ]
  }
}

output keyVaultId string = keyVault.id

output keyVaultName string = keyVault.name

output keyVaultUri string = keyVault.properties.vaultUri

output keyVaultPrivateEndpointId string = keyVaultPrivateEndpoint.id
