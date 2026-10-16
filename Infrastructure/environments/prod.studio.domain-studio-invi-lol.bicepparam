using '../modules/webapp-domain.bicep'

// Deployment `studio-domain`, pass 1: bind studio.invi.lol to the production Studio app app-invi-studio-prod-001, without TLS. Contributor is
// enough. Run it only through the safety gate:
//
//   bash Infrastructure/scripts/deploy.sh --deployment studio-domain --dry-run
//   bash Infrastructure/scripts/deploy.sh --deployment studio-domain
//
// Touches only the hostNameBindings child resource studio.invi.lol. Not the app, which is `existing`, and not any other domain. Do not run
// it before the app exists and before both DNS records exist at Namecheap (invi.lol's DNS host, changed by hand; keep the MX and SPF records
// of the e-mail forwarding):
//   TXT    asuid.studio   the customDomainVerificationId output of the `studio` deployment (read it from the site; it is not a secret)
//   CNAME  studio         app-invi-studio-prod-001.azurewebsites.net.
// Pass 2, TLS, is its own deployment and file: prod.studio.domain-studio-invi-lol-tls.bicepparam (`studio-domain-tls`).

param workloadName = 'invi'
param environment = 'prod'
param instance = '001'
param location = 'swedencentral'

param appKey = 'studio'
param hostName = 'studio.invi.lol'

param tlsMode = 'none'
