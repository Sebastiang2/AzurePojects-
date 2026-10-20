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

@allowed([
  'existing'
  'update'
  'create'
])
@description('What this deployment does with the MySQL server: existing = leave it alone (normal redeploy: the administrator password and every property stay as they are); update = reconcile its other properties without the creation-only login and password; create = create it with login and password. See modules/mysql.bicep.')
param mysqlServerMode string = 'existing'

@secure()
@description('admin password for MySQL server. Only used when mysqlServerMode is create; empty otherwise.')
param mysqlAdminPassword string = ''

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

// Data API settings production already has and the template did not carry, so a deployment of this template no longer
// drops them. The defaults are what production has today (2026-10-14).
param webDraftsRequireCaptcha bool = true
param webDraftsTrustCloudflareConnectingIp bool = false
// Default false preserves the current perimeter. Set only after the Cloudflare
// zone and all direct callers have passed the rollout checks.
param dataApiCloudflareOriginLockEnabled bool = false
// Separate emergency brake for the review queue. Default closed even if a later deployment enables its feature flag.
param webDraftsPlaceSuggestionsPaused bool = true

// "Foreslå et sted" needs BOTH webDraftsEnabled and this one (Data API AND-gate). Off unless set.
param placeSuggestionsEnabled bool = false

@description('Enables Data API readiness warm-up and Health Check on /v1/extras/ready. Keep false until the matching API endpoint has been deployed and reviewed.')
param dataApiReadinessWarmupEnabled bool = false

// UserTable.UserId of the dedicated, verified Invi Activities system user.
// Zero preserves today's configuration; set the real id only after the DB check.
@minValue(0)
param dataApiActivityCreatorId int = 0

@description('Custom domain bound to the Data API (served through Cloudflare). Empty = no binding is managed by this template.')
param dataApiCustomDomain string = ''

@description('Name of the certificate resource (uploaded by hand; the private key is never in Git) used for dataApiCustomDomain.')
param dataApiCertificateName string = ''

@description('Address prefix of the temporary DB-migration subnet (snet-migration-temp). Empty = not declared. Declared only so a deployment does not delete a subnet that still holds the migration VM NIC; clear it when the leftovers are decommissioned.')
param migrationSubnetPrefix string = ''

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

    migrationSubnetPrefix: migrationSubnetPrefix
    migrationNsgId: empty(migrationSubnetPrefix) ? '' : resourceId('Microsoft.Network/networkSecurityGroups', 'nsg-migration-temp')
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

    migrationSubnetPrefix: migrationSubnetPrefix
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

    mysqlServerMode: mysqlServerMode
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
    webDraftsRequireCaptcha: webDraftsRequireCaptcha
    webDraftsTrustCloudflareConnectingIp: webDraftsTrustCloudflareConnectingIp
    dataApiCloudflareOriginLockEnabled: dataApiCloudflareOriginLockEnabled
    webDraftsPlaceSuggestionsPaused: webDraftsPlaceSuggestionsPaused
    placeSuggestionsEnabled: placeSuggestionsEnabled
    dataApiReadinessWarmupEnabled: dataApiReadinessWarmupEnabled
    dataApiActivityCreatorId: dataApiActivityCreatorId
    dataApiCustomDomain: dataApiCustomDomain
    dataApiCertificateName: dataApiCertificateName

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
