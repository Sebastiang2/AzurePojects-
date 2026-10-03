using '../modules/staticwebapp.bicep'

// Production Static Web App for the Invi product site and the app-link handlers
// (Cetchapp-web, later invi-web). It serves invi.lol (landing page) and
// app.cetchapp.com (deep links, invites, verify/reset, app fallback; permanent).
// It must NOT serve cetchapp.com: that host is the company site and /admin, which
// get their own deployment. A Static Web App cannot serve a different front page
// per host name, so one app per surface is required.
//
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
//     --name <deployment name not already in use> \
//     --no-wait \
//     --parameters Infrastructure/environments/prod.staticwebapp-web.bicepparam
//
// Declares the app and its custom domains: no DNS records and no deployment token here.
// www.cetchapp.com is deliberately not bound; Cloudflare redirects it to the apex.
//
// Removing a domain from customDomains does NOT remove it from Azure. An Incremental
// deployment leaves resources that are not in the template unchanged, and a custom
// domain is a child resource that is only ever created or updated here, never deleted
// (what-if reports no Delete for it). A binding that exists in Azure but is no longer
// listed below, such as cetchapp.com from the first domain deployment, stays until it
// is deleted on purpose:
//   az staticwebapp hostname delete -n swa-invi-web-prod-001 -g rg-invi-prod-swc-001 \
//     --hostname <domain>
// Never deploy this file in Complete mode or with a deployment stack that deletes
// unmanaged resources: that is the mode that can delete child resources.
//
// The domains use dns-txt-token validation, so DNS can keep pointing at the old hosting
// until cutover. Azure validates each domain asynchronously and the create can keep
// running until its TXT record exists: deploy with --no-wait, read each token with
//   az staticwebapp hostname show -n swa-invi-web-prod-001 -g rg-invi-prod-swc-001 \
//     --hostname <domain> --query validationToken
// and add the TXT record Azure asks for in DNS (host @ for the apex invi.lol,
// _dnsauth.<subdomain> for app.cetchapp.com). invi.lol is on Namecheap DNS, which also
// carries its email forwarding (MX, SPF): keep those records when DNS is changed.

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
  'invi.lol'
  'app.cetchapp.com'
]
param customDomainValidationMethod = 'dns-txt-token'
