using '../data-api-warmup.bicep'

// Exact current production values copied from prod.bicepparam. The gate rejects unexpected bag drift at deployment time.
param workloadName = 'invi'
param environment = 'prod'
param instance = '001'
param databaseName = 'invi'
param databaseUser = 'inviadmin'
param jwtIssuer = 'Jwt:Issuer'
param jwtAudience = 'Jwt:Audience'

param appleBundleId = 'com.cetchapp.cetchapp'
param appleKeyId = '9Y63M5782Z'
param appleTeamId = 'MVD9YZ986F'
param firebaseAuthEmail = 'backend@cetchapp.com'
param firebaseBucket = 'cetchapp-8b5a6.appspot.com'
param frontendBaseUrl = 'https://app.cetchapp.com'
param inviteBaseUrl = 'https://app.cetchapp.com/'

param webDraftsEnabled = false
param webDraftsRequireCaptcha = true
param webDraftsTrustCloudflareConnectingIp = false
param dataApiCloudflareOriginLockEnabled = false
// Production currently omits this setting; this fail-closed brake is the only additional non-warm-up setting added.
param webDraftsPlaceSuggestionsPaused = true
param placeSuggestionsEnabled = false
param dataApiReadinessWarmupEnabled = true
param dataApiActivityCreatorId = 1636

param caiCallsPerUserPerDay = '25'
param caiProCallsPerDay = '100'
param caiMonthlyBudgetUsd = '20'
param googleAndroidClientId = '307733967551-sjtusvqp2a379eo2m0s6b6obag5rdqm6.apps.googleusercontent.com'
param googleIosClientId = '307733967551-k8ilev3c5oan87888r6qgkibjru2h9m3.apps.googleusercontent.com'
param googleWebClientId = '307733967551-e4vdilvvtlrbd5etaqh491gn7blepmo2.apps.googleusercontent.com'

// The operator supplies these through the existing secure verification workflow. Never store their values here.
param revenueCatSecretApiKey = readEnvironmentVariable('REVENUECAT_SECRET_API_KEY')
param revenueCatWebhookAuthorization = readEnvironmentVariable('REVENUECAT_WEBHOOK_AUTHORIZATION')
