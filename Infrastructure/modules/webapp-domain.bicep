targetScope = 'resourceGroup'

// Custom domain for an app made with webapp.bicep. Contributor is enough. One hostname per deployment, and no App Service resource, like
// adminapp-domain.bicep and staticwebapp-domain.bicep: kept apart from the app so the base deployment never depends on DNS or TLS, and so a
// hostname that does not validate cannot fail another deployment.
//
// The app is `existing`: deploying a domain can never re-apply (and so reset) the app's own properties, and the deployment fails if the app
// is missing instead of creating one.
//
// DNS records that must exist first (created by hand at the DNS host, not by this file):
//   TXT    asuid.<subdomain>   the customDomainVerificationId output of the app's deployment (the same value for every app in the subscription)
//   CNAME  <subdomain>         the app's default host name (the siteHostname output of the app's deployment)
//
// tlsMode is the stage, and a stage is a separate deployment with its own parameter file, so that running the first one again can never
// switch TLS off. Each mode declares the binding once.
//   none      binds the hostname without TLS. Run this first.
//   managed   creates an App Service managed certificate for the hostname and enables SNI with it. The hostname has to be bound already
//             (run 'none' first). Free, renews itself, and there is no private key to handle. It needs a public DNS record and, for a
//             subdomain, a CNAME mapped directly to the default hostname (no proxy in front). Issuance is asynchronous: deploy with --no-wait
//             and read the binding afterwards.
//   uploaded  enables SNI with a certificate that was uploaded to this resource group by hand, given by thumbprint.

@description('Workload name')
param workloadName string

@description('Deployment environment')
param environment string

@description('Resource instance number')
param instance string

@description('Azure region. Has to match the App Service plan: the managed certificate lives next to it')
param location string

@description('Short name of the app, as in webapp.bicep: app-<workload>-<appKey>-<environment>-<instance>')
@minLength(3)
param appKey string

@description('Custom domain to bind to the app, fully qualified (for example studio.example.com)')
param hostName string

@description('TLS stage. none binds the hostname only, managed issues an App Service managed certificate, uploaded uses a certificate that is already in the resource group')
@allowed([
  'none'
  'managed'
  'uploaded'
])
param tlsMode string = 'none'

@description('Thumbprint of a certificate for hostName that is already uploaded to this resource group. Only used when tlsMode is uploaded')
param certificateThumbprint string = ''

var appServicePlanName = 'asp-${workloadName}-${environment}-${instance}'
var siteName = 'app-${workloadName}-${appKey}-${environment}-${instance}'

resource appServicePlan 'Microsoft.Web/serverfarms@2024-11-01' existing = {
  name: appServicePlanName
}

resource site 'Microsoft.Web/sites@2024-11-01' existing = {
  name: siteName
}

// Only created in managed mode. Needs the hostname bound already, which is why 'none' runs first.
resource managedCertificate 'Microsoft.Web/certificates@2024-11-01' = if (tlsMode == 'managed') {
  name: '${hostName}-${siteName}'
  location: location

  properties: {
    canonicalName: hostName
    serverFarmId: appServicePlan.id
  }
}

resource hostNameBinding 'Microsoft.Web/sites/hostNameBindings@2024-11-01' = {
  parent: site
  name: hostName

  properties: {
    siteName: site.name
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
