using '../data-api-origin-lock.bicep'

// Disabled baseline and explicit rollback state. Activation needs a separately
// approved parameter change after direct-caller and Cloudflare checks pass.
param dataApiCloudflareOriginLockEnabled = false
