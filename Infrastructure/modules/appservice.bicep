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
@description('When true, deny public traffic except Cloudflare published IPv4/IPv6 ranges. Turn on only with the zone-authentication header and an approved caller inventory.')
param dataApiCloudflareOriginLockEnabled bool = false
param webDraftsPlaceSuggestionsPaused bool = true
param placeSuggestionsEnabled bool = false

@description('Enables Data API startup warm-up on /v1/extras/ready with HTTP 200 required. Independent of Health Check.')
param dataApiReadinessWarmupEnabled bool = false

@description('Enables Data API Health Check on /v1/extras/ready. Independent of startup warm-up.')
param dataApiHealthCheckEnabled bool = false

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
// Client-IP restoration is never left on when the origin is open. This is an
// effective value, rather than a validation-only rule, so an incomplete
// rollback parameter change fails safe at the App Setting itself.
var effectiveWebDraftsTrustCloudflareConnectingIp = dataApiCloudflareOriginLockEnabled && webDraftsTrustCloudflareConnectingIp

// Source: https://www.cloudflare.com/ips (read 2026-10-20). These ranges are
// shared by all Cloudflare zones; the WebDrafts application gate separately
// verifies the secret header that our api.cetchapp.com rule overwrites.
var cloudflareOriginAccessRestrictions = [
  { name: 'Allow-Cloudflare-v4-01', priority: 100, action: 'Allow', ipAddress: '173.245.48.0/20' }
  { name: 'Allow-Cloudflare-v4-02', priority: 101, action: 'Allow', ipAddress: '103.21.244.0/22' }
  { name: 'Allow-Cloudflare-v4-03', priority: 102, action: 'Allow', ipAddress: '103.22.200.0/22' }
  { name: 'Allow-Cloudflare-v4-04', priority: 103, action: 'Allow', ipAddress: '103.31.4.0/22' }
  { name: 'Allow-Cloudflare-v4-05', priority: 104, action: 'Allow', ipAddress: '141.101.64.0/18' }
  { name: 'Allow-Cloudflare-v4-06', priority: 105, action: 'Allow', ipAddress: '108.162.192.0/18' }
  { name: 'Allow-Cloudflare-v4-07', priority: 106, action: 'Allow', ipAddress: '190.93.240.0/20' }
  { name: 'Allow-Cloudflare-v4-08', priority: 107, action: 'Allow', ipAddress: '188.114.96.0/20' }
  { name: 'Allow-Cloudflare-v4-09', priority: 108, action: 'Allow', ipAddress: '197.234.240.0/22' }
  { name: 'Allow-Cloudflare-v4-10', priority: 109, action: 'Allow', ipAddress: '198.41.128.0/17' }
  { name: 'Allow-Cloudflare-v4-11', priority: 110, action: 'Allow', ipAddress: '162.158.0.0/15' }
  { name: 'Allow-Cloudflare-v4-12', priority: 111, action: 'Allow', ipAddress: '104.16.0.0/13' }
  { name: 'Allow-Cloudflare-v4-13', priority: 112, action: 'Allow', ipAddress: '104.24.0.0/14' }
  { name: 'Allow-Cloudflare-v4-14', priority: 113, action: 'Allow', ipAddress: '172.64.0.0/13' }
  { name: 'Allow-Cloudflare-v4-15', priority: 114, action: 'Allow', ipAddress: '131.0.72.0/22' }
  { name: 'Allow-Cloudflare-v6-01', priority: 115, action: 'Allow', ipAddress: '2400:cb00::/32' }
  { name: 'Allow-Cloudflare-v6-02', priority: 116, action: 'Allow', ipAddress: '2606:4700::/32' }
  { name: 'Allow-Cloudflare-v6-03', priority: 117, action: 'Allow', ipAddress: '2803:f800::/32' }
  { name: 'Allow-Cloudflare-v6-04', priority: 118, action: 'Allow', ipAddress: '2405:b500::/32' }
  { name: 'Allow-Cloudflare-v6-05', priority: 119, action: 'Allow', ipAddress: '2405:8100::/32' }
  { name: 'Allow-Cloudflare-v6-06', priority: 120, action: 'Allow', ipAddress: '2a06:98c0::/29' }
  { name: 'Allow-Cloudflare-v6-07', priority: 121, action: 'Allow', ipAddress: '2c0f:f248::/32' }
]

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




    siteConfig: union({
      linuxFxVersion: linuxFxVersion
      appCommandLine: 'dotnet CetchAppAPI.dll'

      vnetRouteAllEnabled: true

      alwaysOn: true
      // Independently controlled from startup warm-up. Null clears the Health Check path on rollback.
      healthCheckPath: dataApiHealthCheckEnabled ? '/v1/extras/ready' : null
      http20Enabled: true
      webSocketsEnabled: true

      ftpsState: 'Disabled'


      minTlsVersion: '1.2'

      scmMinTlsVersion: '1.2'
    }, {
      // Declare both states so a later full main deployment preserves the selected
      // perimeter. The safety gate rejects transitions through main; use the
      // separately reviewed PATCH path for activation or rollback.
      ipSecurityRestrictions: dataApiCloudflareOriginLockEnabled ? cloudflareOriginAccessRestrictions : []
      ipSecurityRestrictionsDefaultAction: dataApiCloudflareOriginLockEnabled ? 'Deny' : 'Allow'
      // Publishing access is a separate surface. Do not inherit the main-site lock onto Kudu/SCM.
      scmIpSecurityRestrictions: []
      scmIpSecurityRestrictionsDefaultAction: 'Allow'
      scmIpSecurityRestrictionsUseMain: false
    })
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
    WebDrafts__TrustCloudflareConnectingIp: toLower(string(effectiveWebDraftsTrustCloudflareConnectingIp))
    WebDrafts__PlaceSuggestionsPaused: toLower(string(webDraftsPlaceSuggestionsPaused))
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

    // Startup warm-up waits for HTTP 200 from the database-backed readiness endpoint. This switch does not change
    // Health Check. The full desired app-settings bag removes both settings when the switch is rolled back to false.
  }, dataApiReadinessWarmupEnabled ? {
    WEBSITE_WARMUP_PATH: '/v1/extras/ready'
    WEBSITE_WARMUP_STATUSES: '200'
  } : {}, dataApiActivityCreatorId > 0 ? { ADMIN_ACTIVITY_CREATOR_ID: string(dataApiActivityCreatorId) } : {})
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
