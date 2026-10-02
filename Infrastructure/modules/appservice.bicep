targetScope = 'resourceGroup'

param workloadName string

param environment string

param instance string

param location string

param tags object

param appServiceSkuName string

param appServiceSkuTier string

param linuxFxVersion string


param databaseHost string
param databaseName string
param databaseUser string

param jwtIssuer string
param jwtAudience string

param keyVaultName string


// Con

param appleBundleId string
param appleKeyId string
param appleTeamId string

param firebaseAuthEmail string
param firebaseBucket string

param frontendBaseUrl string
param inviteBaseUrl string

param webDraftsEnabled bool

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


param authAppInsightsId string
param dataAppInsightsId string

@secure()
param authAppInsightsConnectionString string

@secure()
param dataAppInsightsConnectionString string



var appServicePlanName = 'asp-${workloadName}-${environment}-${instance}'

var dataApiName = 'app-${workloadName}-data-api-${environment}-${instance}'

var authApiName= 'app-${workloadName}-auth-api-${environment}-${instance}'

// Turns on the APIs' own runtime Key Vault loading (KeyVaultConfiguration.SecretMap
// in each API). The vault is private and App Service does not resolve the
// @Microsoft.KeyVault references itself, so without this the APIs get no secrets.
var keyVaultUri = 'https://${keyVaultName}${az.environment().suffixes.keyvaultDns}/'

// The portal links a site to its Application Insights resource with this tag.
// Kept with the exact value the portal wrote (lower-case provider namespace),
// since `tags` replaces every tag on the site.
var appInsightsLinkTag = 'hidden-link: /app-insights-resource-id'
var dataApiTags = union(tags, { '${appInsightsLinkTag}': replace(dataAppInsightsId, 'Microsoft.Insights', 'microsoft.insights') })
var authApiTags = union(tags, { '${appInsightsLinkTag}': replace(authAppInsightsId, 'Microsoft.Insights', 'microsoft.insights') })

@description('Resoruce ID of the app service vnet intergration subnet')
param appServiceSubnetId string




resource appServicePlan 'Microsoft.Web/serverfarms@2024-11-01' = {
  name: appServicePlanName
  location: location
  tags: tags


  kind: 'linux'

  sku: {
    name: appServiceSkuName
    tier: appServiceSkuTier

  }

  properties: {
    reserved: true
    perSiteScaling: false
    zoneRedundant: false

  }
}




// resoruce for the DataAPI for backend
resource dataApi 'Microsoft.Web/sites@2024-11-01' = {
  name: dataApiName
  location: location
  tags: dataApiTags

  kind: 'app,linux'

  identity: {
    type: 'SystemAssigned'
  }

  properties: {
    serverFarmId: appServicePlan.id

    httpsOnly: true
    publicNetworkAccess: 'Enabled'

    clientAffinityEnabled: false




    siteConfig: {
      linuxFxVersion: linuxFxVersion
      appCommandLine: 'dotnet CetchAppAPI.dll'

      vnetRouteAllEnabled: true

      alwaysOn: true
      http20Enabled: true
      webSocketsEnabled: true

      ftpsState: 'Disabled'


      minTlsVersion: '1.2'

      scmMinTlsVersion: '1.2'


    }
  }
}

// app service secrets
resource dataApiAppSettings 'Microsoft.Web/sites/config@2024-11-01' = {
  parent: dataApi
  name: 'appsettings'

  properties: {
   ASPNETCORE_ENVIRONMENT: 'Production'
    Urls: 'http://*:8080'

    Database__Host: databaseHost
    Database__Name: databaseName
    Database__Port: '3306'
    Database__User: databaseUser
    Database__SslMode: 'Required'


    Database__Password: '@Microsoft.KeyVault(VaultName=${keyVaultName};SecretName=database-password)'

    Jwt__Issuer: jwtIssuer
    Jwt__Audience: jwtAudience
    Jwt__SigningKey: '@Microsoft.KeyVault(VaultName=${keyVaultName};SecretName=jwt-signing-key)'

    AuthApiUrl: 'https://${authApi.properties.defaultHostName}'

    KeyVault__Uri: keyVaultUri

    // Existing secret references
    OpenAI__ApiKey: '@Microsoft.KeyVault(VaultName=${keyVaultName};SecretName=openai-api-key)'
    GoogleMaps__ApiKey: '@Microsoft.KeyVault(VaultName=${keyVaultName};SecretName=googlemaps-api-key)'
    Firebase__AuthPassword: '@Microsoft.KeyVault(VaultName=${keyVaultName};SecretName=firebase-auth-password)'
    Firebase__ApiKey: '@Microsoft.KeyVault(VaultName=${keyVaultName};SecretName=firebase-api-key)'
    APPLE_APNS_PRIVATE_KEY: '@Microsoft.KeyVault(VaultName=${keyVaultName};SecretName=apple-apns-private-key)'
    ResendApiKey: '@Microsoft.KeyVault(VaultName=${keyVaultName};SecretName=resend-api-key)'
    // Discord__Webhooks__0/1 are not set in production. Before adding them back,
    // add discord-webhook-0/1 to KeyVaultConfiguration.SecretMap in the Data API:
    // with KeyVault__Uri set, an unresolved reference stops the API at startup.


    APPLICATIONINSIGHTS_CONNECTION_STRING: dataAppInsightsConnectionString
    ApplicationInsightsAgent_EXTENSION_VERSION: '~3'
    XDT_MicrosoftApplicationInsights_Mode: 'recommended'
    XDT_MicrosoftApplicationInsights_PreemptSdk: '1'

    APPLE_BUNDLE_ID: appleBundleId
    APPLE_KEY_ID: appleKeyId
    APPLE_TEAM_ID: appleTeamId

    Firebase__AuthEmail: firebaseAuthEmail
    Firebase__Bucket: firebaseBucket

    FrontendBaseUrl: frontendBaseUrl
    InviteBaseUrl: inviteBaseUrl

    WebDrafts__Enabled: string(webDraftsEnabled)

    Cai__CallsPerUserPerDay: caiCallsPerUserPerDay
    Cai__ProCallsPerDay: caiProCallsPerDay
    Cai__MonthlyBudgetUsd: caiMonthlyBudgetUsd

    Google__AndroidClientId: googleAndroidClientId
    Google__IosClientId: googleIosClientId
    Google__WebClientId: googleWebClientId

    // Literal App Settings in production today, not Key Vault references.
    RevenueCat__SecretApiKey: revenueCatSecretApiKey
    RevenueCat__WebhookAuthorization: revenueCatWebhookAuthorization
  }
}

// intergration
resource dataApiVnetIntegration 'Microsoft.Web/sites/networkConfig@2024-11-01' = {
  parent: dataApi
  name: 'virtualNetwork'

  properties: {
    subnetResourceId: appServiceSubnetId
    swiftSupported: true
  }
}


resource authApi 'Microsoft.Web/sites@2024-11-01' = {
  name: authApiName
  location: location
  tags: authApiTags

  kind: 'app,linux'

  identity: {
    type: 'SystemAssigned'
  }

  properties: {
    serverFarmId: appServicePlan.id

    httpsOnly: true
    publicNetworkAccess: 'Enabled'

    clientAffinityEnabled: false

    siteConfig: {
      linuxFxVersion: linuxFxVersion
      appCommandLine: 'dotnet CetchAuthAPI.dll'

      vnetRouteAllEnabled: true

      alwaysOn: true
      http20Enabled: true
      webSocketsEnabled: true

      ftpsState: 'Disabled'

      minTlsVersion: '1.2'
      scmMinTlsVersion: '1.2'


    }
  }
}


// auth-api secrets
resource authApiAppSettings 'Microsoft.Web/sites/config@2024-11-01' = {
  parent: authApi
  name: 'appsettings'

  properties: {
    ASPNETCORE_ENVIRONMENT: 'Production'
    Urls: 'http://*:8080'

    Database__Host: databaseHost
    Database__Name: databaseName
    Database__Port: '3306'
    Database__User: databaseUser
    Database__SslMode: 'Required'

    Database__Password: '@Microsoft.KeyVault(VaultName=${keyVaultName};SecretName=database-password)'

    Jwt__Issuer: jwtIssuer
    Jwt__Audience: jwtAudience
    Jwt__SigningKey: '@Microsoft.KeyVault(VaultName=${keyVaultName};SecretName=jwt-signing-key)'

    KeyVault__Uri: keyVaultUri

    APPLICATIONINSIGHTS_CONNECTION_STRING: authAppInsightsConnectionString
    ApplicationInsightsAgent_EXTENSION_VERSION: '~3'
    XDT_MicrosoftApplicationInsights_Mode: 'recommended'
    XDT_MicrosoftApplicationInsights_PreemptSdk: '1'
}
}

// intergration
resource authApiVnetIntegration 'Microsoft.Web/sites/networkConfig@2024-11-01' = {
  parent: authApi
  name: 'virtualNetwork'

  properties: {
    subnetResourceId: appServiceSubnetId
    swiftSupported: true
  }
}

// Polcies??
resource authApiFtpPolicy 'Microsoft.Web/sites/basicPublishingCredentialsPolicies@2024-11-01' = {
  parent: authApi
  name: 'ftp'

  properties: {
    allow: false
  }
}

resource authApiScmPolicy 'Microsoft.Web/sites/basicPublishingCredentialsPolicies@2024-11-01' = {
  parent: authApi
  name: 'scm'

  properties: {
    allow: false
  }
}

resource dataApiFtpPolicy 'Microsoft.Web/sites/basicPublishingCredentialsPolicies@2024-11-01' = {
  parent: dataApi
  name: 'ftp'

  properties: {
    allow: false
  }
}

resource dataApiScmPolicy 'Microsoft.Web/sites/basicPublishingCredentialsPolicies@2024-11-01' = {
  parent: dataApi
  name: 'scm'

  properties: {
    allow: false
  }
}

output appServicePlanId string = appServicePlan.id
output appServicePlanName string = appServicePlan.name

output authApiId string = authApi.id
output authApiName string = authApi.name
output authApiHostname string = authApi.properties.defaultHostName

output dataApiId string = dataApi.id
output dataApiName string = dataApi.name
output dataApiHostname string = dataApi.properties.defaultHostName


// prinacible

output authApiPrincipalId string = authApi.identity.principalId
output dataApiPrincipalId string = dataApi.identity.principalId
