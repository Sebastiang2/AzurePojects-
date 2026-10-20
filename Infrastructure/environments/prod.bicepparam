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

// The production MySQL server already exists and is NOT written by this deployment: 'existing' leaves the server alone, so
// its administrator password (which both APIs use, as 'inviadmin') and every property stay as they are. The password is not
// read from the environment here on purpose.
//
// To CREATE a server (new environment or recovery) change, in one reviewed PR together with
// Infrastructure/safety/manifest.json (deployments.main.mysqlServer.mode and secureEnvironment):
//   param mysqlServerMode = 'create'
//   param mysqlAdminPassword = readEnvironmentVariable('MYSQL_ADMIN_PASSWORD')
// To change other properties of the existing server ('update': the PUT omits login and password) set 'update' and approve it
// in the manifest. The gate stops 'create' on a server that exists. Never put a value for the password in this file.
param mysqlServerMode = 'existing'

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

param databaseName = 'invi'

// Environment variables

param appleBundleId = 'com.cetchapp.cetchapp'
param appleKeyId = '9Y63M5782Z'
param appleTeamId = 'MVD9YZ986F'

param firebaseAuthEmail = 'backend@cetchapp.com'
param firebaseBucket = 'cetchapp-8b5a6.appspot.com'

param frontendBaseUrl = 'https://app.cetchapp.com'
// app.cetchapp.com serves the invite and share pages permanently: the mobile app and
// the backend's verify/reset mails build links on it. cetchapp.com is the company site.
// Production has the trailing slash (set by hand); the code trims it (InviteLinkBuilder, WebDraftTickets). Kept as is so the
// template and production agree.
param inviteBaseUrl = 'https://app.cetchapp.com/'

// Off in production (2026-10-02) until Turnstile and the other WebDrafts__*
// settings are configured; the website's create flow is off as well.
param webDraftsEnabled = false

// Captcha required. Keep CF client-IP trust off until Cloudflare peer/origin-lock verification is approved.
param webDraftsRequireCaptcha = true
param webDraftsTrustCloudflareConnectingIp = false
// Do not enable until Cloudflare-only access and zone verification are proven.
param dataApiCloudflareOriginLockEnabled = false
// Explicit rollback brake; leave on until moderation launch is separately approved.
param webDraftsPlaceSuggestionsPaused = true

// "Foreslå et sted" needs this AND webDraftsEnabled. Off.
param placeSuggestionsEnabled = false

// UserId of the 'Invi Activities' system user (Provider='System') created by the approved Core DB migration.
// Zero would leave ADMIN_ACTIVITY_CREATOR_ID unset. Changing it restarts only the Data API on the next main deploy.
param dataApiActivityCreatorId = 1636

// api.cetchapp.com is bound to the Data API with the Cloudflare Origin CA certificate that was uploaded by hand.
param dataApiCustomDomain = 'api.cetchapp.com'
param dataApiCertificateName = 'api-cetchapp-com-cloudflare-origin'

// TEMPORARY: the subnet and NSG rule of the DB migration (vm-db-migration-temp, deallocated). They are declared only so a
// deployment does not delete a subnet that still holds the VM NIC. Clear this value in the PR that decommissions the leftovers.
param migrationSubnetPrefix = '10.20.4.0/24'

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
// deploying shell, so they never land in the repo;
// an unset variable stops the deployment instead of wiping the setting.
param revenueCatSecretApiKey = readEnvironmentVariable('REVENUECAT_SECRET_API_KEY')
param revenueCatWebhookAuthorization = readEnvironmentVariable('REVENUECAT_WEBHOOK_AUTHORIZATION')
