targetScope = 'resourceGroup'

@description('Deployment environment')
@allowed([
  'dev'
  'prod'
])
param environment string


@description('Workload name')
param workloadName string

@description('Resource instance number')
param instance string

@description('Azure region')
param location string

@description('Common resource tags')
param tags object


//network parameters
@description('VNet address space')
param vnetAddressPrefix string

@description('App Service integration subnet prefix')
param appServiceSubnetPrefix string

@description('MySQL delegated subnet prefix')
param mysqlSubnetPrefix string

@description('Private Endpoint subnet prefix')
param privateEndpointSubnetPrefix string


// Database parameters
@description('admin username for MySQL server')
param mysqlAdminUsername string

@secure()
@description('admin password for MySQL server')
param mysqlAdminPassword string

@description('Database sku tier for MySQL server')
param mysqlSkuTier string

@description('Database sku name for MySQL server')
param mysqlSkuName string


@description('Database version for MySQL server')
param mysqlVersion string

@description('Database storage size in GB for MySQL server')
param mysqlStorageSizeGB int

@description('Database backup retention days for MySQL server')
param mysqlBackupRetentionDays int

@description('Database high availability mode for MySQL server')

param mysqlHighAvailabilityMode string

@description('Database name inside the database server ')
param databaseName string



// App Service parameters

@description('App Service Plan SKU')
param appServiceSkuName string

@description('App Service Plan tier')
param appServiceSkuTier string

@description('Linux runtime stack')
param linuxFxVersion string

// Static Web App parameters

@description('Static Web App name')
param staticWebAppName string

@description('Static Web App region. Separate from location because Static Web Apps is not available in every region')
param staticWebAppLocation string

@description('Static Web App SKU name')
param staticWebAppSkuName string

@description('Static Web App SKU tier')
param staticWebAppSkuTier string

@description('Static Web App resource tags')
param staticWebAppTags object

@description('Static Web App repository URL')
param staticWebAppRepositoryUrl string

@description('Static Web App repository branch')
param staticWebAppBranch string


// Environment variables

param appleBundleId string
param appleKeyId string
param appleTeamId string

param firebaseAuthEmail string
param firebaseBucket string

param frontendBaseUrl string
param inviteBaseUrl string

param webDraftsEnabled bool

// Network module
module network 'modules/network.bicep' = {
  name: 'network-${environment}'

  params: {
    workloadName: workloadName
    environment: environment
    instance: instance
    location: location
    tags: tags

    vnetAddressPrefix: vnetAddressPrefix
    appServiceSubnetPrefix: appServiceSubnetPrefix
    mysqlSubnetPrefix: mysqlSubnetPrefix
    privateEndpointSubnetPrefix: privateEndpointSubnetPrefix

    appNsgId: nsg.outputs.appNsgId
    mysqlNsgId: nsg.outputs.mysqlNsgId
    privateEndpointNsgId: nsg.outputs.privateEndpointNsgId

  }
}



// The deployment deoendecies: NSG module must be deployed before network module, and network module must be deployed before privatedns module, and privatedns module must be deployed before mysql module.


// NSG module
module nsg 'modules/nsg.bicep' = {
  name: 'nsg-${environment}'

  params: {
    workloadName: workloadName
    environment: environment
    instance: instance
    location: location
    tags: tags

    appServiceSubnetPrefix: appServiceSubnetPrefix
    mysqlSubnetPrefix: mysqlSubnetPrefix
    privateEndpointSubnetPrefix: privateEndpointSubnetPrefix

  }
}

// DNS module
module privatedns 'modules/privatedns.bicep' = {
  name: 'privatedns-${environment}'

  params: {
    workloadName: workloadName
    environment: environment
    tags: tags

    vnetId: network.outputs.vnetId
  }
}

// MySQL module
module mysql 'modules/mysql.bicep' = {
  name: 'mysql-${environment}'

  params: {
    workloadName: workloadName
    environment: environment
    instance: instance
    location: location
    tags: tags

    mysqlSubnetId: network.outputs.mysqlSubnetId


    privateDnsZoneMysqlId: privatedns.outputs.PrivateDnsZonemysqlId


    mysqlAdminUsername: mysqlAdminUsername

    mysqlAdminPassword: mysqlAdminPassword

    mysqlSkuName: mysqlSkuName
    mysqlSkuTier: mysqlSkuTier
    mysqlVersion: mysqlVersion
    storageSizeGB: mysqlStorageSizeGB
    backupRetentionDays: mysqlBackupRetentionDays
    highAvailabilityMode: mysqlHighAvailabilityMode

    databaseName: databaseName
  }
}

// key vault module

module keyvault 'modules/keyvault.bicep' = {
  name: 'keyvault-${environment}'

  params: {
    workloadName: workloadName
    environment: environment
    instance: instance
    location: location
    tags: tags

    privateEndpointSubnetId: network.outputs.privateEndpointSubnetId
    privateDnsZoneKeyVaultId: privatedns.outputs.privateDnsZoneKeyVaultId
  }
}


module monitoring 'modules/monitoring.bicep' = {
  name: 'monitoring-prod'
  params: {
    location: location
    workloadName: workloadName
    environment: environment
    instance: instance
    tags: tags
  }
}



module appService 'modules/appservice.bicep' = {
  name: 'appservice-${environment}'

  params: {
    workloadName: workloadName
    environment: environment
    instance: instance
    location: location
    tags: tags

    appServiceSkuName: appServiceSkuName
    appServiceSkuTier: appServiceSkuTier
    linuxFxVersion: linuxFxVersion

    keyVaultName: keyvault.outputs.keyVaultName

    appServiceSubnetId: network.outputs.appserviceSubnetId

    databaseHost: mysql.outputs.mysqlServerFqdn
    databaseName: mysql.outputs.databaseName
    databaseUser: mysqlAdminUsername

    jwtIssuer: 'CetchAppBackend'
    jwtAudience: 'CetchAppFrontend'

    appleBundleId: appleBundleId
    appleKeyId: appleKeyId
    appleTeamId: appleTeamId

    firebaseAuthEmail: firebaseAuthEmail
    firebaseBucket: firebaseBucket

    frontendBaseUrl: frontendBaseUrl
    inviteBaseUrl: inviteBaseUrl

    webDraftsEnabled: webDraftsEnabled
    authAppInsightsConnectionString: monitoring.outputs.authAppInsightsConnectionString
    dataAppInsightsConnectionString: monitoring.outputs.dataAppInsightsConnectionString
  }
}


// rbac

module rbac 'modules/rbac.bicep' = {
  name: 'rbac-${environment}'

  params: {
    keyVaultName: keyvault.outputs.keyVaultName

    authApiPrincipalId: appService.outputs.authApiPrincipalId
    dataApiPrincipalId: appService.outputs.dataApiPrincipalId
  }
}


// Static Web App module. Provisions the resource only; the app repository deploys the content.
module staticWebApp 'modules/staticwebapp.bicep' = {
  name: 'staticwebapp-${environment}'

  params: {
    name: staticWebAppName
    location: staticWebAppLocation
    skuName: staticWebAppSkuName
    skuTier: staticWebAppSkuTier
    tags: staticWebAppTags
    repositoryUrl: staticWebAppRepositoryUrl
    branch: staticWebAppBranch
  }
}
