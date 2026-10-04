using '../modules/staticwebapp-domain.bicep'

// Deployment B: bind app.cetchapp.com (deep links, invites, verify/reset, app fallback;
// permanent) to swa-invi-web-prod-001.
//
// Declared here so the target architecture is in code, but deliberately NOT part of the
// invi.lol deployment (prod.staticwebapp-web.domain-invi-lol.bicepparam): it must be
// possible to launch invi.lol while app.cetchapp.com is broken or still validating.
//
// DO NOT DEPLOY until this has been approved separately. State on 2026-10-04:
//  - The binding exists in Azure and is Validating since 2026-10-03. The first create
//    (invi-prod-swa-custom-domains-001) stayed Accepted with no terminal event and ARM
//    ended it as Failed after 4 hours. The matching TXT record is public now, so the
//    binding needs a fresh attempt; deploying this file is that attempt (a PUT of the
//    existing child resource). What it does to a Validating binding is not documented:
//    compare the token Azure reports afterwards with the published TXT record.
//  - app.cetchapp.com must keep pointing at the working polite-field Static Web App
//    (binding Ready there). Azure allows the same host on two apps in different slices
//    (polite-field is slice 5, this app is slice 3). Do not delete and recreate this
//    Static Web App: a new one can land in slice 5, and the host then collides.
//  - Do not cut over DNS yet: the live app.cetchapp.com serves
//    /.well-known/apple-app-site-association and /.well-known/assetlinks.json, and this
//    app returns 404 for both, which would break iOS Universal Links and Android App Links.
//
//   az deployment group create -g rg-invi-prod-swc-001 \
//     --subscription 563af248-8461-42a9-8121-e350e48ca7b6 \
//     --name <deployment name not already in use> \
//     --no-wait \
//     --parameters Infrastructure/environments/prod.staticwebapp-web.domain-app-cetchapp-com.bicepparam
//
// Validation is a TXT record at _dnsauth.app.cetchapp.com. Keep the values already there:
// the other one is probably the validation token of the polite-field binding. Read the
// token with
//   az staticwebapp hostname show -n swa-invi-web-prod-001 -g rg-invi-prod-swc-001 \
//     --hostname app.cetchapp.com --query validationToken

param staticWebAppName = 'swa-invi-web-prod-001'
param domain = 'app.cetchapp.com'
param validationMethod = 'dns-txt-token'
