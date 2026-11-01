targetScope = 'resourceGroup'

type secretMapping = {
  @description('Environment variable populated at startup')
  setting: string

  @description('Key Vault secret name')
  secretName: string
}

// Production Invi Studio web app. Deployment A creates the site and its deploy identity, but no role assignments.
// The existing plan, Log Analytics workspace, VNet and integration subnet are references only. Secret values never
// pass through this template: node launch.mjs loads the names in KEY_VAULT_MAP from the private vault at startup.

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

@description('Linux Node.js runtime')
param linuxFxVersion string = 'NODE|22-lts'

@description('Startup command for the packaged Next.js standalone server')
param appCommandLine string = 'node launch.mjs'

@description('Non-secret App Settings')
param appSettings object

@description('Environment variable and Key Vault secret-name pairs loaded by launch.mjs')
param settingSecretNames secretMapping[]

@description('GitHub repository whose protected environment may deploy this app')
param githubRepository string

@description('GitHub environment named in the federated credential')
param githubEnvironment string = 'production'

var appServicePlanName = 'asp-${workloadName}-${environment}-${instance}'
var keyVaultName = 'kv-${workloadName}-${environment}-${instance}'
var logAnalyticsName = 'log-${workloadName}-${environment}-${instance}'
var vnetName = 'vnet-${workloadName}-${environment}-${instance}'
var appServiceSubnetName = 'snet-appservice-integration'

var studioName = 'app-${workloadName}-studio-${environment}-${instance}'
var studioInsightsName = 'appi-${workloadName}-studio-${environment}-${instance}'
var githubIdentityName = 'id-gha-${workloadName}-studio-${environment}-${instance}'

var keyVaultUri = 'https://${keyVaultName}${az.environment().suffixes.keyvaultDns}/'
var secretLoading = {
  KEY_VAULT_URI: keyVaultUri
  KEY_VAULT_MAP: join(map(settingSecretNames, item => '${item.secretName}:${item.setting}'), ';')
}

var appInsightsLinkTag = 'hidden-link: /app-insights-resource-id'
var studioTags = union(
  tags,
  { '${appInsightsLinkTag}': replace(studioInsights.id, 'Microsoft.Insights', 'microsoft.insights') }
)

var diagnosticLogCategories = [
  'AppServicePlatformLogs'
  'AppServiceHTTPLogs'
  'AppServiceConsoleLogs'
  'AppServiceAuthenticationLogs'
  'AppServiceAuditLogs'
]

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

resource studioInsights 'Microsoft.Insights/components@2020-02-02' = {
  name: studioInsightsName
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

resource studio 'Microsoft.Web/sites@2024-11-01' = {
  name: studioName
  location: location
  tags: studioTags
  kind: 'app,linux'

  identity: {
    type: 'SystemAssigned'
  }

  properties: {
    serverFarmId: appServicePlan.id
    httpsOnly: true
    publicNetworkAccess: 'Enabled'
    clientAffinityEnabled: false
    keyVaultReferenceIdentity: 'SystemAssigned'

    // Route application traffic through the integration subnet so launch.mjs can reach the vault's private endpoint.
    virtualNetworkSubnetId: appServiceSubnet.id
    outboundVnetRouting: {
      applicationTraffic: true
    }

    siteConfig: {
      linuxFxVersion: linuxFxVersion
      appCommandLine: appCommandLine
      vnetRouteAllEnabled: true
      alwaysOn: true
      http20Enabled: true
      webSocketsEnabled: false
      ftpsState: 'Disabled'
      minTlsVersion: '1.2'
      scmMinTlsVersion: '1.2'
      ipSecurityRestrictionsDefaultAction: 'Allow'
      scmIpSecurityRestrictionsDefaultAction: 'Allow'
      scmIpSecurityRestrictionsUseMain: false
    }
  }
}

// This resource owns the complete App Settings bag. Manual settings are removed on the next deployment.
resource studioSettings 'Microsoft.Web/sites/config@2024-11-01' = {
  parent: studio
  name: 'appsettings'

  properties: union(
    appSettings,
    secretLoading,
    {
      SCM_DO_BUILD_DURING_DEPLOYMENT: 'false'
      APPLICATIONINSIGHTS_CONNECTION_STRING: studioInsights.properties.ConnectionString
      ApplicationInsightsAgent_EXTENSION_VERSION: '~3'
    }
  )
}

resource studioFtpPolicy 'Microsoft.Web/sites/basicPublishingCredentialsPolicies@2024-11-01' = {
  parent: studio
  name: 'ftp'
  properties: {
    allow: false
  }
}

resource studioScmPolicy 'Microsoft.Web/sites/basicPublishingCredentialsPolicies@2024-11-01' = {
  parent: studio
  name: 'scm'
  properties: {
    allow: false
  }
}

resource studioDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: 'diag-${studioName}'
  scope: studio
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

resource githubIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2024-11-30' = {
  name: githubIdentityName
  location: location
  tags: tags
}

resource githubCredential 'Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials@2024-11-30' = {
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

output studioId string = studio.id
output studioName string = studio.name
output studioHostname string = studio.properties.defaultHostName
output studioPrincipalId string = studio.identity.principalId
output customDomainVerificationId string = studio.properties.customDomainVerificationId
output githubDeployClientId string = githubIdentity.properties.clientId
output githubDeployPrincipalId string = githubIdentity.properties.principalId
