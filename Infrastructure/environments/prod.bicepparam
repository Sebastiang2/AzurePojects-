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

param mysqlAdminPassword = readEnvironmentVariable('MYSQL_ADMIN_PASSWORD')

param mysqlSkuTier = 'Burstable'

param mysqlSkuName = 'Standard_B2s'

param mysqlVersion = '8.0.21'

param mysqlStorageSizeGB = 32

param mysqlBackupRetentionDays = 14

param mysqlHighAvailabilityMode = 'Disabled'

// App Service configurations
param appServiceSkuName = 'P0v3'
param appServiceSkuTier = 'PremiumV3'

param linuxFxVersion = 'DOTNETCORE|10.0'
// Static Web App configuration (CetchApp app-web)
// eastus2: Static Web Apps is not available in swedencentral
param staticWebAppName = 'swa-invi-app-web-prod-001'
param staticWebAppLocation = 'eastus2'
param staticWebAppSkuName = 'Free'
param staticWebAppSkuTier = 'Free'
param staticWebAppTags = {
  project: 'CetchApp'
  environment: 'prod'
  component: 'app-web'
  'managed-by': 'bicep'
}

param databaseName = 'invi'

// Environment variables

param appleBundleId = 'com.cetchapp.cetchapp'
param appleKeyId = '9Y63M5782Z'
param appleTeamId = 'MVD9YZ986F'

param firebaseAuthEmail = 'backend@cetchapp.com'
param firebaseBucket = 'cetchapp-8b5a6.appspot.com'

param frontendBaseUrl = 'https://app.cetchapp.com'
// app.cetchapp.com serves the invite and share pages. Move to cetchapp.com only
// once both hosts serve the same app and the URL contract has been verified.
param inviteBaseUrl = 'https://app.cetchapp.com'

param webDraftsEnabled = true

// Live values on both APIs (2026-10-02). Neither API validates issuer or
// audience, but new tokens carry them: change only with the JWT work.
param jwtIssuer = 'Jwt:Issuer'
param jwtAudience = 'Jwt:Audience'

param caiCallsPerUserPerDay = '25'
param caiProCallsPerDay = '100'
param caiMonthlyBudgetUsd = '20'

// OAuth client IDs, public: the same values ship in the mobile app.
param googleAndroidClientId = '307733967551-sjtusvqp2a379eo2m0s6b6obag5rdqm6.apps.googleusercontent.com'
param googleIosClientId = '307733967551-k8ilev3c5oan87888r6qgkibjru2h9m3.apps.googleusercontent.com'
param googleWebClientId = '307733967551-e4vdilvvtlrbd5etaqh491gn7blepmo2.apps.googleusercontent.com'

// Secrets kept as literal App Settings in production today. Read from the
// deploying shell, like MYSQL_ADMIN_PASSWORD, so they never land in the repo;
// an unset variable stops the deployment instead of wiping the setting.
param revenueCatSecretApiKey = readEnvironmentVariable('REVENUECAT_SECRET_API_KEY')
param revenueCatWebhookAuthorization = readEnvironmentVariable('REVENUECAT_WEBHOOK_AUTHORIZATION')


param staticWebAppRepositoryUrl = 'https://github.com/CetchApp/cetchapp-app-web'
param staticWebAppBranch = 'main'
