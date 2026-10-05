using '../modules/staticwebapp-domain.bicep'

// Deployment C: bind www.invi.lol to swa-invi-web-prod-001, as an additional custom domain
// next to invi.lol (prod.staticwebapp-web.domain-invi-lol.bicepparam, live since 2026-10-05)
// and app.cetchapp.com (prod.staticwebapp-web.domain-app-cetchapp-com.bicepparam, not deployed).
//
// Touches only the customDomains child resource www.invi.lol. Not the Static Web App itself
// and not any other domain. Default Incremental mode, subscription pinned, never Complete:
//
//   az deployment group create -g rg-invi-prod-swc-001 \
//     --subscription 563af248-8461-42a9-8121-e350e48ca7b6 \
//     --name invi-prod-swa-domain-www-invi-lol-001 \
//     --no-wait \
//     --parameters Infrastructure/environments/prod.staticwebapp-web.domain-www-invi-lol.bicepparam
//
// Validation is dns-txt-token, not cname-delegation, on purpose. Both are accepted for a
// subdomain (the API default is cname-delegation), but cname-delegation validates by looking
// at the CNAME www -> lemon-mud-04380b30f.3.azurestaticapps.net: www would have to point at
// the app before the domain and its certificate exist, and the 4 hour ARM window below would
// be tied to a DNS change. With dns-txt-token the domain and its certificate are Ready while
// www still points at the current Namecheap parking page, and the CNAME change is a separate
// step that can be made when the certificate already exists. Same method as invi.lol and
// app.cetchapp.com.
//
// Azure creates the validation token with the domain, so it cannot be read before the
// deployment has started: publish the TXT record right after starting it, not before.
// Read the token with
//   az staticwebapp hostname show -n swa-invi-web-prod-001 -g rg-invi-prod-swc-001 \
//     --hostname www.invi.lol --query validationToken
// and add it in Namecheap as a TXT record. Host _dnsauth.www: for a subdomain Microsoft's
// custom-domain article ("Zero downtime migration") names _dnsauth.<subdomain>.<domain>, and a
// TXT record cannot sit at www itself while www is a CNAME. The API returns the token only,
// no host: check the host the Azure Portal shows for the domain (Custom domains > www.invi.lol
// > View details) before publishing. Until the TXT record is in place the create keeps running,
// and after 4 hours ARM fails the deployment and the domain can stay Validating (it did for
// app.cetchapp.com on 2026-10-03).
//
// Cutover is a separate step, only after the domain is Ready: replace
//   www CNAME parkingpage.namecheap.com.
// with
//   www CNAME lemon-mud-04380b30f.3.azurestaticapps.net.
// and keep the TXT record. The site is built with NEXT_PUBLIC_SITE_URL=https://invi.lol, so
// canonical, Open Graph, hreflang, robots.txt and sitemap.xml served on www still name
// https://invi.lol. This deployment adds no redirect from www to the apex.

param staticWebAppName = 'swa-invi-web-prod-001'
param domain = 'www.invi.lol'
param validationMethod = 'dns-txt-token'
