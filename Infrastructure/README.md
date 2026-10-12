# Infrastructure

This directory contains the Bicep infrastructure-as-code for the Invi application, deployed on Azure.

## Structure

- `main.bicep` - Main orchestration template that deploys all resources
- `modules/` - Reusable Bicep modules for each resource type
- `environments/` - Environment-specific parameter files
- `scripts/` - Deployment and management scripts

## Resources

The infrastructure includes:

- **Networking**: VNet with subnets for App Services, MySQL, and private endpoints
- **App Services**: Auth API and Data API on Linux App Service Plan (P0v3)
- **MySQL**: Flexible Server with private networking
- **Key Vault**: For secrets management with private endpoint
- **Application Insights**: For monitoring and telemetry
- **Private DNS Zones**: For private endpoint DNS resolution

## Deployment Slots

The Data API (`app-invi-data-api-prod-001`) supports a staging deployment slot for zero-downtime deployments.

### Deploying to Staging

Deploy your application to the staging slot:

```bash
az webapp deploy \
  --resource-group rg-invi-prod-001 \
  --name app-invi-data-api-prod-001 \
  --slot staging \
  --src-path <your-deployment-package> \
  --type <deployment-type>
```

Test the staging slot at: `https://app-invi-data-api-prod-001-staging.azurewebsites.net`

### Swapping Slots

After verifying the staging deployment, swap it into production:

```bash
az webapp deployment slot swap \
  --resource-group rg-invi-prod-001 \
  --name app-invi-data-api-prod-001 \
  --slot staging \
  --target-slot production
```

This operation is near-instantaneous and atomic. The staging slot becomes production, and the old production moves to staging.

### Rollback

If issues are discovered after a swap, roll back by swapping again:

```bash
az webapp deployment slot swap \
  --resource-group rg-invi-prod-001 \
  --name app-invi-data-api-prod-001 \
  --slot staging \
  --target-slot production
```

### Important Considerations

- **Shared Database**: Both slots connect to the same MySQL database (`mysql-invi-prod-001`). Database migrations must be backward-compatible with both the current production and new staging versions.
- **Slot-Sticky Settings**: The following settings stay with their slot during a swap and do not move:
  - `ASPNETCORE_ENVIRONMENT` (Production vs Staging)
  - Application Insights connection string and related settings
- **Managed Identity**: Each slot has its own managed identity with separate RBAC assignments to Key Vault.
- **VNet Integration**: Both slots use the same VNet integration and routing configuration.

## Security

The APIs use:

- System-assigned managed identities for Azure resource access
- VNet integration with Route All enabled for outbound traffic
- HTTPS only with TLS 1.2 minimum
- FTP and basic publishing credentials disabled
- Private Key Vault access (Key Vault references do NOT resolve; APIs read secrets via `KeyVault__Uri`)
- Private MySQL with no public access

## Key Vault Access

The APIs read secrets directly from Key Vault at runtime using their managed identities. They have the "Key Vault Secrets User" role assigned at the vault scope in `modules/rbac.bicep`.

App Service's built-in `@Microsoft.KeyVault(...)` reference resolution is **not used** because the Key Vault is private. Instead, the `KeyVault__Uri` app setting points each API to the vault, and the application code loads secrets using Azure.Identity.

## Deployment

Deploy with Azure CLI:

```bash
# Set required environment variables
export MYSQL_ADMIN_PASSWORD="<password>"
export REVENUECAT_SECRET_API_KEY="<api-key>"
export REVENUECAT_WEBHOOK_AUTHORIZATION="<authorization>"

# Deploy infrastructure
az deployment group create \
  --resource-group rg-invi-prod-001 \
  --template-file main.bicep \
  --parameters environments/prod.bicepparam
```

## Validation

Before deploying, validate the Bicep templates:

```bash
# Build and validate main template
bicep build main.bicep

# Run what-if to preview changes
az deployment group what-if \
  --resource-group rg-invi-prod-001 \
  --template-file main.bicep \
  --parameters environments/prod.bicepparam
```
