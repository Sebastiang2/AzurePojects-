targetScope = 'resourceGroup'

// Custom domain for the admin app. Deployment C of three; Contributor is enough. One hostname per
// deployment, and no App Service resource, like staticwebapp-domain.bicep. Kept apart from
// adminapp.bicep so the base deployment never depends on DNS or TLS, and so a hostname that does
// not validate cannot fail another deployment.
//
// The admin app is `existing`: deploying a domain can never re-apply (and so reset) the app's own
// properties, and the deployment fails if the app is missing instead of creating one. The app itself
// is deployed from modules/adminapp.bicep.
//
// DNS records that must exist first (created by hand in Cloudflare, not by this file):
//   TXT    asuid.<subdomain>   the customDomainVerificationId output of the adminapp deployment
//   CNAME  <subdomain>         the adminAppHostname output of the adminapp deployment
// With only the TXT record App Service still accepts the binding, as a domain migration.
//
// tlsMode is the stage. Run 'none' first, then 'managed' or 'uploaded' as a second deployment. Each
// mode declares the binding once, so running a mode again does not switch TLS off.
//   none      binds the hostname without TLS.
//   managed   creates an App Service managed certificate for the hostname and enables SNI with it. The
//             hostname has to be bound already (run 'none' first). Free, renews itself, and there is no
//             private key to handle, so this is the simplest setup. It needs a public DNS record and,
//             for a subdomain, a CNAME mapped directly to the default hostname: with Cloudflare's proxy
//             on, public DNS answers with Cloudflare addresses and not that CNAME, so the record has to
//             be DNS only (grey cloud). Easy Auth and the closed state do not get in the way: since
//             November 2025 App Service answers the validation request at its front end, before the app.
//             Issuance is asynchronous, so deploy it with --no-wait.
//   uploaded  enables SNI with a certificate you uploaded to this resource group by hand, given by
//             thumbprint. This is the route for a proxied hostname: a Cloudflare Origin certificate for
//             exactly this hostname (the one on api.cetchapp.com covers only api.cetchapp.com), with
//             Cloudflare's SSL mode at Full (strict). The PFX and its password never go in this file.

@description('Workload name')
param workloadName string

@description('Deployment environment')
param environment string

@description('Resource instance number')
param instance string

@description('Azure region. Has to match the App Service plan: the managed certificate lives next to it')
param location string

@description('Custom domain to bind to the admin app, fully qualified (for example admin.example.com)')
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
var adminAppName = 'app-${workloadName}-admin-${environment}-${instance}'

resource appServicePlan 'Microsoft.Web/serverfarms@2024-11-01' existing = {
  name: appServicePlanName
}

resource adminApp 'Microsoft.Web/sites@2024-11-01' existing = {
  name: adminAppName
}

// Only created in managed mode. Needs the hostname bound already, which is why 'none' runs first.
resource managedCertificate 'Microsoft.Web/certificates@2024-11-01' = if (tlsMode == 'managed') {
  name: '${hostName}-${adminAppName}'
  location: location

  properties: {
    canonicalName: hostName
    serverFarmId: appServicePlan.id
  }
}

resource hostNameBinding 'Microsoft.Web/sites/hostNameBindings@2024-11-01' = {
  parent: adminApp
  name: hostName

  properties: {
    siteName: adminApp.name
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
