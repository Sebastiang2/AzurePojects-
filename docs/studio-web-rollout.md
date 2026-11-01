# Invi Studio web on Azure

The four deployments are deliberately separate:

1. `studio-web-a` creates `app-invi-studio-prod-001`, Application Insights, the system identity and the GitHub OIDC identity. It reuses `asp-invi-prod-001`, the existing VNet integration subnet and Log Analytics workspace.
2. `studio-web-b-rbac` grants the system identity `Key Vault Secrets User` on only `studio-api-key` and `studio-session-secret`, and later grants the GitHub identity `Website Contributor` on only the Studio site. After deployment A, copy its `githubDeployPrincipalId` output into the reviewed RBAC parameter file and add the predictable assignment to the safety manifest before B is approved.
3. `studio-web-c-domain` binds `studio.invi.lol` after the ownership TXT record exists.
4. `studio-web-d-domain-tls` creates the managed certificate and enables SNI after the binding and public DNS validate.

No deployment creates secrets or changes DNS. The value of `studio-api-key` must equal `STUDIO_API_KEY` on `https://invi-studio-api.onrender.com`; verify equality without printing either value.

## First-deployment access policy

Deployment A leaves `publicNetworkAccess` enabled so the App Service front end can later perform custom-domain and managed-certificate operations, but it configures an empty main-site rule list with a default action of `Deny`. The default `*.azurewebsites.net` hostname and any later custom hostname therefore cannot serve Studio traffic initially.

SCM is intentionally separate (`scmIpSecurityRestrictionsUseMain=false`) and currently has a default action of `Allow`. GitHub-hosted runners do not have stable egress ranges to allow-list. SCM is consequently still network-reachable, but FTP and SCM Basic publishing credentials are disabled; a deployment must authenticate through the narrowly scoped GitHub OIDC identity and Website Contributor role created in deployment B. OIDC is not an IP restriction. A narrower SCM policy needs a separate review before it can replace this temporary compatibility setting.

Custom-domain binding remains an ARM operation after the ownership TXT proof exists. Managed TLS remains deployment D: with the main application blocked, issuance still requires a public direct CNAME to the App Service default hostname and the App Service managed-certificate prerequisites. Microsoft documents that managed certificates can be issued with application access blocked; validate successful issuance from the Azure control plane before treating that behavior as operationally proven here. Do not create the TXT/CNAME, binding or certificate before the Studio backend and code are approved for production.

## Code prerequisite

Do not publish Studio `main` as it stands. An updated feature branch must carry forward the useful parts of PR #1:

- Next.js `output: "standalone"`, packaging of `.next/standalone`, and a Node 22 build and test job.
- `scripts/launch.mjs` and `scripts/key-vault-secrets.mjs` beside `server.js` in the package.
- strict `STUDIO_PUBLIC_ORIGIN` checks and secret validation.
- OIDC deployment from the protected `production` environment using the client ID output by deployment A.
- the fail-closed billing policy: Azure or `STUDIO_ENVIRONMENT=production` must stay closed when Stripe is absent, while database-backed organizer exemptions remain valid. `STUDIO_BILLING_PREVIEW` and legacy environment exemptions must remain disabled in production.

Run the safety gate in dry-run mode for each deployment. A real Azure deployment, role change, DNS change, secret operation or code publication requires separate approval.
