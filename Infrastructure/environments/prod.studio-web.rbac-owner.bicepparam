using '../modules/studio-web-rbac.bicep'

// Deployment B. Requires Owner, User Access Administrator or RBAC Administrator. Run after A and only after all
// four secrets exist. Copy deployment A's githubDeployPrincipalId output below before the reviewed RBAC deployment.
param workloadName = 'invi'
param environment = 'prod'
param instance = '001'

param secretNames = [
  'studio-api-key'
  'studio-session-secret'
  'studio-google-places-api-key'
  'openai-api-key'
]

param githubDeployPrincipalId = ''
