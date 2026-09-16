using '../main.bicep'

param environment = 'prod'
param workloadName = 'invi'
param instance = '001'
param location = 'swedencentral'

param tags = {
  environment: 'prod'
  application: 'invi'
  managedBy: 'bicep'
}



// network configuration
param vnetAddressPrefix = '10.20.0.0/16'
param appServiceSubnetPrefix = '10.20.1.0/24'
param mysqlSubnetPrefix = '10.20.2.0/24'
param privateEndpointSubnetPrefix = '10.20.3.0/24'

// database configuration
param mysqlAdminUsername = 'inviadmin'

param mysqlAdminPassword = 'Cetchapp123'

param mysqlSkuTier = 'Burstable'

param mysqlSkuName = 'Standard_B1ms'

param mysqlVersion = '8.0.21'

param mysqlStorageSizeGB = 32

param mysqlBackupRetentionDays = 14

param mysqlHighAvailabilityMode = 'Disabled'

// App Service configurations
param appServiceSkuName = 'P0v3'
param appServiceSkuTier = 'PremiumV3'

param linuxFxVersion = 'DOTNETCORE|10.0'
