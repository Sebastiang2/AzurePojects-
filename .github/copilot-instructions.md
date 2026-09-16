# Copilot instructions for this Bicep repo

## Repo shape
- The deployment entrypoint is `main.bicep` in the repo root.
- Reusable Azure resources live under `modules/` and are intended to be composed from the root template.
- Environment-specific configuration is stored in `environmnets/` (note the lowercase `environmnets` directory name and the file naming pattern such as `Prod.Bicepparam`).

## Bicep conventions in this repo
- Prefer parameter-driven modules over hardcoded values.
- Use the environment parameter file as the source of truth for deploy-time values, for example:
  - `environment = 'prod'`
  - `workloadName = 'invi'`
  - `instance = '001'`
  - `location = 'swedencentral'`
- Tags are standardized in the parameter file and should be kept consistent across resources, e.g. `environment`, `workloadName`, and `mangeedBy`.
- VNet and subnet ranges are already modeled as parameters in the environment file; reuse them instead of introducing new CIDR values unless the topology changes intentionally.

## Parameter pattern to preserve
The current production parameter file shows this pattern:

```bicep
using '../main.bicep'

param environment = 'prod'
param workloadName = 'invi'
param instance = '001'
param location = 'swedencentral'
param tags = {
  environment: environment
  workloadName: workloadName
  mangeedBy: 'bicep'
}

param vnetAddressPrefix = '10.20.0.0/16'
param appServiceSubnetPrefix = '10.20.1.0/24'
param mysqlSubnetPrefix = '10.20.2.0/24'
param privateEndpointSubnetPrefix = '10.20.3.0/24'
```

Follow this naming and parameter structure when adding or modifying environment files.

## Deployment workflow
- Validate Bicep syntax before deployment with the Azure CLI or `az bicep build`.
- Deploy with a parameter file, for example:

```bash
az deployment group create \
  --resource-group <rg-name> \
  --template-file main.bicep \
  --parameters @environmnets/Prod.Bicepparam
```

## Important repo-specific notes
- The repo appears to be organized around a single production environment config plus modular Azure services, rather than a multi-environment abstraction layer.
- When adding resources, keep module boundaries explicit and ensure they are configured through parameters from the environment file.
- For network changes, keep CIDR ranges aligned with the existing `vnetAddressPrefix` / subnet prefixes.
- Be careful with naming: `environmnets` is misspelled in the repo path and `mangeedBy` is currently spelled that way in the tags object; preserve existing conventions unless the team explicitly changes them.
