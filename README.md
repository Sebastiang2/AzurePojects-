# Invi Azure Infrastructure

Dette repositoriet inneholder Bicep-infrastrukturkode (Infrastructure as Code) for produksjonsmiljøet til Invi/CetchApp i Azure.

## Hva er dette? / What is this?

Dette er Bicep IaC for Invi produksjonsmiljø i Azure, deployert til `swedencentral` (med unntak av Static Web App som er deployert til `eastus2` der tjenesten er tilgjengelig).

All infrastruktur blir provisionert i ressursgruppen `rg-invi-prod-swc-001` under subscription `563af248-8461-42a9-8121-e350e48ca7b6` (CetchApp Prod).

## Arkitektur / Architecture

Produksjonsmiljøet består av følgende komponenter:

### Nettverk / Networking
- **VNet**: `vnet-invi-prod-001` (`10.20.0.0/16`)
  - App Service integration subnet: `10.20.1.0/24`
  - MySQL delegated subnet: `10.20.2.0/24`
  - Private Endpoint subnet: `10.20.3.0/24`
- **NSG**: Network Security Groups for hver subnet

### Database
- **MySQL Flexible Server**: `mysql-invi-prod-001`
  - Privat tilkobling via delegated subnet og private DNS zone
  - SKU: `Standard_B2s` (Burstable tier)
  - Versjon: 8.0.21
  - Storage: 32 GB
  - Backup retention: 14 dager
  - Database: `invi`

### Sikkerhet / Security
- **Key Vault**: `kv-invi-prod-001`
  - Privat tilgang via private endpoint
  - Private DNS zone for key vault
  - Lagrer hemmeligheter (Firebase secrets, Apple certs, etc.)
  - Bruker Managed Identity for tilgang fra App Services

### App Services
- **App Service Plan**: `asp-invi-prod-001` (P0v3, PremiumV3)
  - Delt mellom Auth API, Data API og Admin app
  
- **Auth API**: `app-invi-auth-api-prod-001`
  - Runtime: .NET Core 10.0
  - VNet integration
  - Managed Identity for Key Vault tilgang
  - Application Insights monitoring

- **Data API**: `app-invi-data-api-prod-001`
  - Runtime: .NET Core 10.0
  - VNet integration
  - Managed Identity for Key Vault tilgang
  - Application Insights monitoring
  - URL: `https://api.cetchapp.com`

- **Admin App**: `app-invi-admin-prod-001`
  - Runtime: Node.js 22-lts (Next.js server)
  - VNet integration
  - Easy Auth med Entra ID (single-tenant)
  - Managed Identity for Key Vault tilgang
  - URL: `https://admin.cetchapp.com`
  - App role: `Invi.Admin` (kreves for tilgang)

### Static Web App
- **Navn**: `swa-invi-web-prod-001` (tidligere `swa-invi-app-web-prod-001`)
- **Location**: `eastus2` (Static Web Apps er ikke tilgjengelig i Sweden Central)
- **SKU**: Standard
- **Domener**:
  - `invi.lol` (landing page)
  - `www.invi.lol`
  - `app.cetchapp.com` (deep links, invites, verify/reset, app fallback)
- **Repo**: `https://github.com/CetchApp/Cetchapp-web` (branch: `main`)

### Overvåking / Monitoring
- **Log Analytics Workspace**: `log-invi-prod-001`
  - Retention: 30 dager
  - Daily quota: 1 GB
  
- **Application Insights**:
  - `appi-invi-auth-api-prod-001` (for Auth API)
  - `appi-invi-data-api-prod-001` (for Data API)
  - Koblet til Log Analytics workspace

### Private DNS Zones
- `privatelink.mysql.database.azure.com` (for MySQL)
- `privatelink.vaultcore.azure.net` (for Key Vault)

## Mappestruktur / Folder Structure

```
Infrastructure/
├── main.bicep                  # Hoved-template for full infrastruktur
├── main.json                   # Kompilert ARM template
├── modules/                    # Gjenbrukbare Bicep-moduler
│   ├── network.bicep           # VNet og subnets
│   ├── nsg.bicep               # Network Security Groups
│   ├── privatedns.bicep        # Private DNS zones
│   ├── mysql.bicep             # MySQL Flexible Server
│   ├── keyvault.bicep          # Key Vault med private endpoint
│   ├── monitoring.bicep        # Log Analytics og Application Insights
│   ├── appservice.bicep        # Auth API og Data API
│   ├── rbac.bicep              # RBAC for Key Vault tilgang
│   ├── staticwebapp.bicep      # Static Web App (bare resource)
│   ├── staticwebapp-domain.bicep  # Custom domain for Static Web App
│   ├── adminapp.bicep          # Admin web app (Next.js)
│   ├── adminapp-domain.bicep   # Custom domain for admin app
│   ├── adminapp-rbac.bicep     # RBAC for admin app Key Vault tilgang
│   └── rbac-keyvault-secret-scope.bicep  # Helper for Key Vault RBAC
├── environments/               # Parameter-filer per miljø
│   ├── prod.bicepparam         # Hovedparametere for prod (main.bicep)
│   ├── prod.adminapp.bicepparam  # Admin app deployment (A)
│   ├── prod.adminapp.rbac-owner.bicepparam  # Admin app RBAC (B, krever Owner)
│   ├── prod.adminapp.domain-admin-cetchapp-com.bicepparam  # Admin domain (C)
│   ├── prod.staticwebapp-web.bicepparam  # Static Web App (uten domener)
│   ├── prod.staticwebapp-web.domain-invi-lol.bicepparam
│   ├── prod.staticwebapp-web.domain-www-invi-lol.bicepparam
│   └── prod.staticwebapp-web.domain-app-cetchapp-com.bicepparam
└── scripts/
    └── deploy.sh               # Deployment script med validering
```

## Deployment

### Forutsetninger / Prerequisites

1. **Azure CLI** installert og innlogget
2. **Azure subscription**: `563af248-8461-42a9-8121-e350e48ca7b6` (CetchApp Prod)
3. **Rettigheter**: Contributor på ressursgruppen (Owner for RBAC-deployment av admin app)
4. **Miljøvariabler**: Følgende må være satt før deployment

### Påkrevde miljøvariabler / Required Environment Variables

```bash
# MySQL admin passord (påkrevd)
export MYSQL_ADMIN_PASSWORD='<your-secure-password>'

# RevenueCat secrets (påkrevd for Data API)
export REVENUECAT_SECRET_API_KEY='<revenuecat-secret-key>'
export REVENUECAT_WEBHOOK_AUTHORIZATION='<revenuecat-webhook-auth>'

# Admin app Easy Auth (kun for admin deployment)
export ADMIN_ENTRA_CLIENT_SECRET='<entra-client-secret>'
```

**VIKTIG**: Disse verdiene skal ALDRI committes til Git. De leses fra miljøvariabler via `readEnvironmentVariable()` i parameter-filene.

### Full infrastruktur deployment

Deploy full infrastruktur (VNet, MySQL, Key Vault, APIs, Static Web App) med `deploy.sh`:

```bash
cd Infrastructure/scripts
./deploy.sh
```

Scriptet kjører følgende steg:

1. **Pre-flight checks**: Verifiserer Azure CLI, login, subscription, ressursgruppe og miljøvariabler
2. **Validate local files**: Bygger og validerer Bicep-filer lokalt
3. **Azure validation**: Kjører `az deployment group validate`
4. **What-If preview**: Viser hvilke endringer som vil bli gjort
5. **Deploy**: Deployer infrastrukturen (krever bekreftelse)
6. **Verify**: Sjekker at App Services kjører
7. **GitHub identities**: Oppretter/verifiserer managed identities for GitHub Actions
8. **OIDC federation**: Konfigurerer federated credentials for GitHub deployment
9. **RBAC**: Tildeler Website Contributor rolle for CI/CD

### Separate deployments

#### Admin App (tre-trinns deployment)

Admin appen krever tre separate deployments:

**A. Admin app (Contributor-tilgang er nok):**
```bash
az deployment group create -g rg-invi-prod-swc-001 \
  --subscription 563af248-8461-42a9-8121-e350e48ca7b6 \
  --name invi-prod-adminapp-001 \
  --parameters Infrastructure/environments/prod.adminapp.bicepparam
```

**B. RBAC for Key Vault (krever Owner-rolle):**
```bash
az deployment group create -g rg-invi-prod-swc-001 \
  --subscription 563af248-8461-42a9-8121-e350e48ca7b6 \
  --name invi-prod-adminapp-rbac-001 \
  --parameters Infrastructure/environments/prod.adminapp.rbac-owner.bicepparam
```

**C. Custom domain og TLS:**
```bash
az deployment group create -g rg-invi-prod-swc-001 \
  --subscription 563af248-8461-42a9-8121-e350e48ca7b6 \
  --name invi-prod-adminapp-domain-001 \
  --parameters Infrastructure/environments/prod.adminapp.domain-admin-cetchapp-com.bicepparam
```

**Rekkefølge**: A (uten Easy Auth) → Entra app registration (manuelt) → Key Vault secret (manuelt) → B → DNS (manuelt) → C → A (med Easy Auth) → Application code

#### Static Web App

Deploy Static Web App uten domener:
```bash
az deployment group create -g rg-invi-prod-swc-001 \
  --subscription 563af248-8461-42a9-8121-e350e48ca7b6 \
  --name invi-prod-swa-web-001 \
  --parameters Infrastructure/environments/prod.staticwebapp-web.bicepparam
```

Deploy custom domains separat (ett domene per deployment):
```bash
az deployment group create -g rg-invi-prod-swc-001 \
  --subscription 563af248-8461-42a9-8121-e350e48ca7b6 \
  --name invi-prod-swa-web-domain-invi-lol \
  --parameters Infrastructure/environments/prod.staticwebapp-web.domain-invi-lol.bicepparam
```

## Sikkerhet / Security

### Secrets Management

1. **Aldri commit secrets til Git**
   - Alle passord og API-nøkler må være miljøvariabler
   - Parameter-filer bruker `readEnvironmentVariable()` for sensitive verdier
   - Deployment feiler hvis en påkrevd miljøvariabel mangler (forebygger utilsiktet sletting)

2. **Key Vault**
   - Alle secrets lagres i Key Vault
   - Private endpoint – kun tilgjengelig fra VNet
   - Managed Identity brukes for tilgang fra App Services
   - Ingen hemmeligheter i App Settings (unntatt admin Entra client secret)

3. **Network Security**
   - MySQL har kun privat tilgang (private endpoint, ingen offentlig IP)
   - Key Vault har kun privat tilgang
   - App Services bruker VNet integration
   - NSG-er på alle subnets

### Managed Identity Pattern

App Services bruker system-assigned managed identity for å lese hemmeligheter fra Key Vault:

```
App Service → Managed Identity → RBAC → Key Vault → Secrets
```

RBAC-tildeling er definert i `modules/rbac.bicep` (for APIs) og `modules/adminapp-rbac.bicep` (for admin app).

### GitHub Actions Deployment

CI/CD bruker federated credentials med GitHub OIDC:

- **Auth API**: `id-gha-invi-auth-api-prod-001`
- **Data API**: `id-gha-invi-data-api-prod-001`
- Rolle: Website Contributor (på app-nivå, ikke subscription-nivå)

## Domener og URLer / Domains and URLs

### Produksjonsdomener
- `https://api.cetchapp.com` – Data API
- `https://admin.cetchapp.com` – Admin portal (Easy Auth-beskyttet)
- `https://app.cetchapp.com` – Static Web App (deep links, invites)
- `https://invi.lol` – Produkt landing page (Static Web App)
- `https://www.invi.lol` – Redirect til invi.lol

### Interne URLer
- MySQL: `mysql-invi-prod-001.mysql.database.azure.com` (kun via VNet)
- Key Vault: `kv-invi-prod-001.vault.azure.net` (kun via VNet)
- Auth API default hostname: `app-invi-auth-api-prod-001.azurewebsites.net`
- Data API default hostname: `app-invi-data-api-prod-001.azurewebsites.net`
- Admin app default hostname: `app-invi-admin-prod-001.azurewebsites.net`

## Hva er IKKE i dette repoet / Out of Scope

Dette repoet inneholder **kun infrastrukturkode**. Følgende er **ikke** inkludert her:

1. **Applikasjonskode** – lever i separate repositories under CetchApp-organisasjonen:
   - Auth API: `CetchApp/cetchapp-auth-api`
   - Data API: `CetchApp/cetchapp-data-api`
   - Admin App: (separat repo)
   - Web App: `CetchApp/Cetchapp-web`

2. **CI/CD pipelines** – GitHub Actions workflows lever i app-repoene

3. **Secrets og sertifikater** – lagres i Key Vault eller miljøvariabler

4. **DNS-konfigurasjon** – DNS records for custom domains administreres utenfor Bicep

5. **Entra ID app registrations** – må opprettes manuelt før admin app Easy Auth fungerer

6. **Application Insights queries og alerts** – konfigureres i Azure Portal

## Deployment Mode

**ALLTID bruk Incremental mode** (default). Deployment scriptet bruker `--mode Incremental`.

**ALDRI bruk Complete mode** – det vil slette alle ressurser som ikke er i templaten, inkludert child resources som custom domains.

## Vedlikehold / Maintenance

### Oppdatere secrets

1. Oppdater verdien i Key Vault (for Key Vault secrets) eller App Settings (for direkte env vars)
2. Restart App Service hvis nødvendig

### Rotere Entra client secret (admin app)

Admin app Easy Auth bruker en Entra client secret som utløper. Rotasjon:

1. Opprett ny client secret i Entra app registration "Invi Production Admin"
2. `export ADMIN_ENTRA_CLIENT_SECRET='<new-secret>'`
3. Redeploy admin app: `az deployment group create ... --parameters prod.adminapp.bicepparam`

### Skalere App Service Plan

App Service Plan SKU er definert i `prod.bicepparam`:

```bicep
param appServiceSkuName = 'P0v3'
param appServiceSkuTier = 'PremiumV3'
```

Endre disse verdiene og redeploy.

## Troubleshooting

### Deployment feiler med "MYSQL_ADMIN_PASSWORD is not set"

Løsning: `export MYSQL_ADMIN_PASSWORD='<password>'`

### App Service kan ikke nå Key Vault

Sjekk:
1. Er VNet integration aktivert?
2. Har appen Managed Identity?
3. Har Managed Identity RBAC-tilgang til Key Vault?
4. Er Key Vault private endpoint riktig konfigurert?

### Static Web App custom domain validering feiler

Custom domains må valideres via DNS TXT record før deployment. Se [Azure dokumentasjon](https://learn.microsoft.com/en-us/azure/static-web-apps/custom-domain).

### Admin app Easy Auth fungerer ikke

Sjekk:
1. Er `entraClientId` og `entraClientSecret` satt i `prod.adminapp.bicepparam`?
2. Er redirect URI `https://admin.cetchapp.com/.auth/login/aad/callback` lagt til i Entra app registration?
3. Er "Assignment required" satt til Yes i enterprise application?
4. Er brukere tildelt `Invi.Admin` app role?

## Ressurser / Resources

- [Azure Bicep dokumentasjon](https://learn.microsoft.com/en-us/azure/azure-resource-manager/bicep/)
- [Azure naming conventions](https://learn.microsoft.com/en-us/azure/cloud-adoption-framework/ready/azure-best-practices/resource-naming)
- [Azure CLI reference](https://learn.microsoft.com/en-us/cli/azure/)

---

**Sist oppdatert**: 2026-10-06  
**Maintainers**: CetchApp / Invi team
