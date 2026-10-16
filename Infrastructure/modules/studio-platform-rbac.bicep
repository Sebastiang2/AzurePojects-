targetScope = 'resourceGroup'

// Access for the Studio app and the onboarding API, in one deployment because both need the same kind of grant and the same person to run
// it: creating a role assignment takes Owner, User Access Administrator or Role Based Access Control Administrator. As Contributor it fails
// with AuthorizationFailed and changes nothing. The app deployments (webapp.bicep) create no role assignment, so they never wait for this one.
//
// Two kinds of grant, both on the narrowest scope that works:
//   1. Key Vault Secrets User (read secret values, nothing else) to each app's system-assigned identity, on each named secret and not on the
//      vault. Studio can read studio-api-key and studio-session-secret; the onboarding API can read studio-api-key and database-password;
//      neither can read any other secret in kv-invi-prod-001 (the two APIs have vault-wide access, see rbac.bicep). The price is ordering:
//      Azure refuses a role assignment on a scope that does not exist, so every secret named here has to exist first.
//   2. Website Contributor on one app to the user-assigned identity that the app's GitHub workflow signs in with (created by webapp.bicep),
//      so the workflow can deploy that app and nothing else.
//
// Both apps and both identities are `existing`: this file can never create or change them. Run it after the app deployments (they create the
// identities) and after the secrets exist. Role assignments can take a few minutes to reach the vault's data plane, so an app has to tolerate
// a failed first read (a Key Vault reference that cannot be resolved yet is retried by the platform).

@description('Workload name')
param workloadName string

@description('Deployment environment')
param environment string

@description('Resource instance number')
param instance string

@description('Names of the Key Vault secrets the Studio app may read. Every one has to exist')
@minLength(1)
param studioSecretNames string[]

@description('Names of the Key Vault secrets the onboarding API may read. Every one has to exist')
@minLength(1)
param onboardingApiSecretNames string[]

var keyVaultName = 'kv-${workloadName}-${environment}-${instance}'
var studioSiteName = 'app-${workloadName}-studio-${environment}-${instance}'
var onboardingApiSiteName = 'app-${workloadName}-onboarding-api-${environment}-${instance}'
var studioDeployIdentityName = 'id-gha-${workloadName}-studio-${environment}-${instance}'
var onboardingApiDeployIdentityName = 'id-gha-${workloadName}-onboarding-api-${environment}-${instance}'

resource studioSite 'Microsoft.Web/sites@2024-11-01' existing = {
  name: studioSiteName
}

resource onboardingApiSite 'Microsoft.Web/sites@2024-11-01' existing = {
  name: onboardingApiSiteName
}

resource studioDeployIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2024-11-30' existing = {
  name: studioDeployIdentityName
}

resource onboardingApiDeployIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2024-11-30' existing = {
  name: onboardingApiDeployIdentityName
}

module studioSecretAccess 'rbac-keyvault-secret-scope.bicep' = [
  for secretName in studioSecretNames: {
    name: 'rbac-${studioSiteName}-${secretName}'

    params: {
      keyVaultName: keyVaultName
      secretName: secretName
      principalId: studioSite.identity.principalId
    }
  }
]

module onboardingApiSecretAccess 'rbac-keyvault-secret-scope.bicep' = [
  for secretName in onboardingApiSecretNames: {
    name: 'rbac-${onboardingApiSiteName}-${secretName}'

    params: {
      keyVaultName: keyVaultName
      secretName: secretName
      principalId: onboardingApiSite.identity.principalId
    }
  }
]

module studioDeployAccess 'rbac-site-contributor.bicep' = {
  name: 'rbac-${studioSiteName}-deploy'

  params: {
    siteName: studioSiteName
    principalId: studioDeployIdentity.properties.principalId
  }
}

module onboardingApiDeployAccess 'rbac-site-contributor.bicep' = {
  name: 'rbac-${onboardingApiSiteName}-deploy'

  params: {
    siteName: onboardingApiSiteName
    principalId: onboardingApiDeployIdentity.properties.principalId
  }
}
