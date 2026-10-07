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

// Environment variables

param appleBundleId string
param appleKeyId string
param appleTeamId string

param firebaseAuthEmail string
param firebaseBucket string

param frontendBaseUrl string
param inviteBaseUrl string

param webDraftsEnabled bool

param jwtIssuer string
param jwtAudience string

param caiCallsPerUserPerDay string
param caiProCallsPerDay string
param caiMonthlyBudgetUsd string

param googleAndroidClientId string
param googleIosClientId string
param googleWebClientId string

@secure()
param revenueCatSecretApiKey string
@secure()
param revenueCatWebhookAuthorization string

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

    jwtIssuer: jwtIssuer
    jwtAudience: jwtAudience

    appleBundleId: appleBundleId
    appleKeyId: appleKeyId
    appleTeamId: appleTeamId

    firebaseAuthEmail: firebaseAuthEmail
    firebaseBucket: firebaseBucket

    frontendBaseUrl: frontendBaseUrl
    inviteBaseUrl: inviteBaseUrl

    webDraftsEnabled: webDraftsEnabled

    caiCallsPerUserPerDay: caiCallsPerUserPerDay
    caiProCallsPerDay: caiProCallsPerDay
    caiMonthlyBudgetUsd: caiMonthlyBudgetUsd

    googleAndroidClientId: googleAndroidClientId
    googleIosClientId: googleIosClientId
    googleWebClientId: googleWebClientId

    revenueCatSecretApiKey: revenueCatSecretApiKey
    revenueCatWebhookAuthorization: revenueCatWebhookAuthorization

    authAppInsightsId: monitoring.outputs.authAppInsightsId
    dataAppInsightsId: monitoring.outputs.dataAppInsightsId

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


// No Static Web App is declared in this template, on purpose. The production web app,
// swa-invi-web-prod-001, and its custom domains are deployed in isolation from
// environments/prod.staticwebapp-web*.bicepparam (modules/staticwebapp.bicep and
// modules/staticwebapp-domain.bicep), so a full deployment of this file never touches a
// Static Web App. swa-invi-app-web-prod-001, which this template used to declare, was
// never used (no content, no custom domains) and was retired from the desired state.
// Removing it here does not delete the Azure resource: an Incremental deployment never
// deletes, so the resource is removed separately, on purpose.
