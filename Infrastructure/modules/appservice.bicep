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
param webDraftsRequireCaptcha bool = true
param webDraftsTrustCloudflareConnectingIp bool = false
param placeSuggestionsEnabled bool = false

@description('Verified UserTable.UserId for editorial activities in the Data API. Zero leaves ADMIN_ACTIVITY_CREATOR_ID unset.')
@minValue(0)
param dataApiActivityCreatorId int = 0

@description('Custom domain bound to the Data API. Empty = no binding is managed here.')
param dataApiCustomDomain string = ''

@description('Name of the uploaded certificate resource for dataApiCustomDomain (it already exists; the private key is not in Git).')
param dataApiCertificateName string = ''

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

var logAnalyticsId = resourceId('Microsoft.OperationalInsights/workspaces', 'log-${workloadName}-${environment}-${instance}')

var dataApiDiagnosticCategories = [
  'AppServiceHTTPLogs'
  'AppServiceAppLogs'
  'AppServiceFileAuditLogs'
  'AppServiceAuthenticationLogs'
]
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

  properties: union({
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
    // Lower case, as production has them. They were set by hand before; carried here because this resource replaces the
    // whole settings bag and would otherwise drop them.
    WebDrafts__RequireCaptcha: toLower(string(webDraftsRequireCaptcha))
    WebDrafts__TrustCloudflareConnectingIp: toLower(string(webDraftsTrustCloudflareConnectingIp))
    PlaceSuggestions__Enabled: toLower(string(placeSuggestionsEnabled))

    Cai__CallsPerUserPerDay: caiCallsPerUserPerDay
    Cai__ProCallsPerDay: caiProCallsPerDay
    Cai__MonthlyBudgetUsd: caiMonthlyBudgetUsd

    Google__AndroidClientId: googleAndroidClientId
    Google__IosClientId: googleIosClientId
    Google__WebClientId: googleWebClientId

    // Literal App Settings in production today, not Key Vault references.
    RevenueCat__SecretApiKey: revenueCatSecretApiKey
    RevenueCat__WebhookAuthorization: revenueCatWebhookAuthorization
  }, dataApiActivityCreatorId > 0 ? { ADMIN_ACTIVITY_CREATOR_ID: string(dataApiActivityCreatorId) } : {})
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

// api.cetchapp.com is proxied by Cloudflare and presents the Cloudflare Origin CA certificate that was uploaded by hand. The
// binding and the certificate reference are declared so the template describes what production has; the certificate itself
// (private key) is never in Git.
resource dataApiCertificate 'Microsoft.Web/certificates@2024-11-01' existing = if (!empty(dataApiCertificateName)) {
  name: dataApiCertificateName
}

resource dataApiCustomHostName 'Microsoft.Web/sites/hostNameBindings@2024-11-01' = if (!empty(dataApiCustomDomain)) {
  parent: dataApi
  name: dataApiCustomDomain
  properties: {
    siteName: dataApi.name
    hostNameType: 'Verified'
    sslState: 'SniEnabled'
    thumbprint: dataApiCertificate!.properties.thumbprint
  }
}

// Exactly the diagnostic setting production has today (named inviMetrics, created by hand). Categories are not changed in
// this declaration; widening them (for example AppServiceIPSecAuditLogs for the origin lock) is a separate, reviewed change.
resource dataApiDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: 'inviMetrics'
  scope: dataApi
  properties: {
    workspaceId: logAnalyticsId
    logs: [
      for category in dataApiDiagnosticCategories: {
        category: category
        enabled: true
      }
    ]
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
