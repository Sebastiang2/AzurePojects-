targetScope = 'resourceGroup'

// Role assignments for the Studio API. Deployment B of two, and the only one that needs more than Contributor: creating a
// role assignment takes Owner, User Access Administrator or Role Based Access Control Administrator. As Contributor it
// fails with AuthorizationFailed and changes nothing. The base deployment (studioapi.bicep) creates no role assignment.
//
//   1. Key Vault Secrets User (read secret values, nothing else) for the Studio API's system identity, on each named secret
//      and not on the vault: Studio can read its own secrets and database-password, and not jwt-signing-key or any other
//      secret, which a vault-wide assignment (what the APIs have in rbac.bicep) would allow. Azure refuses a role assignment
//      on a scope that does not exist, so every secret named here has to exist first.
//   2. Website Contributor for the GitHub deploy identity (id-gha-invi-studio-api-prod-001), on the Studio API site only:
//      the workflow can publish to this app and to nothing else. Its principal id is a literal parameter (output
//      githubDeployPrincipalId of deployment A), so the safety gate can predict the assignment's name offline.
//
// The site is `existing`: this file can never create or change it. Run it after deployment A, which creates both
// identities. Role assignments take a few minutes to reach the vault's data plane, so a Key Vault reference can show as
// unresolved right after this deployment; App Service retries it.

@description('Workload name')
param workloadName string

@description('Deployment environment')
param environment string

@description('Resource instance number')
param instance string

@description('Names of the Key Vault secrets the Studio API may read. Every one has to exist')
@minLength(1)
param secretNames string[]

@description('Secret name -> name (GUID) of an assignment that already exists for the Studio identity on that secret. Adopts a hand-made assignment instead of colliding with it.')
param existingAssignmentNames object = {}

@description('Principal (object) id of the GitHub deploy identity: output githubDeployPrincipalId of deployment A. Empty = no Website Contributor assignment yet')
param githubDeployPrincipalId string = ''

var keyVaultName = 'kv-${workloadName}-${environment}-${instance}'
var studioApiName = 'app-${workloadName}-studio-api-${environment}-${instance}'

var websiteContributorRoleDefinitionId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  'de139f84-1756-47ae-9be6-808fbbe84772'
)

resource studioApi 'Microsoft.Web/sites@2024-11-01' existing = {
  name: studioApiName
}

module secretAccess 'rbac-keyvault-secret-scope.bicep' = [
  for secretName in secretNames: {
    name: 'rbac-${studioApiName}-${secretName}'

    params: {
      keyVaultName: keyVaultName
      secretName: secretName
      principalId: studioApi.identity.principalId
      existingAssignmentName: existingAssignmentNames[?secretName] ?? ''
    }
  }
]

// Same assignment-name shape as the other role assignments (scope, principal, role).
resource githubDeployWebsiteContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(githubDeployPrincipalId)) {
  name: guid(studioApi.id, githubDeployPrincipalId, websiteContributorRoleDefinitionId)

  scope: studioApi

  properties: {
    roleDefinitionId: websiteContributorRoleDefinitionId
    principalId: githubDeployPrincipalId
    principalType: 'ServicePrincipal'
  }
}
