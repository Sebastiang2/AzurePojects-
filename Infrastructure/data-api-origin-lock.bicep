targetScope = 'resourceGroup'

@description('Keep false until Cloudflare header delivery, direct callers and warm-up behavior are verified and a separate production change is approved.')
param dataApiCloudflareOriginLockEnabled bool = false

resource dataApi 'Microsoft.Web/sites@2024-11-01' existing = {
  name: 'app-invi-data-api-prod-001'
}

// Keep this list identical to appservice.bicep and the safety manifest. The gate
// compares the whole named list with live access restrictions before any write.
var cloudflareOriginAccessRestrictions = [
  { name: 'Allow-Cloudflare-v4-01', priority: 100, action: 'Allow', ipAddress: '173.245.48.0/20' }
  { name: 'Allow-Cloudflare-v4-02', priority: 101, action: 'Allow', ipAddress: '103.21.244.0/22' }
  { name: 'Allow-Cloudflare-v4-03', priority: 102, action: 'Allow', ipAddress: '103.22.200.0/22' }
  { name: 'Allow-Cloudflare-v4-04', priority: 103, action: 'Allow', ipAddress: '103.31.4.0/22' }
  { name: 'Allow-Cloudflare-v4-05', priority: 104, action: 'Allow', ipAddress: '141.101.64.0/18' }
  { name: 'Allow-Cloudflare-v4-06', priority: 105, action: 'Allow', ipAddress: '108.162.192.0/18' }
  { name: 'Allow-Cloudflare-v4-07', priority: 106, action: 'Allow', ipAddress: '190.93.240.0/20' }
  { name: 'Allow-Cloudflare-v4-08', priority: 107, action: 'Allow', ipAddress: '188.114.96.0/20' }
  { name: 'Allow-Cloudflare-v4-09', priority: 108, action: 'Allow', ipAddress: '197.234.240.0/22' }
  { name: 'Allow-Cloudflare-v4-10', priority: 109, action: 'Allow', ipAddress: '198.41.128.0/17' }
  { name: 'Allow-Cloudflare-v4-11', priority: 110, action: 'Allow', ipAddress: '162.158.0.0/15' }
  { name: 'Allow-Cloudflare-v4-12', priority: 111, action: 'Allow', ipAddress: '104.16.0.0/13' }
  { name: 'Allow-Cloudflare-v4-13', priority: 112, action: 'Allow', ipAddress: '104.24.0.0/14' }
  { name: 'Allow-Cloudflare-v4-14', priority: 113, action: 'Allow', ipAddress: '172.64.0.0/13' }
  { name: 'Allow-Cloudflare-v4-15', priority: 114, action: 'Allow', ipAddress: '131.0.72.0/22' }
  { name: 'Allow-Cloudflare-v6-01', priority: 115, action: 'Allow', ipAddress: '2400:cb00::/32' }
  { name: 'Allow-Cloudflare-v6-02', priority: 116, action: 'Allow', ipAddress: '2606:4700::/32' }
  { name: 'Allow-Cloudflare-v6-03', priority: 117, action: 'Allow', ipAddress: '2803:f800::/32' }
  { name: 'Allow-Cloudflare-v6-04', priority: 118, action: 'Allow', ipAddress: '2405:b500::/32' }
  { name: 'Allow-Cloudflare-v6-05', priority: 119, action: 'Allow', ipAddress: '2405:8100::/32' }
  { name: 'Allow-Cloudflare-v6-06', priority: 120, action: 'Allow', ipAddress: '2a06:98c0::/29' }
  { name: 'Allow-Cloudflare-v6-07', priority: 121, action: 'Allow', ipAddress: '2c0f:f248::/32' }
]

// This child resource writes only the main-site perimeter. SCM, App Settings,
// warm-up and the parent site are deliberately absent from this deployment.
resource originAccess 'Microsoft.Web/sites/config@2024-11-01' = {
  parent: dataApi
  name: 'web'
  properties: {
    ipSecurityRestrictions: dataApiCloudflareOriginLockEnabled ? cloudflareOriginAccessRestrictions : []
    ipSecurityRestrictionsDefaultAction: dataApiCloudflareOriginLockEnabled ? 'Deny' : 'Allow'
  }
}
