using '../modules/staticwebapp.bicep'

// Production Static Web App for the Invi product site and the app-link handlers
// (Cetchapp-web, later invi-web). It serves invi.lol (landing page) and
// app.cetchapp.com (deep links, invites, verify/reset, app fallback; permanent).
// It must NOT serve cetchapp.com: that host is the company site and /admin, which
// get their own deployment. A Static Web App cannot serve a different front page
// per host name, so one app per surface is required.
//
// This file declares the Static Web App and NO custom domains, on purpose. Every domain
// has its own parameter file and its own deployment, so that a domain that does not
// validate cannot fail the deployment of another one (see modules/staticwebapp-domain.bicep).
// Do not add customDomains here:
//   prod.staticwebapp-web.domain-invi-lol.bicepparam          invi.lol
//   prod.staticwebapp-web.domain-app-cetchapp-com.bicepparam  app.cetchapp.com
//
// Bound to the Static Web App module on purpose: a deployment of this file can only
// ever touch this Static Web App, unlike main.bicep. Deploy it in isolation, in the
// default Incremental mode (never Complete), with the subscription pinned:
//
//   az deployment group what-if -g rg-invi-prod-swc-001 \
//     --subscription 563af248-8461-42a9-8121-e350e48ca7b6 \
//     --parameters Infrastructure/environments/prod.staticwebapp-web.bicepparam
//
//   az deployment group create -g rg-invi-prod-swc-001 \
//     --subscription 563af248-8461-42a9-8121-e350e48ca7b6 \
//     --name <deployment name not already in use> \
//     --parameters Infrastructure/environments/prod.staticwebapp-web.bicepparam
//
// Declares the app only: no custom domains, DNS records or deployment token here.
// www.cetchapp.com is deliberately not bound; Cloudflare redirects it to the apex.
//
// cetchapp.com is not declared for this app, but a binding for it still exists in Azure
// (created by the first domain deployment on 2026-10-03, Validating since). Leaving a
// domain out of a template does NOT remove it from Azure: an Incremental deployment
// leaves resources that are not in the template unchanged, and a custom domain is a
// child resource that is never deleted by one (what-if reports no Delete for it). That
// binding stays until it is deleted on purpose:
//   az staticwebapp hostname delete -n swa-invi-web-prod-001 -g rg-invi-prod-swc-001 \
//     --hostname cetchapp.com
// Never deploy any of these files in Complete mode or with a deployment stack that
// deletes unmanaged resources: that is the mode that can delete child resources.

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
