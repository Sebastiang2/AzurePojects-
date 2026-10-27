targetScope = 'resourceGroup'

// Production Invi Studio API (.NET 10, MySQL via Dapper, background jobs in the process). Deployment A of two, and the one
// that Contributor can run: it creates no role assignment. Key Vault access for the app and the GitHub deploy identity's
// right to publish to it are a separate deployment that needs an Owner (studioapi-rbac.bicep).
//
// Self-contained on purpose, like adminapp.bicep: deployed on its own from environments/prod.studioapi.bicepparam and not
// part of main.bicep, so a deployment of it can only touch the resources declared here. App Service plan, Log Analytics
// workspace, integration subnet, MySQL server and the admin app are referenced by name as `existing` and never created or
// changed. The Key Vault is only named (for the Key Vault references), never read.
//
// Not created here, and by whom:
//   - Key Vault secret values, and the roles that let the app read them (studioapi-rbac.bicep)
//   - the Studio tables in the Core DB: the application creates them at startup (StudioTablesStartup)
//   - the application code and its GitHub Actions workflow (the Studio repository)
//
// The appsettings resource replaces every App Setting on the site on each deployment. A setting added by hand in the
// portal or by a pipeline is removed by the next deployment of this file, so anything the app needs belongs in the
// parameter file.

// One App Setting that is a Key Vault reference.
type keyVaultReference = {
  @description('App Setting name, as the app reads it')
  setting: string

  @description('Name of the secret in the Key Vault')
  secretName: string
}

@description('Workload name')
param workloadName string

@description('Deployment environment')
param environment string

@description('Resource instance number')
param instance string

@description('Azure region')
param location string

@description('Common resource tags')
param tags object

@description('Linux runtime stack')
param linuxFxVersion string = 'DOTNETCORE|10.0'

@description('Startup command, dotnet <Assembly>.dll. Empty = not set (App Service looks for the published assembly itself). Set it once the assembly name is known')
param appCommandLine string = ''

@description('Opens the site to the plan\'s own outbound addresses (the admin app on the same plan) and to allowedInboundCidrs. False: every inbound request is refused, which is the state until the code is deployed and tested')
param studioInboundOpen bool = false

@description('Additional CIDRs allowed in when studioInboundOpen is true (studio-web, later). /32 for a single address')
param allowedInboundCidrs string[] = []

@description('App Service Health check on /health (checks the database). Off until the app has run stably: the plan has one instance shared with both APIs, and an instance that stays unhealthy for an hour is replaced')
param studioHealthCheckEnabled bool = false

@description('Database inside mysql-<workload>-<env>-<instance>. The Core DB, the same one the APIs use')
param databaseName string

@description('MySQL login. The administrator today, as for the APIs; StudioTablesStartup needs CREATE and ALTER')
param databaseUser string

@description('App Settings that are Key Vault references: each setting and the secret it points to. Every secret named here has to exist and be listed in prod.studioapi.rbac-owner.bicepparam, or the reference does not resolve and the app gets the literal reference string as value')
param keyVaultReferences keyVaultReference[]

@description('Non-secret App Settings (name -> string value): RESERVATION_*, MAILBOX_*, FACEBOOK_*, models, senders, Cors__AllowedOrigins__n. Empty values are not set, so the app uses its own defaults. An invalid RESERVATION_* value stops the app at startup')
param studioSettings object = {}

@description('Verified UserTable.UserId of the Invi Activities system user (the same id as dataApiActivityCreatorId). Zero leaves ADMIN_ACTIVITY_CREATOR_ID unset')
@minValue(0)
param activityCreatorId int = 0

@description('GitHub repository the deploy workflow runs in, as owner/name (for example CetchApp/invi-studio-api). Empty = no federated credential, so no workflow can sign in yet')
param githubRepository string = ''

@description('GitHub environment the deploy job runs in. The credential trusts only jobs in this environment of githubRepository')
param githubEnvironment string = 'production'

var appServicePlanName = 'asp-${workloadName}-${environment}-${instance}'
var keyVaultName = 'kv-${workloadName}-${environment}-${instance}'
var logAnalyticsName = 'log-${workloadName}-${environment}-${instance}'
var vnetName = 'vnet-${workloadName}-${environment}-${instance}'
var appServiceSubnetName = 'snet-appservice-integration'
var mysqlServerName = 'mysql-${workloadName}-${environment}-${instance}'
var adminAppName = 'app-${workloadName}-admin-${environment}-${instance}'

var studioApiName = 'app-${workloadName}-studio-api-${environment}-${instance}'
var studioApiInsightsName = 'appi-${workloadName}-studio-api-${environment}-${instance}'
var githubIdentityName = 'id-gha-${workloadName}-studio-api-${environment}-${instance}'

// The portal links a site to its Application Insights resource with this tag. Same exact value the other apps carry
// (lower-case provider namespace); see appservice.bicep.
var appInsightsLinkTag = 'hidden-link: /app-insights-resource-id'
var studioApiTags = union(
  tags,
  { '${appInsightsLinkTag}': replace(studioApiInsights.id, 'Microsoft.Insights', 'microsoft.insights') }
)

// Who may call the API once it is open. The admin app runs on the same plan, so its outbound addresses are the plan's;
// that also lets the Data API and Auth API in, which is accepted. The X-Studio-Api-Key / X-Studio-Admin-Key headers stay
// the authentication: these rules only narrow who can try.
var planOutboundAddresses = split(adminApp.properties.possibleOutboundIpAddresses, ',')
var inboundAllowRules = concat(
  map(range(0, length(planOutboundAddresses)), i => {
    name: 'Allow-Plan-Outbound-${padLeft(string(i + 1), 2, '0')}'
    priority: 100 + i
    action: 'Allow'
    ipAddress: '${planOutboundAddresses[i]}/32'
  }),
  map(range(0, length(allowedInboundCidrs)), i => {
    name: 'Allow-Extra-${padLeft(string(i + 1), 2, '0')}'
    priority: 300 + i
    action: 'Allow'
    ipAddress: allowedInboundCidrs[i]
  })
)

// Platform failures, HTTP failures, console output (the app logs to stdout) and Kudu/FTP sign-ins, to the existing
// workspace. Same choice and reasons as the admin app.
var diagnosticLogCategories = [
  'AppServicePlatformLogs'
  'AppServiceHTTPLogs'
  'AppServiceConsoleLogs'
  'AppServiceAuditLogs'
]

// Existing resources. Reference only.
resource appServicePlan 'Microsoft.Web/serverfarms@2024-11-01' existing = {
  name: appServicePlanName
}

resource logAnalytics 'Microsoft.OperationalInsights/workspaces@2025-02-01' existing = {
  name: logAnalyticsName
}

resource vnet 'Microsoft.Network/virtualNetworks@2023-02-01' existing = {
  name: vnetName
}

resource appServiceSubnet 'Microsoft.Network/virtualNetworks/subnets@2023-02-01' existing = {
  parent: vnet
  name: appServiceSubnetName
}

resource mysqlServer 'Microsoft.DBforMySQL/flexibleServers@2024-12-30' existing = {
  name: mysqlServerName
}

resource adminApp 'Microsoft.Web/sites@2024-11-01' existing = {
  name: adminAppName
}

// Dedicated Application Insights resource, workspace-based, same shape as the other apps'.
resource studioApiInsights 'Microsoft.Insights/components@2020-02-02' = {
  name: studioApiInsightsName
  location: location
  tags: tags
  kind: 'web'

  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: logAnalytics.id
    IngestionMode: 'LogAnalytics'

    publicNetworkAccessForIngestion: 'Enabled'
    publicNetworkAccessForQuery: 'Enabled'
  }
}

resource studioApi 'Microsoft.Web/sites@2024-11-01' = {
  name: studioApiName
  location: location
  tags: studioApiTags

  kind: 'app,linux'

  identity: {
    type: 'SystemAssigned'
  }

  properties: {
    serverFarmId: appServicePlan.id

    httpsOnly: true
    publicNetworkAccess: 'Enabled'

    clientAffinityEnabled: false

    // Key Vault references are resolved with the system identity, over the VNet: the vault is private.
    keyVaultReferenceIdentity: 'SystemAssigned'

    // VNet integration and application routing in the same request as the site, not as a separate networkConfig resource.
    // This is what the admin app does, and its Key Vault references resolve; the APIs' do not. Route All is needed for the
    // private Key Vault and the private MySQL server. See adminapp.bicep for why a separate resource lost Route All.
    virtualNetworkSubnetId: appServiceSubnet.id
    outboundVnetRouting: {
      applicationTraffic: true
    }

    siteConfig: {
      linuxFxVersion: linuxFxVersion
      appCommandLine: appCommandLine

      // The older name for outboundVnetRouting.applicationTraffic, kept in step with it.
      vnetRouteAllEnabled: true

      // The background jobs (reservation status and notifications, activity end status, Facebook sync) only run while
      // the process is up.
      alwaysOn: true
      http20Enabled: true
      webSocketsEnabled: false

      ftpsState: 'Disabled'

      minTlsVersion: '1.2'
      scmMinTlsVersion: '1.2'

      // Null clears the path when the switch is turned off again.
      healthCheckPath: studioHealthCheckEnabled ? '/health' : null

      // Closed (no allow rule, default Deny) until studioInboundOpen. The SCM site keeps its own rules, so the GitHub
      // deployment through Entra is not affected.
      ipSecurityRestrictions: studioInboundOpen ? inboundAllowRules : []
      ipSecurityRestrictionsDefaultAction: 'Deny'
      scmIpSecurityRestrictions: []
      scmIpSecurityRestrictionsDefaultAction: 'Allow'
      scmIpSecurityRestrictionsUseMain: false
    }
  }
}

// Application settings. The app reads plain environment variables; secrets are Key Vault references, resolved by App
// Service. Not set on purpose:
//   - ENABLE_SWAGGER: Swagger stays off in Production
//   - PORT / WEBSITES_PORT: a code deployment gets its port from App Service
// No .env file is read in Azure, so everything the app needs is here.
resource studioApiAppSettings 'Microsoft.Web/sites/config@2024-11-01' = {
  parent: studioApi
  name: 'appsettings'

  properties: union(
    {
      ASPNETCORE_ENVIRONMENT: 'Production'
      // The pipeline builds; the platform must not build on the instance it shares with both APIs.
      SCM_DO_BUILD_DURING_DEPLOYMENT: 'false'

      ONBOARDING_DB_HOST: mysqlServer.properties.fullyQualifiedDomainName
      ONBOARDING_DB_PORT: '3306'
      ONBOARDING_DB_DATABASE: databaseName
      ONBOARDING_DB_USER: databaseUser
      ONBOARDING_DB_SSL_MODE: 'Required'

      // Without it every Studio resource answers 503 outside Development.
      STUDIO_RESOURCES_ENABLED: 'true'

      APPLICATIONINSIGHTS_CONNECTION_STRING: studioApiInsights.properties.ConnectionString
      ApplicationInsightsAgent_EXTENSION_VERSION: '~3'
    },
    toObject(
      keyVaultReferences,
      reference => reference.setting,
      reference => '@Microsoft.KeyVault(VaultName=${keyVaultName};SecretName=${reference.secretName})'
    ),
    toObject(filter(items(studioSettings), entry => !empty(entry.value)), entry => entry.key, entry => string(entry.value)),
    activityCreatorId > 0 ? { ADMIN_ACTIVITY_CREATOR_ID: string(activityCreatorId) } : {}
  )
}

resource studioApiFtpPolicy 'Microsoft.Web/sites/basicPublishingCredentialsPolicies@2024-11-01' = {
  parent: studioApi
  name: 'ftp'

  properties: {
    allow: false
  }
}

resource studioApiScmPolicy 'Microsoft.Web/sites/basicPublishingCredentialsPolicies@2024-11-01' = {
  parent: studioApi
  name: 'scm'

  properties: {
    allow: false
  }
}

resource studioApiDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: 'diag-${studioApiName}'
  scope: studioApi

  properties: {
    workspaceId: logAnalytics.id

    logs: [
      for category in diagnosticLogCategories: {
        category: category
        enabled: true
      }
    ]
  }
}

// GitHub deploy identity, the same kind as id-gha-invi-*-prod-001 for the other apps, but declared here instead of by hand.
// It has no role until studioapi-rbac.bicep gives it Website Contributor on this site only.
resource githubIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2024-11-30' = {
  name: githubIdentityName
  location: location
  tags: tags
}

// Only jobs in githubEnvironment of githubRepository can sign in as the identity. Protect that environment in GitHub
// (required reviewers or the main branch only): the credential trusts whatever runs in it.
resource githubCredential 'Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials@2024-11-30' = if (!empty(githubRepository)) {
  parent: githubIdentity
  name: 'github-${githubEnvironment}'

  properties: {
    issuer: 'https://token.actions.githubusercontent.com'
    subject: 'repo:${githubRepository}:environment:${githubEnvironment}'
    audiences: [
      'api://AzureADTokenExchange'
    ]
  }
}

output studioApiId string = studioApi.id
output studioApiName string = studioApi.name
output studioApiHostname string = studioApi.properties.defaultHostName
output studioApiPrincipalId string = studioApi.identity.principalId

// Value for the asuid.<host> TXT record, for a custom domain later.
output customDomainVerificationId string = studioApi.properties.customDomainVerificationId

output studioApiInsightsId string = studioApiInsights.id

// For the workflow (AZURE_CLIENT_ID, not a secret) and for prod.studioapi.rbac-owner.bicepparam (githubDeployPrincipalId).
output githubDeployClientId string = githubIdentity.properties.clientId
output githubDeployPrincipalId string = githubIdentity.properties.principalId
