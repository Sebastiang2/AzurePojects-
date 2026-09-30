# Infrastructure Module Reference

This directory contains the Bicep infrastructure-as-code templates for deploying the INVI application platform on Azure. The infrastructure is organized as a main orchestration template (`main.bicep`) that composes reusable modules to deploy a secure, multi-tier architecture.

## Table of Contents

- [Overview](#overview)
- [Deployment Architecture](#deployment-architecture)
- [Module Reference](#module-reference)
  - [network.bicep](#networkbicep)
  - [nsg.bicep](#nsgbicep)
  - [privatedns.bicep](#privatednsbicep)
  - [mysql.bicep](#mysqlbicep)
  - [keyvault.bicep](#keyvaultbicep)
  - [appservice.bicep](#appservicebicep)
  - [rbac.bicep](#rbacbicep)
  - [staticwebapp.bicep](#staticwebappbicep)
  - [monitoring.bicep](#monitoringbicep)
- [Parameter Configuration](#parameter-configuration)
- [Naming Conventions](#naming-conventions)
- [Deployment](#deployment)

## Overview

### What's Deployed

The infrastructure provisions:

- **Virtual Network** (10.20.0.0/16) with three isolated subnets
- **Network Security Groups** controlling traffic between components
- **MySQL Flexible Server** (8.0.21) with private networking only
- **Azure Key Vault** with private endpoint access
- **Two App Service Web Apps** (Auth API and Data API) with managed identities
- **Static Web App** for frontend hosting
- **Private DNS Zones** for MySQL and Key Vault name resolution
- **RBAC assignments** granting App Services Key Vault Secrets User role

### How main.bicep Orchestrates Modules

The `main.bicep` template acts as the orchestrator, instantiating modules in a specific dependency order. Each module declares parameters and returns outputs that feed into dependent modules.

#### Deployment Order and Dependencies

```
1. nsg
   └─ Outputs: appNsgId, mysqlNsgId, privateEndpointNsgId
      │
2. network (depends on nsg outputs)
   └─ Inputs: appNsgId, mysqlNsgId, privateEndpointNsgId
   └─ Outputs: vnetId, mysqlSubnetId, appserviceSubnetId, privateEndpointSubnetId
      │
3. privatedns (depends on network.vnetId)
   └─ Inputs: vnetId
   └─ Outputs: PrivateDnsZonemysqlId, privateDnsZoneKeyVaultId
      │
4. mysql (depends on network.mysqlSubnetId, privatedns.PrivateDnsZonemysqlId)
   └─ Inputs: mysqlSubnetId, privateDnsZoneMysqlId
   │
5. keyvault (depends on network.privateEndpointSubnetId, privatedns.privateDnsZoneKeyVaultId)
   └─ Inputs: privateEndpointSubnetId, privateDnsZoneKeyVaultId
   └─ Outputs: keyVaultName
   │
6. appservice (depends on network.appserviceSubnetId)
   └─ Inputs: appServiceSubnetId
   └─ Outputs: authApiPrincipalId, dataApiPrincipalId
   │
7. rbac (depends on keyvault.keyVaultName, appservice managed identity outputs)
   └─ Inputs: keyVaultName, authApiPrincipalId, dataApiPrincipalId
   
8. staticwebapp (independent, no dependencies)
```

**Key Dependency Rules:**
- NSGs must exist before creating subnets (subnet creation references NSG IDs)
- VNet must exist before creating private DNS zone VNet links
- Private DNS zones must exist before deploying MySQL and Key Vault with private endpoints
- App Service managed identities must exist before assigning RBAC roles
- Static Web App is independent and can deploy in parallel

#### Output-to-Input Wiring Examples

| Source Module | Output | Target Module | Input Parameter |
|--------------|---------|---------------|----------------|
| `nsg` | `appNsgId` | `network` | `appNsgId` |
| `nsg` | `mysqlNsgId` | `network` | `mysqlNsgId` |
| `nsg` | `privateEndpointNsgId` | `network` | `privateEndpointNsgId` |
| `network` | `vnetId` | `privatedns` | `vnetId` |
| `network` | `mysqlSubnetId` | `mysql` | `mysqlSubnetId` |
| `network` | `privateEndpointSubnetId` | `keyvault` | `privateEndpointSubnetId` |
| `network` | `appserviceSubnetId` | `appservice` | `appServiceSubnetId` |
| `privatedns` | `PrivateDnsZonemysqlId` | `mysql` | `privateDnsZoneMysqlId` |
| `privatedns` | `privateDnsZoneKeyVaultId` | `keyvault` | `privateDnsZoneKeyVaultId` |
| `keyvault` | `keyVaultName` | `rbac` | `keyVaultName` |
| `appservice` | `authApiPrincipalId` | `rbac` | `authApiPrincipalId` |
| `appservice` | `dataApiPrincipalId` | `rbac` | `dataApiPrincipalId` |

## Module Reference

---

### network.bicep

**Purpose**: Creates the Azure Virtual Network with three subnets, each configured with appropriate delegations and Network Security Group associations.

#### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `workloadName` | string | Yes | Workload name for resource naming |
| `environment` | string | Yes | Deployment environment (dev, prod) |
| `instance` | string | Yes | Resource instance number |
| `location` | string | Yes | Azure region for deployment |
| `tags` | object | Yes | Common resource tags |
| `vnetAddressPrefix` | string | Yes | VNet address space (e.g., 10.20.0.0/16) |
| `appServiceSubnetPrefix` | string | Yes | App Service integration subnet CIDR |
| `mysqlSubnetPrefix` | string | Yes | MySQL delegated subnet CIDR |
| `privateEndpointSubnetPrefix` | string | Yes | Private Endpoint subnet CIDR |
| `appNsgId` | string | Yes | NSG resource ID for App Service subnet |
| `mysqlNsgId` | string | Yes | NSG resource ID for MySQL subnet |
| `privateEndpointNsgId` | string | Yes | NSG resource ID for Private Endpoint subnet |

#### Outputs

| Output | Type | Description |
|--------|------|-------------|
| `vnetId` | string | Virtual Network resource ID |
| `vnetName` | string | Virtual Network name |
| `mysqlSubnetId` | string | MySQL subnet resource ID |
| `appserviceSubnetId` | string | App Service integration subnet resource ID |
| `privateEndpointSubnetId` | string | Private Endpoint subnet resource ID |

#### Notable Design Choices

- **Subnet Delegation**: 
  - App Service subnet delegated to `Microsoft.Web/serverFarms` (required for VNet integration)
  - MySQL subnet delegated to `Microsoft.DBforMySQL/flexibleServers` (required for MySQL deployment into VNet)
- **Private Endpoint Policies**: Enabled on the Private Endpoint subnet (`privateEndpointNetworkPolicies: 'Enabled'`)
- **Subnet Naming**: Fixed names (`snet-appservice-integration`, `snet-mysql`, `snet-private-endpoints`) ensure consistent references
- **NSG Association**: Each subnet is associated with its NSG at creation time
- **API Version**: Uses `Microsoft.Network/virtualNetworks@2023-02-01`

---

### nsg.bicep

**Purpose**: Defines Network Security Groups with least-privilege security rules to control traffic flow between infrastructure components.

#### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `workloadName` | string | Yes | Workload name for NSG naming |
| `environment` | string | Yes | Deployment environment (dev, prod) |
| `instance` | string | Yes | Resource instance number |
| `location` | string | Yes | Azure region for NSG deployment |
| `tags` | object | Yes | Common resource tags |
| `appServiceSubnetPrefix` | string | Yes | App Service subnet CIDR (for source/dest address rules) |
| `mysqlSubnetPrefix` | string | Yes | MySQL subnet CIDR (for source/dest address rules) |
| `privateEndpointSubnetPrefix` | string | Yes | Private Endpoint subnet CIDR (for source/dest address rules) |

#### Outputs

| Output | Type | Description |
|--------|------|-------------|
| `appNsgId` | string | App Service NSG resource ID |
| `mysqlNsgId` | string | MySQL NSG resource ID |
| `privateEndpointNsgId` | string | Private Endpoint NSG resource ID |

#### Notable Design Choices

**App Service NSG (`nsg-{workloadName}-{environment}-{instance}`):**
- **Allow MySQL Outbound** (Priority 100): Permits TCP 3306 from App Service subnet to MySQL subnet
- **Allow Private Endpoint HTTPS Outbound** (Priority 110): Permits TCP 443 from App Service subnet to Private Endpoint subnet (for Key Vault access)
- **Deny Other VNet Outbound** (Priority 4000): Blocks all other VNet-scoped outbound traffic (allows internet by default)

**MySQL NSG (`nsg-mysql-{workloadName}-{environment}-{instance}`):**
- **Allow App Service Inbound** (Priority 100): Permits TCP 3306 from App Service subnet
- **Allow MySQL Self Inbound** (Priority 110): Permits TCP 3306 within MySQL subnet (for HA/replication)
- **Deny Other VNet MySQL Inbound** (Priority 4000): Blocks all other VNet sources from accessing MySQL port

**Private Endpoint NSG (`nsg-privateendpoint-{workloadName}-{environment}-{instance}`):**
- **Allow App Service HTTPS Inbound** (Priority 100): Permits TCP 443 from App Service subnet (for Key Vault private endpoint access)

**Security Posture**: Implements zero-trust networking with explicit allow rules and implicit deny for VNet traffic. Internet-bound traffic is allowed by default (Azure NSG behavior) unless explicitly denied.

---

### privatedns.bicep

**Purpose**: Provisions Azure Private DNS Zones for MySQL and Key Vault, linked to the VNet to enable private endpoint name resolution.

#### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `workloadName` | string | Yes | Workload name for DNS zone naming |
| `environment` | string | Yes | Deployment environment (dev, prod) |
| `tags` | object | Yes | Common resource tags |
| `vnetId` | string | Yes | Virtual Network resource ID for VNet link |

#### Outputs

| Output | Type | Description |
|--------|------|-------------|
| `PrivateDnsZonemysqlId` | string | MySQL Private DNS Zone resource ID |
| `privateDnsZoneName` | string | MySQL Private DNS Zone name |
| `privateDnsZoneKeyVaultId` | string | Key Vault Private DNS Zone resource ID |
| `privateDnsZoneKeyVaultName` | string | Key Vault Private DNS Zone name |

#### Notable Design Choices

- **MySQL DNS Zone Naming**: `{workloadName}-{environment}.private.mysql.database.azure.com` (workload-scoped, not using standard `privatelink.mysql.database.azure.com`)
- **Key Vault DNS Zone Naming**: `privatelink.vaultcore.azure.net` (standard Azure private link DNS zone)
- **Location**: `global` (Private DNS Zones are global resources)
- **Auto-Registration**: Disabled (`registrationEnabled: false`) - DNS records are managed by private endpoint creation, not VM registration
- **VNet Link Naming**: `link-{workloadName}-{environment}-vnet` for traceability
- **API Version**: Uses `Microsoft.Network/privateDnsZones@2024-06-01`

---

### mysql.bicep

**Purpose**: Deploys Azure Database for MySQL Flexible Server with private networking, no public access, and integrated backup/HA configuration.

#### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `workloadName` | string | Yes | Workload name for MySQL server naming |
| `environment` | string | Yes | Deployment environment (dev, prod) |
| `instance` | string | Yes | Resource instance number |
| `location` | string | Yes | Azure region for MySQL deployment |
| `tags` | object | Yes | Common resource tags |
| `mysqlSubnetId` | string | Yes | Delegated subnet resource ID for MySQL |
| `privateDnsZoneMysqlId` | string | Yes | Private DNS Zone resource ID for MySQL |
| `mysqlAdminUsername` | string | Yes | MySQL administrator login name |
| `mysqlAdminPassword` | string (secure) | Yes | MySQL administrator password (marked @secure) |
| `mysqlSkuName` | string | Yes | MySQL SKU name (e.g., Standard_B1ms, Standard_D2ds_v4) |
| `mysqlSkuTier` | string | Yes | MySQL SKU tier (Burstable, GeneralPurpose, MemoryOptimized) |
| `mysqlVersion` | string | Yes | MySQL version (e.g., 8.0.21) |
| `storageSizeGB` | int | Yes | Storage size in GB |
| `backupRetentionDays` | int | Yes | Backup retention period in days (7-35) |
| `highAvailabilityMode` | string | Yes | HA mode (Disabled, ZoneRedundant, SameZone) |

#### Outputs

| Output | Type | Description |
|--------|------|-------------|
| `mysqlServerId` | string | MySQL Flexible Server resource ID |
| `mysqlServerName` | string | MySQL Flexible Server name |
| `mysqlFqdn` | string | MySQL server fully qualified domain name (private) |

#### Notable Design Choices

- **Public Network Access**: Explicitly disabled (`publicNetworkAccess: 'Disabled'`)
- **Private Networking**: Server deployed into delegated subnet with private DNS integration
- **Backup**: Geo-redundant backup disabled (single-region); retention configurable via parameter
- **Storage**: Auto-grow enabled, auto-IO scaling disabled (cost control)
- **High Availability**: Configurable via parameter (prod default: Disabled for cost)
- **Server Naming**: `mysql-{workloadName}-{environment}-{instance}`
- **API Version**: Uses `Microsoft.DBforMySQL/flexibleServers@2024-12-30`

**Security**: No public endpoint, all access via private networking. Admin credentials passed securely using `@secure()` decorator.

---

### keyvault.bicep

**Purpose**: Deploys Azure Key Vault with RBAC authorization, private endpoint connectivity, and soft delete protection.

#### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `workloadName` | string | Yes | Workload name for Key Vault naming |
| `environment` | string | Yes | Deployment environment (dev, prod) |
| `instance` | string | Yes | Resource instance number |
| `location` | string | Yes | Azure region for Key Vault deployment |
| `tags` | object | Yes | Common resource tags |
| `privateEndpointSubnetId` | string | Yes | Subnet resource ID for private endpoint |
| `privateDnsZoneKeyVaultId` | string | Yes | Private DNS Zone resource ID for Key Vault |

#### Outputs

| Output | Type | Description |
|--------|------|-------------|
| `keyVaultId` | string | Key Vault resource ID |
| `keyVaultName` | string | Key Vault name |
| `keyVaultUri` | string | Key Vault URI (https://...) |
| `keyVaultPrivateEndpointId` | string | Private Endpoint resource ID |

#### Notable Design Choices

- **Authorization Model**: RBAC enabled (`enableRbacAuthorization: true`), access policies empty (modern approach)
- **Public Network Access**: Disabled (`publicNetworkAccess: 'Disabled'`)
- **Soft Delete**: Enabled with 90-day retention (`enableSoftDelete: true`, `softDeleteRetentionInDays: 90`)
- **Private Endpoint**: 
  - Deployed in dedicated Private Endpoint subnet
  - Connection auto-approved (`status: 'Approved'`)
  - Integrated with `privatelink.vaultcore.azure.net` DNS zone via DNS zone group
  - Group ID: `vault` (Key Vault private link service)
- **SKU**: Standard (Family A)
- **Naming**: 
  - Key Vault: `kv-{workloadName}-{environment}-{instance}`
  - Private Endpoint: `pe-{workloadName}-{environment}-{instance}-kv`
- **API Versions**: Key Vault `@2024-11-01`, Private Endpoint `@2024-05-01`

**Security**: Zero public access, all connectivity via private link. RBAC-based access control (no legacy access policies). Soft delete protection prevents accidental data loss.

---

### appservice.bicep

**Purpose**: Deploys an Azure App Service Plan and two Linux-based web apps (Auth API and Data API) with VNet integration, managed identities, and security hardening.

#### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `workloadName` | string | Yes | Workload name for App Service naming |
| `environment` | string | Yes | Deployment environment (dev, prod) |
| `instance` | string | Yes | Resource instance number |
| `location` | string | Yes | Azure region for App Service deployment |
| `tags` | object | Yes | Common resource tags |
| `appServiceSkuName` | string | Yes | App Service Plan SKU name (e.g., P0v3, P1v3) |
| `appServiceSkuTier` | string | Yes | App Service Plan tier (e.g., PremiumV3) |
| `linuxFxVersion` | string | Yes | Linux runtime stack (e.g., DOTNETCORE\|10.0, PYTHON\|3.11) |
| `appServiceSubnetId` | string | Yes | App Service integration subnet resource ID |

#### Outputs

| Output | Type | Description |
|--------|------|-------------|
| `appServicePlanId` | string | App Service Plan resource ID |
| `appServicePlanName` | string | App Service Plan name |
| `authApiId` | string | Auth API Web App resource ID |
| `authApiName` | string | Auth API Web App name |
| `authApiHostname` | string | Auth API default hostname |
| `dataApiId` | string | Data API Web App resource ID |
| `dataApiName` | string | Data API Web App name |
| `dataApiHostname` | string | Data API default hostname |
| `authApiPrincipalId` | string | Auth API managed identity principal ID |
| `dataApiPrincipalId` | string | Data API managed identity principal ID |

#### Notable Design Choices

**App Service Plan:**
- **Platform**: Linux (`kind: 'linux'`, `reserved: true`)
- **Scaling**: Per-site scaling disabled, zone redundancy disabled (cost optimization)
- **Naming**: `asp-{workloadName}-{environment}-{instance}`

**Web Apps (Auth API and Data API):**
- **Managed Identity**: System-assigned identity enabled for both apps (used for Key Vault access)
- **Public Access**: Enabled (`publicNetworkAccess: 'Enabled'`) - apps are accessible from internet
- **VNet Integration**: Regional VNet integration configured via `networkConfig` (allows outbound private connectivity to MySQL and Key Vault)
- **Route All Traffic**: Disabled (`vnetRouteAllEnabled: false`) - only private address space routed through VNet
- **Security Settings**:
  - HTTPS only: `httpsOnly: true`
  - FTPS: Disabled (`ftpsState: 'Disabled'`)
  - TLS: Minimum 1.2 for both runtime and SCM
  - Basic publishing credentials: Disabled for both FTP and SCM (prevents username/password deployment)
- **Performance**:
  - Always On: Enabled
  - HTTP/2: Enabled
  - Client affinity: Disabled (stateless apps)
- **Configuration**:
  - Environment: `ASPNETCORE_ENVIRONMENT=Production`
- **Naming**:
  - Auth API: `app-{workloadName}-auth-api-{environment}-{instance}`
  - Data API: `app-{workloadName}-data-api-{environment}-{instance}`
- **API Version**: `Microsoft.Web/serverfarms@2024-11-01`, `Microsoft.Web/sites@2024-11-01`

**Security**: Managed identities eliminate credential storage. VNet integration provides secure outbound connectivity to private resources. Publishing credentials disabled to enforce secure deployment methods (GitHub Actions, Azure DevOps).

---

### rbac.bicep

**Purpose**: Assigns Azure RBAC roles to grant App Service managed identities access to Key Vault secrets.

#### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `keyVaultName` | string | Yes | Key Vault name (referenced as existing resource) |
| `authApiPrincipalId` | string | Yes | Auth API managed identity principal ID |
| `dataApiPrincipalId` | string | Yes | Data API managed identity principal ID |

#### Outputs

None

#### Notable Design Choices

- **Role Definition**: Uses Azure built-in role "Key Vault Secrets User" (ID: `4633458b-17de-408a-b874-0445c86b69e6`)
- **Scope**: Role assignments scoped to the specific Key Vault resource (not resource group or subscription)
- **Principal Type**: `ServicePrincipal` (managed identities are treated as service principals in Azure AD)
- **Assignment Naming**: Uses `guid()` function with Key Vault ID, principal ID, and role definition ID to generate deterministic, unique names (prevents conflicts and ensures idempotency)
- **Permissions Granted**: Read secrets only (Get, List). No ability to create, update, or delete secrets or manage Key Vault configuration.
- **API Version**: `Microsoft.Authorization/roleAssignments@2022-04-01`

**Security**: Implements least-privilege access. Each App Service can only read secrets, not manage them. Scoped assignments prevent lateral movement to other Key Vaults.

---

### staticwebapp.bicep

**Purpose**: Provisions Azure Static Web App infrastructure. Repository connection and build configuration are managed separately by the application team.

#### Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `name` | string | Yes | - | Static Web App resource name |
| `location` | string | Yes | - | Azure region (must support Static Web Apps) |
| `skuName` | string | No | `'Free'` | SKU name (Free or Standard) |
| `skuTier` | string | No | `'Free'` | SKU tier (Free or Standard) |
| `tags` | object | Yes | - | Resource tags |

#### Outputs

| Output | Type | Description |
|--------|------|-------------|
| `staticWebAppId` | string | Static Web App resource ID |
| `staticWebAppName` | string | Static Web App name |
| `staticWebAppDefaultHostname` | string | Default hostname (*.azurestaticapps.net) |

#### Notable Design Choices

- **Infrastructure Only**: `repositoryUrl`, `branch`, `repositoryToken`, and `buildProperties` are intentionally omitted. The application repository owns deployment via GitHub Actions or Azure DevOps.
- **Config File Updates**: Allowed (`allowConfigFileUpdates: true`) - permits updating `staticwebapp.config.json` via deployments
- **Staging Environments**: Enabled (`stagingEnvironmentPolicy: 'Enabled'`) - allows pull request preview environments
- **SKU Validation**: `@allowed()` decorator constrains SKU to Free or Standard
- **API Version**: `Microsoft.Web/staticSites@2024-11-01`

**Deployment Model**: Infrastructure provisions the resource; application CI/CD handles content deployment. Deployment token retrieved separately via Azure CLI or portal.

---

### monitoring.bicep

**Purpose**: *(Placeholder - file exists but is empty)*

#### Status

This module file exists in the repository but contains no resources. Monitoring infrastructure is not currently deployed.

**Expected Scope** (not implemented):
- Application Insights for App Service observability
- Log Analytics Workspace for centralized logging
- Diagnostic settings for Key Vault, MySQL, VNet, NSG
- Action Groups and Metric Alerts
- Azure Monitor dashboards

**Impact**: No application telemetry, centralized logs, or alerting is configured. Troubleshooting relies on App Service logs and Azure portal diagnostics.

---

## Parameter Configuration

### Production Environment Parameters

The `environments/prod.bicepparam` file defines production configuration values. It uses the `using` statement to reference `../main.bicep` and sets all required parameters.

| Parameter | Value | Type | Description |
|-----------|-------|------|-------------|
| `environment` | `'prod'` | string | Deployment environment identifier |
| `workloadName` | `'invi'` | string | Workload/application name |
| `instance` | `'001'` | string | Resource instance number |
| `location` | `'swedencentral'` | string | Azure region for main resources |
| `tags.environment` | `'prod'` | string | Environment tag |
| `tags.application` | `'invi'` | string | Application identifier tag |
| `tags.managedBy` | `'bicep'` | string | Management method tag |
| **Network Configuration** |
| `vnetAddressPrefix` | `'10.20.0.0/16'` | string | VNet address space |
| `appServiceSubnetPrefix` | `'10.20.1.0/24'` | string | App Service integration subnet |
| `mysqlSubnetPrefix` | `'10.20.2.0/24'` | string | MySQL delegated subnet |
| `privateEndpointSubnetPrefix` | `'10.20.3.0/24'` | string | Private Endpoint subnet |
| **Database Configuration** |
| `mysqlAdminUsername` | `'inviadmin'` | string | MySQL administrator login |
| `mysqlAdminPassword` | *`<sensitive>`* | string (secure) | MySQL administrator password |
| `mysqlSkuTier` | `'Burstable'` | string | MySQL compute tier |
| `mysqlSkuName` | `'Standard_B1ms'` | string | MySQL SKU (1 vCore, 2 GiB RAM) |
| `mysqlVersion` | `'8.0.21'` | string | MySQL server version |
| `mysqlStorageSizeGB` | `32` | int | MySQL storage size |
| `mysqlBackupRetentionDays` | `14` | int | Backup retention period |
| `mysqlHighAvailabilityMode` | `'Disabled'` | string | HA configuration |
| **App Service Configuration** |
| `appServiceSkuName` | `'P0v3'` | string | App Service Plan SKU |
| `appServiceSkuTier` | `'PremiumV3'` | string | App Service Plan tier |
| `linuxFxVersion` | `'DOTNETCORE\|10.0'` | string | .NET runtime version |
| **Static Web App Configuration** |
| `staticWebAppName` | `'swa-cetchapp-app-web-prodtest-001'` | string | Static Web App resource name |
| `staticWebAppLocation` | `'eastus2'` | string | SWA region (not available in swedencentral) |
| `staticWebAppSkuName` | `'Free'` | string | Static Web App SKU |
| `staticWebAppSkuTier` | `'Free'` | string | Static Web App tier |
| `staticWebAppTags.project` | `'CetchApp'` | string | Project identifier |
| `staticWebAppTags.environment` | `'prodtest'` | string | SWA environment tag |
| `staticWebAppTags.component` | `'app-web'` | string | Component identifier |
| `staticWebAppTags['managed-by']` | `'bicep'` | string | Management method |

**Security Note**: The `mysqlAdminPassword` parameter contains a sensitive value. In production, this should be:
- Removed from the parameter file
- Passed via CLI override: `--parameters mysqlAdminPassword=<value>`
- Retrieved from Azure Key Vault using a Key Vault reference
- Stored in GitHub Secrets or Azure DevOps secure variables for CI/CD

### How Parameter Files Are Used

Parameter files (`.bicepparam`) are Bicep-native parameter files that reference a template using the `using` statement:

```bicep
using '../main.bicep'

param environment = 'prod'
param workloadName = 'invi'
// ... additional parameters
```

**Benefits over ARM JSON parameter files:**
- Type safety: Parameters are validated against the template at authoring time
- IntelliSense support in VS Code with Bicep extension
- Simplified syntax (no `"parameters"` wrapper, no `"value"` keys)
- References the Bicep template directly, not compiled ARM JSON

**Deployment Usage:**

```bash
az deployment group create \
  --resource-group <rg-name> \
  --template-file Infrastructure/main.bicep \
  --parameters Infrastructure/environments/prod.bicepparam
```

Azure CLI automatically resolves the `using` statement and validates parameter types before deployment.

### Creating Additional Environments

To add a new environment (e.g., dev, staging):

1. Copy the prod parameter file:
   ```bash
   cp environments/prod.bicepparam environments/dev.bicepparam
   ```

2. Update values in the new file:
   - Change `environment = 'dev'`
   - Change `instance = '002'` (or another unique value to avoid naming conflicts)
   - Adjust network CIDR ranges if deploying to the same region
   - Use smaller SKUs for cost optimization (e.g., `Burstable` for MySQL, `B1` for App Service)
   - Update tags to reflect the environment

3. Deploy with the new parameter file:
   ```bash
   az deployment group create \
     --resource-group <dev-rg-name> \
     --template-file Infrastructure/main.bicep \
     --parameters Infrastructure/environments/dev.bicepparam
   ```

## Naming Conventions

All Azure resources follow a consistent naming pattern:

```
{resourceType}-{workloadName}-[component-]{environment}-{instance}
```

**Examples:**

| Resource | Pattern | Production Example |
|----------|---------|-------------------|
| Virtual Network | `vnet-{workloadName}-{environment}-{instance}` | `vnet-invi-prod-001` |
| Network Security Group | `nsg-{workloadName}-{environment}-{instance}` | `nsg-invi-prod-001` |
| NSG (component-specific) | `nsg-{component}-{workloadName}-{environment}-{instance}` | `nsg-mysql-invi-prod-001` |
| MySQL Server | `mysql-{workloadName}-{environment}-{instance}` | `mysql-invi-prod-001` |
| Key Vault | `kv-{workloadName}-{environment}-{instance}` | `kv-invi-prod-001` |
| App Service Plan | `asp-{workloadName}-{environment}-{instance}` | `asp-invi-prod-001` |
| Web App | `app-{workloadName}-{component}-{environment}-{instance}` | `app-invi-auth-api-prod-001` |
| Private Endpoint | `pe-{workloadName}-{environment}-{instance}-{service}` | `pe-invi-prod-001-kv` |
| Static Web App | `swa-{project}-{component}-{environment}-{instance}` | `swa-cetchapp-app-web-prodtest-001` |

**Resource Type Abbreviations** (following Azure Cloud Adoption Framework):
- `vnet`: Virtual Network
- `snet`: Subnet
- `nsg`: Network Security Group
- `asp`: App Service Plan
- `app`: App Service (Web App)
- `mysql`: MySQL Flexible Server
- `kv`: Key Vault
- `pe`: Private Endpoint
- `swa`: Static Web App

### Tagging Strategy

**Standard Tags** (applied to most resources via `tags` parameter):

```bicep
{
  environment: 'prod'       // Deployment environment
  application: 'invi'       // Application/workload identifier
  managedBy: 'bicep'        // IaC tool
}
```

**Static Web App Tags** (separate tag set):

```bicep
{
  project: 'CetchApp'       // Project name
  environment: 'prodtest'   // Environment
  component: 'app-web'      // Application component
  'managed-by': 'bicep'     // IaC tool (kebab-case variant)
}
```

Tags are used for:
- Cost allocation and reporting
- Resource governance and policy application
- Operational identification and grouping
- Automation and lifecycle management

## Deployment

For detailed deployment instructions, prerequisites, and validation steps, refer to the [root README.md](../README.md#deployment-instructions).

**Quick Reference:**

```bash
# Validate
az deployment group validate \
  --resource-group <rg-name> \
  --template-file Infrastructure/main.bicep \
  --parameters Infrastructure/environments/prod.bicepparam

# Deploy
az deployment group create \
  --resource-group <rg-name> \
  --template-file Infrastructure/main.bicep \
  --parameters Infrastructure/environments/prod.bicepparam \
  --name invi-prod-$(date +%Y%m%d-%H%M%S)
```

**Important**: Ensure the resource group exists and you have Contributor or Owner role before deployment. RBAC role assignments require appropriate permissions at the subscription level.

---

## Maintenance

### Regenerating ARM JSON

If you modify any Bicep files, regenerate the compiled ARM template:

```bash
az bicep build --file Infrastructure/main.bicep --outfile Infrastructure/main.json
```

### Linting

Check for best practices and errors:

```bash
az bicep lint --file Infrastructure/main.bicep
```

### Dependency Graph

To visualize module dependencies, use the Bicep Visualizer in VS Code (Bicep extension) or generate a dependency diagram using third-party tools.

---

## Contributing

When modifying this infrastructure:

1. Follow naming conventions documented above
2. Maintain parameter-driven design (no hardcoded values)
3. Test in non-production environments first
4. Use `az deployment group what-if` to preview changes
5. Update this documentation when adding or modifying modules
6. Follow conventions in `.github/copilot-instructions.md`

---

## Support

For infrastructure questions or issues, contact the platform engineering team or open an issue in this repository.
