targetScope = 'resourceGroup'

// Custom domain for the Studio web app. The app is existing. Bind the hostname with tlsMode=none first, then run a
// separate deployment with tlsMode=managed after DNS validates. This file never reapplies the Studio site settings.

@description('Workload name')
param workloadName string

@description('Deployment environment')
param environment string

@description('Resource instance number')
param instance string

@description('Azure region')
param location string

@description('Custom hostname')
param hostName string

@description('TLS stage')
@allowed([
  'none'
  'managed'
  'uploaded'
])
param tlsMode string = 'none'

@description('Thumbprint of a previously uploaded certificate, only for tlsMode=uploaded')
param certificateThumbprint string = ''

var appServicePlanName = 'asp-${workloadName}-${environment}-${instance}'
var studioName = 'app-${workloadName}-studio-${environment}-${instance}'

resource appServicePlan 'Microsoft.Web/serverfarms@2024-11-01' existing = {
  name: appServicePlanName
}

resource studio 'Microsoft.Web/sites@2024-11-01' existing = {
  name: studioName
}

resource managedCertificate 'Microsoft.Web/certificates@2024-11-01' = if (tlsMode == 'managed') {
  name: '${hostName}-${studioName}'
  location: location
  properties: {
    canonicalName: hostName
    serverFarmId: appServicePlan.id
  }
}

resource hostNameBinding 'Microsoft.Web/sites/hostNameBindings@2024-11-01' = {
  parent: studio
  name: hostName
  properties: {
    siteName: studio.name
    hostNameType: 'Verified'
    customHostNameDnsRecordType: 'CName'
    sslState: tlsMode == 'none' ? 'Disabled' : 'SniEnabled'
    thumbprint: tlsMode == 'managed'
      ? managedCertificate!.properties.thumbprint
      : (tlsMode == 'uploaded' ? certificateThumbprint : null)
  }
}

output hostName string = hostNameBinding.name
output tlsMode string = tlsMode
