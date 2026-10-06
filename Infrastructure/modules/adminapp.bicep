targetScope = 'resourceGroup'

// Production admin web app (Next.js server on Node). Deployment A of three, and the one that
// Contributor can run: it creates no role assignment. Key Vault access is a separate deployment
// that needs an Owner (adminapp-rbac.bicep), and the custom domain is another
// (adminapp-domain.bicep).
//
// Self-contained on purpose, like staticwebapp.bicep: it is deployed on its own from
// environments/prod.adminapp.bicepparam and is not part of main.bicep, so a deployment of it can
// only touch the resources declared here. App Service plan, Log Analytics workspace and
// integration subnet are referenced by name as `existing` and never created or changed, which is
// also why there is no plan SKU parameter. The Key Vault is only named (for KEY_VAULT_URI), never read.
//
// Not created here, and by whom:
//   - the Entra app registration and enterprise application ("Assignment required")
//   - Key Vault secret values, and the role that lets the app read them (adminapp-rbac.bicep)
//   - DNS, certificates and the custom domain (adminapp-domain.bicep)
//   - the application code
//
// The appsettings resource replaces every App Setting on the site on each deployment.
// A setting added by hand in the portal or by a pipeline is removed by the next deployment of
// this file, so anything the app needs belongs in the list below.

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
param linuxFxVersion string = 'NODE|22-lts'

@description('Startup command. node server.js is the standalone server, which needs output: standalone in the app build (not set today). For a full build use npm run start. Until the first code deployment there is nothing to start, so App Service logs failed start attempts; the site is closed and Health check is off, so nothing user-facing and nothing is replaced')
param appCommandLine string = 'node server.js'

@description('Public URL of the admin site. NEXT_PUBLIC_* values are also embedded at build time, so the build pipeline has to use the same URL')
param adminPublicUrl string

@description('Base URL of the production Data API')
param dataApiBaseUrl string

@description('Application (client) ID of the Entra app registration used by App Service Authentication (Easy Auth). Not a secret. Empty until the registration exists')
param entraClientId string = ''

@description('Tenant that owns the app registration. The registration must be single-tenant')
param entraTenantId string = subscription().tenantId

@secure()
@description('Client secret of the Entra app registration. Never in Git or in a parameter file: read it from the deploying shell with readEnvironmentVariable, like the MySQL and RevenueCat secrets. Easy Auth reads it from an App Setting, so anyone who can read this site\'s App Settings can read it. It expires, and sign-in stops when it does. Empty until the registration exists')
param entraClientSecret string = ''

@description('Keep the Easy Auth token store. Off: the app reads identity from the injected headers and needs no provider tokens, so none are stored or forwarded. Turn on only if sign-in testing shows the claims are missing without it')
param entraTokenStoreEnabled bool = false

var appServicePlanName = 'asp-${workloadName}-${environment}-${instance}'
var keyVaultName = 'kv-${workloadName}-${environment}-${instance}'
var logAnalyticsName = 'log-${workloadName}-${environment}-${instance}'
var vnetName = 'vnet-${workloadName}-${environment}-${instance}'
var appServiceSubnetName = 'snet-appservice-integration'

var adminAppName = 'app-${workloadName}-admin-${environment}-${instance}'
var adminAppInsightsName = 'appi-${workloadName}-admin-${environment}-${instance}'

// Same form as the APIs' KeyVault__Uri. The app reads its secrets from the vault itself, with
// its managed identity, as the APIs do: App Service Key Vault references do not resolve against
// kv-invi-prod-001 (2026-10-06: every reference on both APIs reports "Reference was not able to
// be resolved"), so none are used here.
var keyVaultUri = 'https://${keyVaultName}${az.environment().suffixes.keyvaultDns}/'

// Easy Auth needs both halves. With only a client ID there is no secret and App Service falls back
// to the implicit flow, so the pair is all or nothing, and without it the site stays closed.
var easyAuthEnabled = !empty(entraClientId) && !empty(entraClientSecret)

// The portal links a site to its Application Insights resource with this tag. Same
// exact value the APIs carry (lower-case provider namespace); see appservice.bicep.
var appInsightsLinkTag = 'hidden-link: /app-insights-resource-id'
var adminAppTags = union(
  tags,
  { '${appInsightsLinkTag}': replace(adminAppInsights.id, 'Microsoft.Insights', 'microsoft.insights') }
)

// Platform failures (container and deployment events), HTTP failures, console output (application
// errors), Kudu and FTP sign-ins, and Easy Auth events. They go to the existing workspace, which has
// a daily cap. Left out on purpose: AppServiceAppLogs (Java only on Linux, so empty for Node),
// IPSecAuditLogs (only noise from scanners while the site is closed), FileAudit and Antivirus logs, and
// metrics (already in Azure Monitor). This is operations telemetry, not the admin audit trail:
// that has to come from the application and the Data API.
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

// Dedicated Application Insights resource, workspace-based, same shape as the APIs'.
resource adminAppInsights 'Microsoft.Insights/components@2020-02-02' = {
  name: adminAppInsightsName
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

resource adminApp 'Microsoft.Web/sites@2024-11-01' = {
  name: adminAppName
  location: location
  tags: adminAppTags

  kind: 'app,linux'

  identity: {
    type: 'SystemAssigned'
  }

  properties: {
    serverFarmId: appServicePlan.id

    httpsOnly: true
    publicNetworkAccess: 'Enabled'

    clientAffinityEnabled: false

    // VNet integration and application routing are set here, in the same request as the site,
    // and not as a separate networkConfig resource as the APIs have it. Route All only takes
    // effect on an app that is already integrated, and a separate resource is created after the
    // site: the first deployment (2026-10-06) submitted it too early, Azure dropped it, and the
    // admin app ended up integrated but not routing (vnetRouteAllEnabled false) while the APIs,
    // deployed more than once, have it. Both are needed for the private Key Vault, which a Linux
    // app only reaches with Route All on. applicationTraffic is what the APIs carry; allTraffic is
    // deliberately not used, because it also sends managed identity token requests through the VNet.
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
      // Unlike the APIs, nothing here uses WebSockets (checked in the app's source).
      webSocketsEnabled: false

      ftpsState: 'Disabled'

      minTlsVersion: '1.2'
      scmMinTlsVersion: '1.2'

      // Closed until Easy Auth is configured. With no Entra app registration yet,
      // nothing may reach the site, so code deployed early cannot be reached. That
      // matters most for code that reads the X-MS-CLIENT-PRINCIPAL headers: App Service
      // only guarantees those come from the platform while Easy Auth is on. The SCM site
      // keeps its own rules, so deployments through Entra are not affected.
      ipSecurityRestrictionsDefaultAction: easyAuthEnabled ? 'Allow' : 'Deny'
      scmIpSecurityRestrictionsDefaultAction: 'Allow'
      scmIpSecurityRestrictionsUseMain: false

      // healthCheckPath is deliberately not set. The plan has a single instance shared
      // with the APIs. An instance that stays unhealthy for an hour is replaced, and apps
      // without Health check (both APIs) are not counted when that is decided, so an admin
      // app with no code yet, or one that is crashing, could get the instance replaced
      // under the APIs. The app's /api/health stays available for monitoring that does not
      // use App Service Health check.
    }
  }
}

// Application settings. Non-secret values are literal; the one secret is the Easy Auth client secret,
// from a secure parameter. Not set on purpose:
//   - ADMIN_TOKEN, ENTRA_* and ADMIN_SESSION_SECRET: the shared password and the app's own login are
//     replaced by Easy Auth
//   - DATA_API_ADMIN_KEY_PROD: the app reads admin-publishing-api-key from KEY_VAULT_URI at runtime
//   - DATA_API_BASE_URL and DATA_API_ADMIN_KEY without _PROD: the app treats those as the TEST environment
//   - the legacy onboarding and Studio URLs: publishing mode does not use them
//   - SCM_DO_BUILD_DURING_DEPLOYMENT: not set, so a zip deployment runs no build on the shared instance
// HOSTNAME makes the standalone server listen on all interfaces.
resource adminAppSettings 'Microsoft.Web/sites/config@2024-11-01' = {
  parent: adminApp
  name: 'appsettings'

  properties: union(
    {
      NODE_ENV: 'production'
      APP_ENV: 'production'
      HOSTNAME: '0.0.0.0'

      NEXT_PUBLIC_APP_URL: adminPublicUrl

      DATA_API_BASE_URL_PROD: dataApiBaseUrl

      KEY_VAULT_URI: keyVaultUri

      APPLICATIONINSIGHTS_CONNECTION_STRING: adminAppInsights.properties.ConnectionString
      ApplicationInsightsAgent_EXTENSION_VERSION: '~3'
    },
    easyAuthEnabled
      ? {
          MICROSOFT_PROVIDER_AUTHENTICATION_SECRET: entraClientSecret
          WEBSITE_AUTH_AAD_ALLOWED_TENANTS: entraTenantId
        }
      : {}
  )
}

resource adminAppFtpPolicy 'Microsoft.Web/sites/basicPublishingCredentialsPolicies@2024-11-01' = {
  parent: adminApp
  name: 'ftp'

  properties: {
    allow: false
  }
}

resource adminAppScmPolicy 'Microsoft.Web/sites/basicPublishingCredentialsPolicies@2024-11-01' = {
  parent: adminApp
  name: 'scm'

  properties: {
    allow: false
  }
}

// App Service Authentication (Easy Auth) with Microsoft Entra ID. Only created once the client ID
// and secret are both set, so the base deployment does not depend on the app registration.
// The registration itself (single tenant, redirect URI https://<admin host>/.auth/login/aad/callback,
// ID tokens enabled for the hybrid flow, app role Invi.Admin, "Assignment required" on the enterprise
// application) is created by hand in Entra. Every path requires sign-in: there are no excluded
// paths. Users who are not assigned to the enterprise application are rejected by Entra, not by this,
// and the Invi.Admin role is checked by the application.
resource adminAppAuth 'Microsoft.Web/sites/config@2024-11-01' = if (easyAuthEnabled) {
  parent: adminApp
  name: 'authsettingsV2'

  properties: {
    platform: {
      enabled: true
      runtimeVersion: '~1'
    }

    globalValidation: {
      requireAuthentication: true
      unauthenticatedClientAction: 'RedirectToLoginPage'
      redirectToProvider: 'azureactivedirectory'
    }

    identityProviders: {
      azureActiveDirectory: {
        enabled: true

        registration: {
          openIdIssuer: uri(az.environment().authentication.loginEndpoint, '${entraTenantId}/v2.0')
          clientId: entraClientId
          clientSecretSettingName: 'MICROSOFT_PROVIDER_AUTHENTICATION_SECRET'
        }
      }
    }

    login: {
      tokenStore: {
        enabled: entraTokenStoreEnabled
      }
    }

    httpSettings: {
      requireHttps: true

      routes: {
        apiPrefix: '/.auth'
      }
    }
  }

  dependsOn: [
    adminAppSettings
  ]
}

resource adminAppDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: 'diag-${adminAppName}'
  scope: adminApp

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

output adminAppId string = adminApp.id
output adminAppName string = adminApp.name
output adminAppHostname string = adminApp.properties.defaultHostName
output adminAppPrincipalId string = adminApp.identity.principalId

// Value for the asuid.<host> TXT record that proves domain ownership (adminapp-domain.bicep).
output customDomainVerificationId string = adminApp.properties.customDomainVerificationId

output adminAppInsightsId string = adminAppInsights.id
output easyAuthConfigured bool = easyAuthEnabled
