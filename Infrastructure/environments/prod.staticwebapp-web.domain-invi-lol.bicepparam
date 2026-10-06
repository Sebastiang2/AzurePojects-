using '../modules/staticwebapp-domain.bicep'

// Deployment A: bind invi.lol (Invi landing page) to swa-invi-web-prod-001.
//
// Touches only the customDomains child resource invi.lol. Not the Static Web App itself
// and not app.cetchapp.com, which has its own file and deployment (see
// prod.staticwebapp-web.domain-app-cetchapp-com.bicepparam). Default Incremental mode,
// subscription pinned, never Complete:
//
//   az deployment group create -g rg-invi-prod-swc-001 \
//     --subscription 563af248-8461-42a9-8121-e350e48ca7b6 \
//     --name invi-prod-swa-domain-invi-lol-001 \
//     --no-wait \
//     --parameters Infrastructure/environments/prod.staticwebapp-web.domain-invi-lol.bicepparam
//
// Azure creates the validation token with the domain, so it cannot be read before the
// deployment has started: publish the TXT record right after starting it, not before.
// Read the token with
//   az staticwebapp hostname show -n swa-invi-web-prod-001 -g rg-invi-prod-swc-001 \
//     --hostname invi.lol --query validationToken
// and add it in Namecheap as a TXT record. Host @ for the apex per Microsoft's apex-domain
// guide; Microsoft's custom-domain article names _dnsauth.www.<domain> for apex domains, so
// check the host Azure shows for the domain before publishing. Until the TXT record is in
// place the create keeps running, and after 4 hours ARM fails the deployment and the
// domain can stay Validating (it did for app.cetchapp.com on 2026-10-03).
//
// Validation does not need DNS to point at the app: invi.lol can keep its current records
// until cutover. The cutover record (ALIAS/ANAME, or an A record to the app's
// stableInboundIP) is a separate step, only after the domain is Ready. invi.lol is on
// Namecheap DNS, which also carries its email forwarding (MX, SPF): keep those records.

param staticWebAppName = 'swa-invi-web-prod-001'
param domain = 'invi.lol'
param validationMethod = 'dns-txt-token'
