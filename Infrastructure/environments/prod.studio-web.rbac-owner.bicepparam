using '../modules/studio-web-rbac.bicep'

// Deployment B. Requires Owner, User Access Administrator or RBAC Administrator. Run after A and only after all
// four secrets exist. githubDeployPrincipalId is deployment A's output (applied 2026-11-05); it is an identifier, not a secret.
param workloadName = 'invi'
param environment = 'prod'
param instance = '001'

param secretNames = [
  'studio-api-key'
  'studio-session-secret'
  'studio-google-places-api-key'
  'openai-api-key'
]

param githubDeployPrincipalId = '4246ae18-6536-43a4-a36a-8b0a1cc8eb0d'
