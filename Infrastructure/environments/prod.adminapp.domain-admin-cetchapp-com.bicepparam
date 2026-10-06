using '../modules/adminapp-domain.bicep'

// Deployment C: bind admin.cetchapp.com to the production admin app app-invi-admin-prod-001, then
// give it TLS. Contributor is enough.
//
// Touches only the hostNameBindings child resource admin.cetchapp.com, and in managed mode the
// certificate for it. Not the admin app itself, which is deployed from prod.adminapp.bicepparam
// first and never created here, and not any other domain. Do not deploy this before that, or
// before the DNS records described in modules/adminapp-domain.bicep exist. Default Incremental
// mode, subscription pinned, never Complete.
//
// Pass 1, tlsMode 'none' as committed: binds the hostname without TLS.
//
//   az deployment group what-if -g rg-invi-prod-swc-001 \
//     --subscription <SUBSCRIPTION_ID> \
//     --parameters Infrastructure/environments/prod.adminapp.domain-admin-cetchapp-com.bicepparam
//
//   az deployment group create -g rg-invi-prod-swc-001 \
//     --subscription <SUBSCRIPTION_ID> \
//     --name invi-prod-adminapp-domain-admin-cetchapp-com-001 \
//     --parameters Infrastructure/environments/prod.adminapp.domain-admin-cetchapp-com.bicepparam
//
// Pass 2, TLS: change tlsMode below to 'managed' (App Service managed certificate; the Cloudflare
// record for admin has to be DNS only) or to 'uploaded' with certificateThumbprint set (a Cloudflare
// Origin certificate for admin.cetchapp.com that you uploaded by hand; works behind the proxy). Deploy
// the same command with --name invi-prod-adminapp-domain-admin-cetchapp-com-002, and with --no-wait
// for managed, since certificate issuance is asynchronous. Keep the file at the final value afterwards:
// running pass 1 again would switch TLS off for the binding.
//
// Dropping the domain from this file later does not remove the binding from Azure (Incremental mode
// never deletes); remove it with:
//   az webapp config hostname delete --webapp-name app-invi-admin-prod-001 \
//     -g rg-invi-prod-swc-001 --hostname admin.cetchapp.com
//
// Out of scope here: cetchapp.com, www.cetchapp.com, app.cetchapp.com, api.cetchapp.com and invi.lol,
// and any later redirect from cetchapp.com/admin to this host.

param workloadName = 'invi'
param environment = 'prod'
param instance = '001'
param location = 'swedencentral'

param hostName = 'admin.cetchapp.com'

param tlsMode = 'none'

// Only read when tlsMode is 'uploaded'. Not a secret.
param certificateThumbprint = ''
