targetScope = 'resourceGroup'

param workloadName string
param environment string
param instance string
param location string
param tags object

param mysqlSubnetId string
param privateDnsZoneMysqlId string

param mysqlAdminUsername string

@secure()
param mysqlAdminPassword string

param mysqlSkuName string
param mysqlSkuTier string
param mysqlVersion string
param storageSizeGB int
param backupRetentionDays int
param highAvailabilityMode string

var mysqlServerName = 'mysql-${workloadName}-${environment}-${instance}'

resource mysqlServer 'Microsoft.DBforMySQL/flexibleServers@2024-12-30' = {
  name: mysqlServerName
  location: location
  tags: tags

  sku: {
    name: mysqlSkuName
    tier: mysqlSkuTier
  }

  properties: {
    administratorLogin: mysqlAdminUsername
    administratorLoginPassword: mysqlAdminPassword

    version: mysqlVersion

    network: {
      delegatedSubnetResourceId: mysqlSubnetId
      privateDnsZoneResourceId: privateDnsZoneMysqlId
      publicNetworkAccess: 'Disabled'
    }

    backup: {
      backupRetentionDays: backupRetentionDays
      geoRedundantBackup: 'Disabled'
    }

    highAvailability: {
      mode: highAvailabilityMode
    }

    storage: {
      storageSizeGB: storageSizeGB
      autoGrow: 'Enabled'
      autoIoScaling: 'Disabled'
    }
  }
}


output mysqlServerId string = mysqlServer.id
output mysqlServerName string = mysqlServer.name
output mysqlFqdn string = mysqlServer.properties.fullyQualifiedDomainName
