targetScope = 'resourceGroup'

// Deliberately writes only the existing Data API App Settings resource. A full main deployment also writes Auth API,
// networking and monitoring resources, so it is not the activation or rollback path for this switch.
param workloadName string
param environment string
param instance string

param databaseName string
param databaseUser string
param jwtIssuer string
param jwtAudience string

param appleBundleId string
param appleKeyId string
param appleTeamId string
param firebaseAuthEmail string
param firebaseBucket string
param frontendBaseUrl string
param inviteBaseUrl string

param webDraftsEnabled bool = false
param webDraftsRequireCaptcha bool = true
param webDraftsTrustCloudflareConnectingIp bool = false
param dataApiCloudflareOriginLockEnabled bool = false
param webDraftsPlaceSuggestionsPaused bool = true
param placeSuggestionsEnabled bool = false
param dataApiReadinessWarmupEnabled bool = false
@minValue(0)
param dataApiActivityCreatorId int = 0

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

var dataApiName = 'app-${workloadName}-data-api-${environment}-${instance}'
var authApiHostName = 'app-${workloadName}-auth-api-${environment}-${instance}.azurewebsites.net'
var databaseHost = 'mysql-${workloadName}-${environment}-${instance}.mysql.database.azure.com'
var keyVaultName = 'kv-${workloadName}-${environment}-${instance}'
var keyVaultUri = 'https://${keyVaultName}${az.environment().suffixes.keyvaultDns}/'
var effectiveWebDraftsTrustCloudflareConnectingIp = dataApiCloudflareOriginLockEnabled && webDraftsTrustCloudflareConnectingIp

resource dataApi 'Microsoft.Web/sites@2024-11-01' existing = {
  name: dataApiName
}

resource dataAppInsights 'Microsoft.Insights/components@2020-02-02' existing = {
  name: 'appi-${workloadName}-data-api-${environment}-${instance}'
}

// This is the full desired bag: Microsoft.Web/sites/config replaces settings rather than merging just two keys. Keep it
// aligned with modules/appservice.bicep. The safety gate compares every name/value it can observe and fails on drift.
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
    AuthApiUrl: 'https://${authApiHostName}'
    KeyVault__Uri: keyVaultUri

    OpenAI__ApiKey: '@Microsoft.KeyVault(VaultName=${keyVaultName};SecretName=openai-api-key)'
    GoogleMaps__ApiKey: '@Microsoft.KeyVault(VaultName=${keyVaultName};SecretName=googlemaps-api-key)'
    Firebase__AuthPassword: '@Microsoft.KeyVault(VaultName=${keyVaultName};SecretName=firebase-auth-password)'
    Firebase__ApiKey: '@Microsoft.KeyVault(VaultName=${keyVaultName};SecretName=firebase-api-key)'
    APPLE_APNS_PRIVATE_KEY: '@Microsoft.KeyVault(VaultName=${keyVaultName};SecretName=apple-apns-private-key)'
    ResendApiKey: '@Microsoft.KeyVault(VaultName=${keyVaultName};SecretName=resend-api-key)'

    APPLICATIONINSIGHTS_CONNECTION_STRING: dataAppInsights.properties.ConnectionString
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

    RevenueCat__SecretApiKey: revenueCatSecretApiKey
    RevenueCat__WebhookAuthorization: revenueCatWebhookAuthorization
  }, dataApiReadinessWarmupEnabled ? {
    WEBSITE_WARMUP_PATH: '/v1/extras/ready'
    WEBSITE_WARMUP_STATUSES: '200'
  } : {}, dataApiActivityCreatorId > 0 ? { ADMIN_ACTIVITY_CREATOR_ID: string(dataApiActivityCreatorId) } : {})
}
