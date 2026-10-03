using '../modules/staticwebapp.bicep'

// Production Static Web App for the merged web app (Cetchapp-web, later invi-web).
// Bound to the Static Web App module on purpose: a deployment of this file can only
// ever touch this one resource, unlike main.bicep. Deploy it in isolation, in the
// default Incremental mode (never Complete), with the subscription pinned:
//
//   az deployment group what-if -g rg-invi-prod-swc-001 \
//     --subscription 563af248-8461-42a9-8121-e350e48ca7b6 \
//     --parameters Infrastructure/environments/prod.staticwebapp-web.bicepparam
//
//   az deployment group create -g rg-invi-prod-swc-001 \
//     --subscription 563af248-8461-42a9-8121-e350e48ca7b6 \
//     --name invi-prod-swa-web-001 \
//     --parameters Infrastructure/environments/prod.staticwebapp-web.bicepparam
//
// Provisions the resource only: no custom domains and no deployment token here.

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
