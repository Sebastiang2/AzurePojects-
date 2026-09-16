targetScope = 'resourceGroup'


param workloadName string

param environment string

param tags object


@description('VNet ID form network.bicep. Therefor privateDNS.bicep must be deployed after network.bicep')
param vnetId string


// Private DNS Zone for MySQL
var mysqlPrivateDnsZoneName = '${workloadName}-${environment}.private.mysql.database.azure.com'

// Private DNS Zone for Key Vault
var keyVaultPrivateDnsZoneName = 'privatelink.vaultcore.azure.net'


// Private DNS Zone for MySQL
resource mysqlPrivateDnsZone 'Microsoft.Network/privateDnsZones@2024-06-01' = {
  name: mysqlPrivateDnsZoneName
  location: 'global'
  tags: tags
}


// Link MySQL DNS zone to the INVI production VNet.
resource mysqlDnsVnetLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = {
  parent: mysqlPrivateDnsZone
  name: 'link-${workloadName}-${environment}-vnet'
  location: 'global'

  properties: {
    registrationEnabled: false

    virtualNetwork: {
      id: vnetId
    }
  }
}



// DNS for key vault 
resource keyVaultPrivateDnsZone 'Microsoft.Network/privateDnsZones@2024-06-01' = {
  name: keyVaultPrivateDnsZoneName
  location: 'global'
  tags: tags
}


// Link Key Vault DNS zone to the INVI production VNet.
resource keyVaultDnsVnetLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = {
  parent: keyVaultPrivateDnsZone
  name: 'link-${workloadName}-${environment}-vnet'
  location: 'global'

  properties: {
    registrationEnabled: false
    resolutionPolicy: 'Default'


    virtualNetwork: {
      id: vnetId
    }
  }
}


// Ouputs 

output PrivateDnsZonemysqlId string = mysqlPrivateDnsZone.id
output privateDnsZoneName string = mysqlPrivateDnsZone.name


output privateDnsZoneKeyVaultId string = keyVaultPrivateDnsZone.id
output privateDnsZoneKeyVaultName string = keyVaultPrivateDnsZone.name
