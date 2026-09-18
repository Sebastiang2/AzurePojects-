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
  }
}

output staticWebAppId string = staticWebApp.id
output staticWebAppName string = staticWebApp.name
output staticWebAppDefaultHostname string = staticWebApp.properties.defaultHostname
