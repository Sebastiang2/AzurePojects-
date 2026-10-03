using '../modules/staticwebapp.bicep'

// Production Static Web App for the merged web app (Cetchapp-web, later invi-web).
// Bound to the Static Web App module on purpose: a deployment of this file can only
// ever touch this Static Web App and its custom domains, unlike main.bicep. Deploy it
// in isolation, in the default Incremental mode (never Complete), with the
// subscription pinned:
//
//   az deployment group what-if -g rg-invi-prod-swc-001 \
//     --subscription 563af248-8461-42a9-8121-e350e48ca7b6 \
//     --parameters Infrastructure/environments/prod.staticwebapp-web.bicepparam
//
//   az deployment group create -g rg-invi-prod-swc-001 \
//     --subscription 563af248-8461-42a9-8121-e350e48ca7b6 \
//     --name invi-prod-swa-web-domains-001 \
//     --no-wait \
//     --parameters Infrastructure/environments/prod.staticwebapp-web.bicepparam
//
// Declares the app and its custom domains: no DNS records and no deployment token here.
// www.cetchapp.com is deliberately not bound; Cloudflare redirects it to the apex.
//
// The domains use dns-txt-token validation, so DNS can keep pointing at the old hosting
// until cutover. Azure validates each domain asynchronously and the create can keep
// running until its TXT record exists: deploy with --no-wait, read each token with
//   az staticwebapp hostname show -n swa-invi-web-prod-001 -g rg-invi-prod-swc-001 \
//     --hostname <domain> --query validationToken
// and add the TXT record Azure asks for in DNS.

param name = 'swa-invi-web-prod-001'
// eastus2: Static Web Apps is not available in swedencentral
param location = 'eastus2'
param skuName = 'Standard'
param skuTier = 'Standard'
param tags = {
  project: 'CetchApp'
  environment: 'prod'
  component: 'web'
  'managed-by': 'bicep'
}
param repositoryUrl = 'https://github.com/CetchApp/Cetchapp-web'
param branch = 'main'
param customDomains = [
  'app.cetchapp.com'
  'cetchapp.com'
]
param customDomainValidationMethod = 'dns-txt-token'
