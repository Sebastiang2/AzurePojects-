targetScope = 'resourceGroup'

// Deployment B. Grants the Studio system identity read access to only its named secrets and grants the GitHub deploy
// identity Website Contributor on only the Studio site. The site and vault are existing resources and are not modified.

@description('Workload name')
param workloadName string

@description('Deployment environment')
param environment string

@description('Resource instance number')
param instance string

@description('Key Vault secret names the Studio system identity may read')
@minLength(1)
param secretNames string[]

@description('Secret name -> GUID of an existing assignment that should be adopted')
param existingAssignmentNames object = {}

@description('Principal id output by studio-web deployment A. Empty leaves the deploy role unassigned')
param githubDeployPrincipalId string = ''

var keyVaultName = 'kv-${workloadName}-${environment}-${instance}'
var studioName = 'app-${workloadName}-studio-${environment}-${instance}'
var websiteContributorRoleDefinitionId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  'de139f84-1756-47ae-9be6-808fbbe84772'
)

resource studio 'Microsoft.Web/sites@2024-11-01' existing = {
  name: studioName
}

module secretAccess 'rbac-keyvault-secret-scope.bicep' = [
  for secretName in secretNames: {
    name: 'rbac-${studioName}-${secretName}'
    params: {
      keyVaultName: keyVaultName
      secretName: secretName
      principalId: studio.identity.principalId
      existingAssignmentName: existingAssignmentNames[?secretName] ?? ''
    }
  }
]

resource githubDeployWebsiteContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(githubDeployPrincipalId)) {
  name: guid(studio.id, githubDeployPrincipalId, websiteContributorRoleDefinitionId)
  scope: studio
  properties: {
    roleDefinitionId: websiteContributorRoleDefinitionId
    principalId: githubDeployPrincipalId
    principalType: 'ServicePrincipal'
  }
}
