targetScope = 'resourceGroup'

// A production web app on the shared App Service plan, for an app that is built and deployed on its own: invi-studio (Next.js on Node) and
// the onboarding API (ASP.NET). Contributor is enough: this deployment creates no role assignment. Key Vault access and the permission to
// deploy are granted by a separate deployment that needs an Owner (studio-platform-rbac.bicep), and the custom domain is another
// (webapp-domain.bicep).
//
// Modelled on adminapp.bicep (same site hardening, same VNet routing, same diagnostics) and self-contained in the same way: it is deployed
// from its own parameter file, so a deployment can only touch the resources declared here and never main.bicep's APIs. The App Service
// plan, the Log Analytics workspace and the integration subnet are referenced by name as `existing`. The Key Vault is only named.
//
// Not created here, and by whom:
//   - Key Vault secrets (a person, with access to the private vault) and the role that lets the app read them (studio-platform-rbac.bicep).
//     The app reads them itself at start-up (see KEY_VAULT_URI and KEY_VAULT_MAP below)
//   - DNS, certificates and the custom domain (webapp-domain.bicep; DNS is changed by hand)
//   - the application code (the app's own GitHub workflow, through the identity created below)
//
// The appsettings resource replaces every App Setting on the site on each deployment. A setting added by hand in the portal or by a
// pipeline is removed by the next deployment of the same parameter file, so everything the app needs belongs in its parameter file.

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

@description('Short name of the app. It is part of every resource name: app-<workload>-<appKey>-<environment>-<instance>')
@minLength(3)
param appKey string

@description('Linux runtime stack, for example NODE|24-lts or DOTNETCORE|10.0')
param linuxFxVersion string

@description('Startup command, for example node server.js or dotnet invi-studio-api.dll')
param appCommandLine string

@description('App Settings that are not secret. Literal values only: a secret never goes here (see settingSecretNames), and neither does a name from settingSecretNames')
param appSettings object

@description('Secrets the app reads from Key Vault at start-up, as environment variable name -> Key Vault secret name. They are not App Settings: the app loads them itself with its managed identity (KEY_VAULT_URI and KEY_VAULT_MAP), because App Service Key Vault references do not resolve against this vault. The identity needs a role on each named secret (studio-platform-rbac.bicep)')
param settingSecretNames object = {}

@description('The user (UserTable.UserId) that owns the activities this app creates, as the app setting ADMIN_ACTIVITY_CREATOR_ID (the onboarding API; Studio does not use it). 0 = not set: a locked-down API then REFUSES to create activities (503); there is no fallback to a guessed user. Set it only to an id that has been checked in the production database (docs/studio-rollout-checklist.md, step 8), and set the same user on the Data API (dataApiActivityCreatorId in main.bicep): one system user per database owns both.')
@minValue(0)
param activityCreatorId int = 0

@description('Value of SCM_DO_BUILD_DURING_DEPLOYMENT. The pipeline builds, the platform must not build on the shared instance')
param scmDoBuildDuringDeployment string = 'false'

@description('GitHub repository (owner/name) whose "production" environment may deploy this app. Creates a user-assigned identity with a federated credential for it (OIDC, no secret). The permission to deploy is a separate role assignment (studio-platform-rbac.bicep). Empty = no identity')
param githubRepository string = ''

@description('GitHub environment named in the federated credential. A workflow job that does not run in this environment cannot get a token')
param githubEnvironment string = 'production'

var appServicePlanName = 'asp-${workloadName}-${environment}-${instance}'
var keyVaultName = 'kv-${workloadName}-${environment}-${instance}'
var logAnalyticsName = 'log-${workloadName}-${environment}-${instance}'
var vnetName = 'vnet-${workloadName}-${environment}-${instance}'
var appServiceSubnetName = 'snet-appservice-integration'

var siteName = 'app-${workloadName}-${appKey}-${environment}-${instance}'
var appInsightsName = 'appi-${workloadName}-${appKey}-${environment}-${instance}'
var deployIdentityName = 'id-gha-${workloadName}-${appKey}-${environment}-${instance}'
var createDeployIdentity = !empty(githubRepository)

// Secrets. The apps on this plan read them from the vault themselves, in the container, through the private endpoint: App Service Key Vault
// references do not resolve against this vault (every reference on the Data API and the Auth API reports "Reference was not able to be
// resolved"; the platform's diagnostics say "VnetProxy warmup request timed out"), so none are used. The app is told where the vault is and which
// secret goes into which environment variable, as vault secret : variable pairs. Neither is secret and no secret value passes through this
// template. The two names are chosen so that the safety gate does not take them for secrets (it flags a literal under a name with
// "secret" in it). The pairs are sorted by variable name, so the value is stable.
var keyVaultUri = 'https://${keyVaultName}${az.environment().suffixes.keyvaultDns}/'
var secretLoading = empty(settingSecretNames)
  ? {}
  : {
      KEY_VAULT_URI: keyVaultUri
      KEY_VAULT_MAP: join(map(items(settingSecretNames), item => '${item.value}:${item.key}'), ';')
    }

// The portal links a site to its Application Insights resource with this tag. Same exact value the other sites carry (lower-case provider
// namespace); see appservice.bicep.
var appInsightsLinkTag = 'hidden-link: /app-insights-resource-id'
var siteTags = union(
  tags,
  { '${appInsightsLinkTag}': replace(appInsights.id, 'Microsoft.Insights', 'microsoft.insights') }
)

// Platform failures (container and deployment events), HTTP requests, console output (application errors), Kudu and FTP sign-ins and
// authentication events. They go to the existing workspace, which has a daily cap. Left out on purpose: AppServiceAppLogs (Java only on
// Linux), IPSecAuditLogs, file audit and antivirus logs, and metrics (already in Azure Monitor).
var diagnosticLogCategories = [
  'AppServicePlatformLogs'
  'AppServiceHTTPLogs'
  'AppServiceConsoleLogs'
  'AppServiceAuthenticationLogs'
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

// Dedicated Application Insights resource, workspace-based, same shape as the other apps'.
resource appInsights 'Microsoft.Insights/components@2020-02-02' = {
  name: appInsightsName
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

resource site 'Microsoft.Web/sites@2024-11-01' = {
  name: siteName
  location: location
  tags: siteTags

  kind: 'app,linux'

  identity: {
    type: 'SystemAssigned'
  }

  properties: {
    serverFarmId: appServicePlan.id

    httpsOnly: true
    publicNetworkAccess: 'Enabled'

    clientAffinityEnabled: false

    // VNet integration and application routing are set here, in the same request as the site, and not as a separate networkConfig
    // resource as the two APIs have it: Route All only takes effect on an app that is already integrated, and a separate resource is created
    // after the site (see adminapp.bicep, where Azure dropped the flag on 2026-10-06). The private MySQL server and the private Key Vault
    // are reachable only through the VNet. applicationTraffic is what the other apps carry; allTraffic is deliberately not used, because it
    // also sends managed identity token requests through the VNet.
    virtualNetworkSubnetId: appServiceSubnet.id
    outboundVnetRouting: {
      applicationTraffic: true
    }

    siteConfig: {
      linuxFxVersion: linuxFxVersion
      appCommandLine: appCommandLine

      // The older name for outboundVnetRouting.applicationTraffic, kept in step with it.
      vnetRouteAllEnabled: true

      alwaysOn: true
      http20Enabled: true
      webSocketsEnabled: false

      ftpsState: 'Disabled'

      minTlsVersion: '1.2'
      scmMinTlsVersion: '1.2'

      // Reachable from the internet by design (a browser app, and an API that is called by its server and refuses every other caller in
      // code). The SCM site keeps its own rules, so deployments through Entra are not affected.
      ipSecurityRestrictionsDefaultAction: 'Allow'
      scmIpSecurityRestrictionsDefaultAction: 'Allow'
      scmIpSecurityRestrictionsUseMain: false

      // healthCheckPath is deliberately not set. The plan has a single instance shared with the other apps. An instance that stays
      // unhealthy for an hour is replaced, and apps without Health check are not counted when that is decided, so an app that is
      // crashing, or has no code yet, could get the instance replaced under the APIs. Each app has a health route for monitoring that
      // does not use App Service Health check.
    }
  }
}

// Application settings: the literal settings of the parameter file, where to find the secrets, and what the platform needs.
resource siteSettings 'Microsoft.Web/sites/config@2024-11-01' = {
  parent: site
  name: 'appsettings'

  properties: union(
    appSettings,
    secretLoading,
    activityCreatorId > 0 ? { ADMIN_ACTIVITY_CREATOR_ID: string(activityCreatorId) } : {},
    {
      APPLICATIONINSIGHTS_CONNECTION_STRING: appInsights.properties.ConnectionString
      ApplicationInsightsAgent_EXTENSION_VERSION: '~3'
    },
    empty(scmDoBuildDuringDeployment) ? {} : { SCM_DO_BUILD_DURING_DEPLOYMENT: scmDoBuildDuringDeployment }
  )
}

resource siteFtpPolicy 'Microsoft.Web/sites/basicPublishingCredentialsPolicies@2024-11-01' = {
  parent: site
  name: 'ftp'

  properties: {
    allow: false
  }
}

resource siteScmPolicy 'Microsoft.Web/sites/basicPublishingCredentialsPolicies@2024-11-01' = {
  parent: site
  name: 'scm'

  properties: {
    allow: false
  }
}

resource siteDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: 'diag-${siteName}'
  scope: site

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

// The identity the app's GitHub workflow signs in with (OIDC; there is no secret). It can do nothing until it is given a role on this app
// (studio-platform-rbac.bicep), and the credential accepts only a job that runs in the named GitHub environment of the named repository.
resource deployIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2024-11-30' = if (createDeployIdentity) {
  name: deployIdentityName
  location: location
  tags: tags
}

resource deployCredential 'Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials@2024-11-30' = if (createDeployIdentity) {
  parent: deployIdentity
  name: 'github-${githubEnvironment}'

  properties: {
    issuer: 'https://token.actions.githubusercontent.com'
    subject: 'repo:${githubRepository}:environment:${githubEnvironment}'
    audiences: [
      'api://AzureADTokenExchange'
    ]
  }
}

output siteId string = site.id
output siteName string = site.name
output siteHostname string = site.properties.defaultHostName
output sitePrincipalId string = site.identity.principalId

// Value for the asuid.<host> TXT record that proves domain ownership (webapp-domain.bicep). The same for every app in the subscription.
output customDomainVerificationId string = site.properties.customDomainVerificationId

output appInsightsId string = appInsights.id

// The application (client) ID of the deploy identity: the GitHub repository variable AZURE_CLIENT_ID. Not a secret.
output deployIdentityClientId string = createDeployIdentity ? deployIdentity!.properties.clientId : ''
output deployIdentityPrincipalId string = createDeployIdentity ? deployIdentity!.properties.principalId : ''
