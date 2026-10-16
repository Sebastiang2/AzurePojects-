using '../modules/webapp-domain.bicep'

// Deployment `studio-domain-tls`, pass 2: an App Service managed certificate for studio.invi.lol, and SNI on the binding. Contributor is
// enough. Run it only through the safety gate, after pass 1 (`studio-domain`) has bound the hostname and the CNAME answers at the public DNS:
//
//   bash Infrastructure/scripts/deploy.sh --deployment studio-domain-tls --dry-run
//   bash Infrastructure/scripts/deploy.sh --deployment studio-domain-tls
//
// Issuance is asynchronous and can take several minutes. Check the result with
//   az webapp config ssl list --resource-group rg-invi-prod-swc-001   (the certificate for studio.invi.lol, thumbprint present)
//   curl -sSI https://studio.invi.lol/api/health                       (valid certificate, HTTP 200)
// A managed certificate needs the CNAME to point straight at the default host name (no proxy in front) and renews itself. This is a separate
// file from pass 1 so that running pass 1 again can never switch TLS off.

param workloadName = 'invi'
param environment = 'prod'
param instance = '001'
param location = 'swedencentral'

param appKey = 'studio'
param hostName = 'studio.invi.lol'

param tlsMode = 'managed'
