targetScope = 'resourceGroup'

param workloadName string

param environment string

param instance string

param location string

param tags object

param appServiceSkuName string  

param appServiceSkuTier string

param linuxFxVersion string



var appServicePlanName = 'asp-${workloadName}-${environment}-${instance}'

var dataApiName = 'app-${workloadName}-data-api-${environment}-${instance}'

var authApiName= 'app-${workloadName}-auth-api-${environment}-${instance}'

@description('Resoruce ID of the app service vnet intergration subnet')
param appServiceSubnetId string




resource appServicePlan 'Microsoft.Web/serverfarms@2024-11-01' = {
  name: appServicePlanName
  location: location
  tags: tags

  
  kind: 'linux'

  sku: {
    name: appServiceSkuName
    tier: appServiceSkuTier

  }

  properties: {
    reserved: true
    perSiteScaling: false
    zoneRedundant: false
    
  }
}




// resoruce for the DataAPI for backend
resource dataApi 'Microsoft.Web/sites@2024-11-01' = {
  name: dataApiName
  location: location
  tags: tags

  kind: 'app,linux'

  identity: {
    type: 'SystemAssigned'
  }

  properties: {
    serverFarmId: appServicePlan.id

    httpsOnly: true
    publicNetworkAccess: 'Enabled'

    clientAffinityEnabled: false

    
    

    siteConfig: {
      linuxFxVersion: linuxFxVersion

      vnetRouteAllEnabled: false

      alwaysOn: true
      http20Enabled: true

      ftpsState: 'Disabled'


      minTlsVersion: '1.2'

      scmMinTlsVersion: '1.2'

      appSettings: [
        {
          name: 'ASPNETCORE_ENVIRONMENT'
          value: 'Production'
        }
      ]
    }
  }
}

// intergration 
resource dataApiVnetIntegration 'Microsoft.Web/sites/networkConfig@2024-11-01' = {
  parent: dataApi
  name: 'virtualNetwork'

  properties: {
    subnetResourceId: appServiceSubnetId
    swiftSupported: true
  }
}


resource authApi 'Microsoft.Web/sites@2024-11-01' = {
  name: authApiName
  location: location
  tags: tags

  kind: 'app,linux'

  identity: {
    type: 'SystemAssigned'
  }

  properties: {
    serverFarmId: appServicePlan.id

    httpsOnly: true
    publicNetworkAccess: 'Enabled'

    clientAffinityEnabled: false

    siteConfig: {
      linuxFxVersion: linuxFxVersion

      vnetRouteAllEnabled: false

      alwaysOn: true
      http20Enabled: true

      ftpsState: 'Disabled'

      minTlsVersion: '1.2'
      scmMinTlsVersion: '1.2'

      appSettings: [
        {
          name: 'ASPNETCORE_ENVIRONMENT'
          value: 'Production'
        }
      ]
    }
  }
}

// intergration
resource authApiVnetIntegration 'Microsoft.Web/sites/networkConfig@2024-11-01' = {
  parent: authApi
  name: 'virtualNetwork'

  properties: {
    subnetResourceId: appServiceSubnetId
    swiftSupported: true
  }
}

// Polcies?? 
resource authApiFtpPolicy 'Microsoft.Web/sites/basicPublishingCredentialsPolicies@2024-11-01' = {
  parent: authApi
  name: 'ftp'

  properties: {
    allow: false
  }
}

resource authApiScmPolicy 'Microsoft.Web/sites/basicPublishingCredentialsPolicies@2024-11-01' = {
  parent: authApi
  name: 'scm'

  properties: {
    allow: false
  }
}

resource dataApiFtpPolicy 'Microsoft.Web/sites/basicPublishingCredentialsPolicies@2024-11-01' = {
  parent: dataApi
  name: 'ftp'

  properties: {
    allow: false
  }
}

resource dataApiScmPolicy 'Microsoft.Web/sites/basicPublishingCredentialsPolicies@2024-11-01' = {
  parent: dataApi
  name: 'scm'

  properties: {
    allow: false
  }
}

output appServicePlanId string = appServicePlan.id
output appServicePlanName string = appServicePlan.name

output authApiId string = authApi.id
output authApiName string = authApi.name
output authApiHostname string = authApi.properties.defaultHostName

output dataApiId string = dataApi.id
output dataApiName string = dataApi.name
output dataApiHostname string = dataApi.properties.defaultHostName


// prinacible 

output authApiPrincipalId string = authApi.identity.principalId
output dataApiPrincipalId string = dataApi.identity.principalId


