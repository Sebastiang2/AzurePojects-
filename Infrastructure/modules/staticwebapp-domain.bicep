targetScope = 'resourceGroup'

@description('Name of the existing Static Web App that owns the domain. It is only referenced, never created or updated here')
param staticWebAppName string

@description('Custom domain to bind, fully qualified (for example app.example.com). One domain per deployment, on purpose')
param domain string

@description('How ownership of the domain is validated. dns-txt-token validates with a TXT record while DNS still points elsewhere; cname-delegation needs the CNAME to point at the Static Web App first')
@allowed([
  'cname-delegation'
  'dns-txt-token'
])
param validationMethod string = 'dns-txt-token'

// One domain per deployment, and no Static Web App resource.
//
// A custom domain is created asynchronously: the create stays "Accepted" until Azure has
// validated the domain, and an ARM deployment waits for all of its resources. Domains that
// share a deployment therefore share its failure: on 2026-10-03 two domains were deployed
// together, neither validated, and ARM ended the deployment as Failed after 4 hours
// (RequestTimeout). Give each domain its own parameter file and its own deployment so a
// domain that does not validate cannot hold up, or fail, the deployment of another one.
//
// The Static Web App is `existing`: deploying a domain can never re-apply (and so reset)
// the app's own properties. The deployment fails if the app is missing instead of creating
// a new one. The app itself is deployed from modules/staticwebapp.bicep.
resource staticWebApp 'Microsoft.Web/staticSites@2024-11-01' existing = {
  name: staticWebAppName
}

resource customDomain 'Microsoft.Web/staticSites/customDomains@2024-11-01' = {
  parent: staticWebApp
  name: domain
  properties: {
    validationMethod: validationMethod
  }
}
