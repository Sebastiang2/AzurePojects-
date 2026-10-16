targetScope = 'resourceGroup'

@description('Name of the existing web app the identity may deploy to')
param siteName string

@description('Object ID of the identity that gets Website Contributor on that one app (the GitHub deploy identity of the app)')
param principalId string

// Website Contributor on ONE app: manage the web app (deploy, restart, read its configuration), not its plan, not the network and not other
// resources. It is a module of its own, as rbac-keyvault-secret-scope.bicep is, because the name of a role assignment has to be calculable at
// the start of a deployment and the principalId of an identity that another deployment created arrives here as a parameter. The principalId is
// in the name, as in rbac.bicep: a recreated identity gets a new assignment instead of colliding with the orphaned one.
var websiteContributorRoleDefinitionId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  'de139f84-1756-47ae-9be6-808fbbe84772'
)

resource site 'Microsoft.Web/sites@2024-11-01' existing = {
  name: siteName
}

resource websiteContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(site.id, principalId, websiteContributorRoleDefinitionId)

  scope: site

  properties: {
    roleDefinitionId: websiteContributorRoleDefinitionId
    principalId: principalId
    principalType: 'ServicePrincipal'
  }
}
