targetScope = 'resourceGroup'

@description('Static Web App name')
param name string

@description('Azure region for the Static Web App. Set independently of the resource group location because Static Web Apps is only available in a limited set of regions')
param location string

@description('Static Web App SKU name')
@allowed([
  'Free'
  'Standard'
])
param skuName string = 'Free'

@description('Static Web App SKU tier')
@allowed([
  'Free'
  'Standard'
])
param skuTier string = 'Free'

@description('Resource tags')
param tags object


@description('GitHub repository that owns the Static Web App deployment')
param repositoryUrl string

@description('Repository branch deployed to production')
param branch string = 'main'

@description('Repository provider')
param provider string = 'GitHub'

@description('Custom domains to bind to the Static Web App, fully qualified (for example app.example.com). Empty by default, which creates no custom domain')
param customDomains string[] = []

@description('How ownership of each custom domain is validated. dns-txt-token validates with a TXT record while DNS still points elsewhere; cname-delegation needs the CNAME to point at the Static Web App first')
@allowed([
  'cname-delegation'
  'dns-txt-token'
])
param customDomainValidationMethod string = 'dns-txt-token'


// Infrastructure only. repositoryUrl, branch, repositoryToken and buildProperties are intentionally
// not set: the application repository owns its own build and deployment pipeline.
resource staticWebApp 'Microsoft.Web/staticSites@2024-11-01' = {
  name: name
  location: location
  tags: tags

  sku: {
    name: skuName
    tier: skuTier
  }

  properties: {
      allowConfigFileUpdates: true
      stagingEnvironmentPolicy: 'Enabled'

      repositoryUrl: repositoryUrl
      branch: branch
      provider: provider

      buildProperties: {
    // The application repository already owns its GitHub Actions workflow.
      skipGithubActionWorkflowGeneration: true
    }
    }
}

// No resources unless customDomains is set, so existing callers are unaffected.
resource customDomain 'Microsoft.Web/staticSites/customDomains@2024-11-01' = [for domain in customDomains: {
  parent: staticWebApp
  name: domain
  properties: {
    validationMethod: customDomainValidationMethod
  }
}]

output staticWebAppId string = staticWebApp.id
output staticWebAppName string = staticWebApp.name
output staticWebAppDefaultHostname string = staticWebApp.properties.defaultHostname
