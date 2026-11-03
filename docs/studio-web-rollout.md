# Invi Studio web on Azure

The deployments are deliberately separate, and each has its own approval:

1. `studio-web-a` creates `app-invi-studio-prod-001`, Application Insights, the system identity and the GitHub OIDC identity. It reuses `asp-invi-prod-001`, the existing VNet integration subnet and Log Analytics workspace. The main site starts closed.
2. `studio-web-b-rbac` grants the system identity `Key Vault Secrets User` on only `studio-api-key` and `studio-session-secret`, and later grants the GitHub identity `Website Contributor` on only the Studio site. After deployment A, copy its `githubDeployPrincipalId` output into the reviewed RBAC parameter file and add the predictable assignment to the safety manifest before B is approved.
3. `studio-web-c-domain` binds `studio.invi.lol` after the ownership TXT record exists.
4. `studio-web-d-domain-tls` creates the managed certificate and enables SNI after the binding and public DNS validate.
5. `studio-web-e-ingress-public` opens the main site (see "Opening the main site"). Its rollback is `studio-web-e-ingress-close`.

No deployment creates secrets or changes DNS. The value of `studio-api-key` must equal `STUDIO_API_KEY` on the onboarding API (`https://invi-studio-api.onrender.com`); verify equality without printing either value (step 7 below). That API runs on Render and is configured in the Render dashboard: nothing about it is managed by this repository.

## First-deployment access policy

Deployment A leaves `publicNetworkAccess` enabled so the App Service front end can later perform custom-domain and managed-certificate operations, but it configures an empty main-site rule list with a default action of `Deny`. The default `*.azurewebsites.net` hostname and any later custom hostname therefore cannot serve Studio traffic initially.

SCM is intentionally separate (`scmIpSecurityRestrictionsUseMain=false`) and currently has a default action of `Allow`. GitHub-hosted runners do not have stable egress ranges to allow-list. SCM is consequently still network-reachable, but FTP and SCM Basic publishing credentials are disabled; a deployment must authenticate through the narrowly scoped GitHub OIDC identity and Website Contributor role created in deployment B. OIDC is not an IP restriction. A narrower SCM policy needs a separate review before it can replace this temporary compatibility setting.

A blocked request is answered by the App Service front end with `403 Ip Forbidden` and an `x-ms-forbidden-ip` header, before the app is reached (observed 2026-11-02 on another origin-locked site of this plan). That is the expected answer from the default hostname until the main site is opened, and the deploy workflow's smoke check treats exactly that answer as a warning.

### Managed certificate while the main site is closed

Custom-domain binding remains an ARM operation after the ownership TXT proof exists. Managed TLS is deployment D. It needs a public DNS record and, for a subdomain, a CNAME mapped directly to the App Service default hostname (DNS only, no proxy). Do not create the TXT/CNAME, binding or certificate before the Studio backend and code are approved for production.

Whether D works with the main site closed is documented in two places that differ:

- The Microsoft Learn page on App Service certificates (`configure-ssl-certificate`; the page metadata is dated 2026-09-22) still lists "no IP restrictions" as a prerequisite for root domains and is silent on subdomains and on renewal behind restrictions.
- The Apps on Azure blog post "Follow-Up to 'Important Changes to App Service Managed Certificates': November 2025 Update" (Microsoft Community Hub, 2025-11-03, updated 2025-12-08) says that since November 2025 App Service answers the CA's validation request itself, at the front end, so IP restrictions, disabled public access, private endpoints, App Service Authentication and client certificates no longer block issuance or renewal. A public DNS record is still required, and "try to create one" is the test: if the first request succeeds, renewals should work. The admin app's domain module (`adminapp-domain.bicep`) already relies on this.

So D is the proof for this site. If Azure refuses the certificate request, nothing is bound and nothing is lost: apply the reviewed ingress step (E) first and repeat D.

## Code prerequisite

Do not publish Studio `main` as it stands. The updated feature branch is Studio PR #2 (`CetchApp/invi-studio`, `feat/azure-standalone-production`); it carries forward the useful parts of the older Studio PR #1, which, like the older PR #16 of this repository (`webapp.bicep`, `prod.studio.bicepparam`), is superseded by the modules on `main` and should be closed rather than merged. Checked against the infrastructure on `main` (2026-11-02):

| Contract | Studio PR #2 | Status |
| --- | --- | --- |
| Next.js `output: "standalone"`, `.next/standalone` packaged, Node 22 build and test job | `next.config.ts`, `npm run package:standalone`, job `build` | matches |
| Start command `node launch.mjs` (this repository's `appCommandLine`); never `node server.js` | `scripts/launch.mjs` and `scripts/key-vault-secrets.mjs` are copied beside `server.js`; the smoke test starts `launch.mjs` | matches |
| `KEY_VAULT_URI` and `KEY_VAULT_MAP` (`studio-api-key:STUDIO_API_KEY;studio-session-secret:STUDIO_SESSION_SECRET`), loaded with the system identity through the private endpoint | the loader reads exactly those variables; `/api/health?deep=1` reports `not-configured` when any mapped secret is missing | matches |
| Strict `STUDIO_PUBLIC_ORIGIN` (`https://studio.invi.lol`, set by deployment A) | origin check trusts only the configured origin | needed a fix: with the setting missing, a customer-facing deployment still derived the origin from `Host`; the launcher now refuses to start and the check fails closed (branch `fix/studio-azure-contract` of the Studio repository) |
| Secret validation | an unresolved Key Vault reference is refused | needed a fix: a session secret shorter than 32 characters passed the launcher and every health check, then failed every sign-in; the launcher now refuses it |
| OIDC deployment from the protected `production` environment, client ID from deployment A | `azure/login@v2` with repository variables; subject `repo:CetchApp/invi-studio:environment:production` equals the federated credential of deployment A | matches; the repository variables and the environment rules still have to be created by a repository administrator |
| Fail-closed billing: Azure or `STUDIO_ENVIRONMENT=production` stays closed without Stripe, database-backed organizer exemptions stay valid; `STUDIO_BILLING_PREVIEW` and `STUDIO_BILLING_EXEMPT` are ignored in production | `src/lib/billing-policy.ts`, `docs/billing.md`, smoke test | matches |
| Smoke check after the deploy | called the default hostname and demanded 200, which deployment A's deny-all policy makes impossible | needed a fix: `403 Ip Forbidden` with `x-ms-forbidden-ip` is a warning, every other answer still fails the job |
| Check that the vault key is the API's key | `/api/health?deep=1` only proves the key while the API refuses calls without it | `scripts/verify-api-key.mjs`, shipped beside `launch.mjs` and run by hand (step 7) |

Do not use the older recipe (`node server.js`, `STUDIO_BILLING_PREVIEW` as a launch switch, `docs/studio-and-onboarding-api.md` of PR #16). It is superseded by `node launch.mjs`, the deployments above and Namecheap DNS for `invi.lol`.

## Production gate order

Every writing step goes through its own approval; nothing below is approved by being listed. Every step is announced in, and applied inside, the agreed production deploy window, and none runs while another change to a shared production resource (the App Service plan, the VNet, Key Vault, Log Analytics, private DNS) is in flight. Nothing creates secrets, DNS records or role assignments except the step that names it, and no value of a secret appears in a chat, a log or a pull request.

| # | Step | Who | Evidence, and when to stop |
| --- | --- | --- | --- |
| 1 | Render: set the Health Check Path of the onboarding API to `/api/health` (manual, in the Render dashboard; the current `main` already serves it). Then review and merge the onboarding pull request. **The merge deploys the API**: Render builds every commit on `main` | Render account holder; reviewer | Render marks the deploy live. With the health check path set, Render does not switch traffic to a build that fails it: after 15 minutes it cancels the deploy and keeps the old one. Stop if that happens |
| 2 | Health and authorization test of the deployed API (read-only): `/api/health` is 200; the Studio routes refuse a missing and a wrong key with 401 | Backend owner | Stop on a 5xx from `/api/health`, or a Studio route that answers without the key |
| 3 | Safety gate again, the same day: `deploy.sh --deployment studio-web-a --dry-run` from clean `main`, then the what-if read by the approver. The evidence of an earlier run expires (`maxEvidenceAgeMinutes`). Also read the memory headroom of `asp-invi-prod-001`, which gains a Node process | Backend owner, approver | PASS and a read what-if. Stop on any blocking finding, or when the plan has no memory to spare |
| 4 | Deployment `studio-web-a` | Backend owner | App Running; no traffic served (`403 Ip Forbidden` is the expected answer) |
| 5 | The two secrets exist in `kv-invi-prod-001` (`studio-api-key` equal to `STUDIO_API_KEY` on Render, `studio-session-secret` random with at least 32 characters; values never shown). Then one reviewed change, after A and before B: `githubDeployPrincipalId` into the RBAC parameter file, and the three role assignments that B creates (Secrets User on each of the two secrets for the Studio identity, Website Contributor on the site for the GitHub identity; the gate of B prints their names as `RBAC-NEW`) as `allowedCreates` of `studio-web-b-rbac` and in `rbac.knownAssignments`. Without the second list every later gate run, for any deployment, fails with `RBAC-UNREVIEWED`. Then `studio-web-b-rbac` | Vault owner; an Owner of the subscription applies the role assignments | Role assignments exist for exactly the two secrets and the Studio site; the gate of step 9 reports no `RBAC-UNREVIEWED` |
| 6 | GitHub: the repository variables `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID` and, only after A, `AZURE_CLIENT_ID` (output of A), kept at repository level only: the deploy job's `if` reads `AZURE_CLIENT_ID`, and GitHub's documentation does not say that an environment-level variable is visible there, while an environment-level copy of the other two would override the repository value in the steps. The environment `production` with required reviewers and deployment branches limited to `main`, and a protected `main` (pull request and the `build` check required, no direct push), because the environment trusts that branch. Then merge Studio PR #2 with `fix/studio-azure-contract` and run the workflow by hand on `main` with Deploy ticked | Repository administrator (push access is not enough) | The deploy job stays skipped until `AZURE_CLIENT_ID` exists. The smoke check warns that the site is closed. That is not a verification: do step 7 |
| 7 | Checks from inside the closed app, no ingress change: Kudu SSH (Entra sign-in; SCM Basic stays off) or `az webapp ssh`. On the container's port (8080 unless `WEBSITES_PORT` says otherwise): `/api/health` and `/api/health?deep=1` on localhost, and `cd /home/site/wwwroot && node verify-api-key.mjs`. Do not print the environment | Backend owner | Both health calls 200 and `RESULT: MATCH` (the script prints names, status numbers and verdict words, never a value). Otherwise stop and read the console log (`key-vault: loaded 2 secret(s)`) |
| 8 | DNS at Namecheap, see below | Whoever holds the Namecheap account | `Resolve-DnsName` shows the TXT and the CNAME |
| 9 | `studio-web-c-domain` | Backend owner | The hostname is bound without TLS |
| 10 | `studio-web-d-domain-tls` | Backend owner | The certificate is issued and bound. If Azure refuses it, apply step 11 first and repeat this one |
| 11 | `studio-web-e-ingress-public` (see "Opening the main site") | Decision, then backend owner | `https://studio.invi.lol/api/health` and `?deep=1` are 200 from outside. Rollback: `studio-web-e-ingress-close` |
| 12 | Later and separate: any lock-down of the shared onboarding API | Decided in the onboarding repository | Not a precondition of the Studio launch. It must not be switched on before every caller of that API sends the Studio key |

The database track has its own approvals and does not hold up the launch of Studio itself: a read-only preflight (`Migrations/preflight-readonly.sql` in the onboarding repository), a backup point, `20261018_01_studio_billing_exemption.sql`, then the exemptions the product owner approves. Until the migration exists, `GET /api/studio/billing/exemption` answers a generic 503 and nobody can publish paid content (closed, never free).

### Decisions that are not made yet

- **Opening the main site (step 11).** DNS is at Namecheap, so there is no Cloudflare in front of Studio and the Data API's origin lock cannot be copied. The decision is whether the public launch is an open site (recommended, implemented as deployment E) or waits for something in front of it. Until E is applied the site is closed, also for customers.
- **Who is exempt from payment, and when Stripe opens.** Until then only exempt organizers publish paid content.

## Opening the main site

`studio-web-e-ingress-public` deploys the same template as A with `ingressMode = 'public'` (`prod.studio-web.ingress-public.bicepparam`). The default action of the main site becomes `Allow`, still with no rule list. Nothing else of this app changes, and no other site, the plan, SCM or any other service is touched. `ingressMode` is `closed` by default: a parameter that is left out renders exactly what deployment A rendered, and any value other than `closed` or `public` does not compile.

| Key | Parameter file | Effect | What the gate allows |
| --- | --- | --- | --- |
| `studio-web-e-ingress-public` | `prod.studio-web.ingress-public.bicepparam` | `Deny` to `Allow` | `siteConfig.ipSecurityRestrictionsDefaultAction` of `app-invi-studio-prod-001`, `Deny` to `Allow`, offline and in the what-if |
| `studio-web-e-ingress-close` (rollback) | `prod.studio-web.bicepparam` (the file of A) | `Allow` to `Deny` | the opposite change, for the same site only |

Checked offline: the two parameter files render (`az bicep snapshot`) with exactly one difference, that property; the gate approves the change only with its own manifest entry, in one direction, for this site. The what-if of a real deployment shows the same single property; the unchanged app-settings bag is read by the live comparison of the gate, not by what-if.

After the public step: `https://studio.invi.lol/api/health` and `?deep=1` from outside; the smoke check of the deploy workflow against the default host name then runs in full, without the warning; Application Insights shows no 5xx; the sign-in limit (30 per 15 minutes per address) still counts the client address once.

Controls that carry an open site: HTTPS only and TLS 1.2, HSTS, the same-origin check on every state-changing request, the session cookie flags (HttpOnly, Secure, SameSite=Lax), the sign-in rate limit, the signed Stripe webhook, the Studio key on every call to the onboarding API, and no remote image proxy.

Alternatives, not recommended for the first launch:

- **Cloudflare in front.** With DNS at Namecheap this means moving the whole `invi.lol` zone (apex and `www` to the static web app, `_dnsauth`, the MX and SPF records of the e-mail forwarding) and then an origin lock like the Data API's (CIDR rules plus a header). Revisit if abuse shows up.
- **Azure Front Door in front.** The site is restricted to the `AzureFrontDoor.Backend` service tag plus the `X-Azure-FDID` header; the custom domain and the managed certificate move to Front Door (steps 8 to 10 change); it has a monthly base cost, and a WAF only in the Premium tier.
- **Country or address filtering.** Not possible with App Service access restrictions (service tags and CIDRs only), and the customers are not at fixed addresses. An allow-list of tester addresses is not shipped: addresses identify people and this repository is public.

### DNS for `studio.invi.lol`

The DNS provider is Namecheap (Advanced DNS). Checked 2026-11-02: the name servers of `invi.lol` are `dns1.registrar-servers.com` and `dns2.registrar-servers.com`, both answer authoritatively (SOA primary `dns1.registrar-servers.com`), and the registrar is NameCheap, Inc. Cloudflare does not serve `invi.lol` (it serves `cetchapp.com`). No record exists yet for `studio.invi.lol` or `asuid.studio.invi.lol`. Records to add at step 8, both DNS-only (no proxy; managed TLS needs the CNAME to point straight at the app host name):

| Type | Host | Value |
| --- | --- | --- |
| TXT | `asuid.studio` | the `customDomainVerificationId` output of deployment A |
| CNAME | `studio` | `app-invi-studio-prod-001.azurewebsites.net.` |

Leave the existing records of `invi.lol` alone: the apex A record, `www` (a CNAME to the static web app), `_dnsauth` and the MX and SPF records of the e-mail forwarding.

Run the safety gate in dry-run mode for each deployment. A real Azure deployment, role change, DNS change, secret operation or code publication requires separate approval.
