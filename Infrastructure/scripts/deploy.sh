#!/usr/bin/env bash

set -euo pipefail

echo "======================================"
echo " INVI Azure deployment"
echo "======================================"
echo


# --------------------------------------------------
# Configuration
# --------------------------------------------------


RESOURCE_GROUP="rg-cetchapp-prod-swc-001-test1"
LOCATION="swedencentral"
DEPLOYMENT_NAME="invi-prod-infrastructure-001"
AUTH_APP="app-invi-auth-api-prod-001"
DATA_APP="app-invi-data-api-prod-001"


WEBSITE_CONTRIBUTOR_ROLE_ID="de139f84-1756-47ae-9be6-808fbbe84772"


# --------------------------------------------------
# GitHub deployment identities
# --------------------------------------------------

AUTH_GHA_IDENTITY="id-gha-invi-auth-api-prod-001"
DATA_GHA_IDENTITY="id-gha-invi-data-api-prod-001"






# --------------------------------------------------
# GitHub OIDC federation
# -

AUTH_FIC="fic-gha-invi-auth-api-prod-migration"
DATA_FIC="fic-gha-invi-data-api-prod-migration"

GITHUB_OIDC_ISSUER="https://token.actions.githubusercontent.com"
GITHUB_OIDC_AUDIENCE="api://AzureADTokenExchange"

AUTH_GITHUB_SUBJECT="repo:CetchApp@262199775/cetchapp-auth-api@1171937595:environment:prod-migration"

DATA_GITHUB_SUBJECT="repo:CetchApp@262199775/cetchapp-data-api@1222823213:environment:prod-migration"

echo "Deployment configuration:"
echo "Resource group: $RESOURCE_GROUP"
echo "Location:       $LOCATION"


# --------------------------------------------------
# Step 1 - Pre-flight checks
# --------------------------------------------------

echo
echo "Checking Azure CLI..."

if ! command -v az >/dev/null 2>&1; then
  echo "ERROR: Azure CLI is not installed."
  exit 1
fi

echo "Azure CLI found."


echo
echo "Checking Azure login..."

if ! az account show >/dev/null 2>&1; then
  echo "ERROR: You are not logged in to Azure."
  echo "Run: az login"
  exit 1
fi

echo "Azure login OK."


echo
echo "Current Azure subscription:"

az account show \
  --query "{Name:name, SubscriptionId:id}" \
  --output table


echo
echo "Step 1 completed successfully."


# --------------------------------------------------
# Step 2 - Validate local IaC files
# --------------------------------------------------

echo
echo "======================================"
echo " Step 2 - Validate local IaC files"
echo "======================================"
echo

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

BICEP_FILE="$PROJECT_ROOT/main.bicep"
PARAM_FILE="$PROJECT_ROOT/environments/prod.bicepparam"


echo "Checking main Bicep file..."

if [[ ! -f "$BICEP_FILE" ]]; then
  echo "ERROR: Bicep file not found:"
  echo "$BICEP_FILE"
  exit 1
fi

echo "Bicep file found."


echo
echo "Checking parameter file..."

if [[ ! -f "$PARAM_FILE" ]]; then
  echo "ERROR: Parameter file not found:"
  echo "$PARAM_FILE"
  exit 1
fi

echo "Parameter file found."


echo
echo "Building Bicep..."

az bicep build \
  --file "$BICEP_FILE"

echo "Bicep build succeeded."

echo
echo "Step 2 completed successfully."

# --------------------------------------------------
# Step 3 - Validate deployment with Azure
# --------------------------------------------------

echo
echo "======================================"
echo " Step 3 - Azure deployment validation"
echo "======================================"
echo

echo "Validating deployment with Azure Resource Manager..."

if az deployment group validate \
  --resource-group "$RESOURCE_GROUP" \
  --parameters "$PARAM_FILE" \
  --only-show-errors \
  --output none; then

  echo
  echo "Azure deployment validation succeeded."
else
  echo
  echo "ERROR: Azure deployment validation failed."
  exit 1
fi

echo
echo "Step 3 completed successfully."


# --------------------------------------------------
# Step 4 - Preview Azure changes with What-If
# --------------------------------------------------

echo
echo "======================================"
echo " Step 4 - Azure What-If"
echo "======================================"
echo

echo "Previewing proposed infrastructure changes..."
echo

az deployment group what-if \
  --name "$DEPLOYMENT_NAME" \
  --resource-group "$RESOURCE_GROUP" \
  --parameters "$PARAM_FILE" \
  --mode Incremental

echo
echo "What-If completed successfully."
echo
echo "Review the changes above before deployment."
echo
echo "Step 4 completed successfully."


# --------------------------------------------------
# Step 5 - Deploy infrastructure
# --------------------------------------------------

echo
echo "======================================"
echo " Step 5 - Deploy infrastructure"
echo "======================================"
echo

echo "Target resource group: $RESOURCE_GROUP"
echo "Deployment name:       $DEPLOYMENT_NAME"
echo "Deployment mode:       Incremental"
echo

read -r -p "Proceed with deployment? [y/N]: " CONFIRM

case "$CONFIRM" in
  y|Y|yes|YES)
    echo
    echo "Deployment approved."
    ;;
  *)
    echo
    echo "Deployment cancelled."
    exit 0
    ;;
esac

echo
echo "Deploying infrastructure..."
echo

if az deployment group create \
  --name "$DEPLOYMENT_NAME" \
  --resource-group "$RESOURCE_GROUP" \
  --parameters "$PARAM_FILE" \
  --mode Incremental \
  --only-show-errors \
  --output none; then

  echo
  echo "Azure deployment command completed successfully."
else
  echo
  echo "ERROR: Azure deployment failed."
  exit 1
fi

DEPLOYMENT_STATE=$(az deployment group show \
  --name "$DEPLOYMENT_NAME" \
  --resource-group "$RESOURCE_GROUP" \
  --query "properties.provisioningState" \
  --output tsv \
  --only-show-errors)

echo
echo "Deployment state: $DEPLOYMENT_STATE"

if [[ "$DEPLOYMENT_STATE" != "Succeeded" ]]; then
  echo "ERROR: Deployment did not finish in Succeeded state."
  exit 1
fi

echo
echo "Infrastructure deployment succeeded."
echo
echo "Step 5 completed successfully."


# --------------------------------------------------
# Step 6.1 - Verify App Service runtime state
# --------------------------------------------------

echo
echo "======================================"
echo " Step 6.1 - Verify App Services"
echo "======================================"
echo

echo "Checking Auth API state..."

if ! AUTH_APP_STATE=$(az webapp show \
  --resource-group "$RESOURCE_GROUP" \
  --name "$AUTH_APP" \
  --query "state" \
  --output tsv \
  --only-show-errors); then

  echo "ERROR: Could not retrieve Auth API state."
  exit 1
fi

echo "Auth API state: $AUTH_APP_STATE"

if [[ "$AUTH_APP_STATE" != "Running" ]]; then
  echo "ERROR: Auth API is not running."
  exit 1
fi


echo
echo "Checking Data API state..."

if ! DATA_APP_STATE=$(az webapp show \
  --resource-group "$RESOURCE_GROUP" \
  --name "$DATA_APP" \
  --query "state" \
  --output tsv \
  --only-show-errors); then

  echo "ERROR: Could not retrieve Data API state."
  exit 1
fi

echo "Data API state: $DATA_APP_STATE"

if [[ "$DATA_APP_STATE" != "Running" ]]; then
  echo "ERROR: Data API is not running."
  exit 1
fi


echo
echo " App Services are running."
echo
echo "Step 6.1 completed successfully."


# --------------------------------------------------
# Step 7 - Ensure GitHub deployment identities
# --------------------------------------------------

echo
echo "======================================"
echo " Step 7 - GitHub deployment identities"
echo "======================================"
echo


echo "Checking Auth GitHub deployment identity..."

if az identity show \
  --resource-group "$RESOURCE_GROUP" \
  --name "$AUTH_GHA_IDENTITY" \
  --only-show-errors \
  --output none 2>/dev/null; then

  echo "Auth GitHub identity already exists."

else
  echo "Auth GitHub identity does not exist."
  echo "Creating Auth GitHub identity..."

  az identity create \
    --resource-group "$RESOURCE_GROUP" \
    --name "$AUTH_GHA_IDENTITY" \
    --location "$LOCATION" \
    --only-show-errors \
    --output none

  echo "Auth GitHub identity created."
fi


echo
echo "Checking Data GitHub deployment identity..."

if az identity show \
  --resource-group "$RESOURCE_GROUP" \
  --name "$DATA_GHA_IDENTITY" \
  --only-show-errors \
  --output none 2>/dev/null; then

  echo "Data GitHub identity already exists."

else
  echo "Data GitHub identity does not exist."
  echo "Creating Data GitHub identity..."

  az identity create \
    --resource-group "$RESOURCE_GROUP" \
    --name "$DATA_GHA_IDENTITY" \
    --location "$LOCATION" \
    --only-show-errors \
    --output none

  echo "Data GitHub identity created."
fi


echo
echo "Step 7 completed successfully."



# --------------------------------------------------
# Step 8 - Ensure GitHub OIDC federation
# --------------------------------------------------

echo
echo "======================================"
echo " Step 8 - GitHub OIDC federation"
echo "======================================"
echo


echo "Checking Auth API federated credential..."

if az identity federated-credential show \
  --resource-group "$RESOURCE_GROUP" \
  --identity-name "$AUTH_GHA_IDENTITY" \
  --name "$AUTH_FIC" \
  --only-show-errors \
  --output none 2>/dev/null; then

  echo "Auth federated credential already exists."

else
  echo "Auth federated credential does not exist."
  echo "Creating Auth federated credential..."

  az identity federated-credential create \
    --resource-group "$RESOURCE_GROUP" \
    --identity-name "$AUTH_GHA_IDENTITY" \
    --name "$AUTH_FIC" \
    --issuer "$GITHUB_OIDC_ISSUER" \
    --subject "$AUTH_GITHUB_SUBJECT" \
    --audiences "$GITHUB_OIDC_AUDIENCE" \
    --only-show-errors \
    --output none

  echo "Auth federated credential created."
fi
CURRENT_AUTH_SUBJECT=$(az identity federated-credential show \
  --resource-group "$RESOURCE_GROUP" \
  --identity-name "$AUTH_GHA_IDENTITY" \
  --name "$AUTH_FIC" \
  --query "subject" \
  --output tsv \
  --only-show-errors)

if [[ "$CURRENT_AUTH_SUBJECT" != "$AUTH_GITHUB_SUBJECT" ]]; then
  echo "ERROR: Auth federated credential subject does not match expected configuration."
  echo "Expected: $AUTH_GITHUB_SUBJECT"
  echo "Actual:   $CURRENT_AUTH_SUBJECT"
  exit 1
fi

echo "Auth federated credential subject verified."



echo
echo "Checking Data API federated credential..."

if az identity federated-credential show \
  --resource-group "$RESOURCE_GROUP" \
  --identity-name "$DATA_GHA_IDENTITY" \
  --name "$DATA_FIC" \
  --only-show-errors \
  --output none 2>/dev/null; then

  echo "Data federated credential already exists."

else
  echo "Data federated credential does not exist."
  echo "Creating Data federated credential..."

  az identity federated-credential create \
    --resource-group "$RESOURCE_GROUP" \
    --identity-name "$DATA_GHA_IDENTITY" \
    --name "$DATA_FIC" \
    --issuer "$GITHUB_OIDC_ISSUER" \
    --subject "$DATA_GITHUB_SUBJECT" \
    --audiences "$GITHUB_OIDC_AUDIENCE" \
    --only-show-errors \
    --output none

  echo "Data federated credential created."
fi
CURRENT_DATA_SUBJECT=$(az identity federated-credential show \
  --resource-group "$RESOURCE_GROUP" \
  --identity-name "$DATA_GHA_IDENTITY" \
  --name "$DATA_FIC" \
  --query "subject" \
  --output tsv \
  --only-show-errors)

if [[ "$CURRENT_DATA_SUBJECT" != "$DATA_GITHUB_SUBJECT" ]]; then
  echo "ERROR: Data federated credential subject does not match expected configuration."
  echo "Expected: $DATA_GITHUB_SUBJECT"
  echo "Actual:   $CURRENT_DATA_SUBJECT"
  exit 1
fi

echo "Data federated credential subject verified."

echo
echo "Step 8 completed successfully."

# --------------------------------------------------
# Step 9 - Ensure GitHub deployment RBAC
# --------------------------------------------------

echo
echo "======================================"
echo " Step 9 - GitHub deployment RBAC"
echo "======================================"
echo


# --------------------------------------------------
# Auth API RBAC
# --------------------------------------------------

echo "Retrieving Auth deployment identity principal ID..."

AUTH_PRINCIPAL_ID=$(az identity show \
  --resource-group "$RESOURCE_GROUP" \
  --name "$AUTH_GHA_IDENTITY" \
  --query "principalId" \
  --output tsv \
  --only-show-errors)

echo "Retrieving Auth App Service resource ID..."

AUTH_APP_ID=$(az webapp show \
  --resource-group "$RESOURCE_GROUP" \
  --name "$AUTH_APP" \
  --query "id" \
  --output tsv \
  --only-show-errors)


echo "Checking Auth Website Contributor assignment..."

AUTH_ROLE_COUNT=$(az role assignment list \
  --assignee-object-id "$AUTH_PRINCIPAL_ID" \
  --role "$WEBSITE_CONTRIBUTOR_ROLE_ID" \
  --scope "$AUTH_APP_ID" \
  --fill-principal-name false \
  --query "length(@)" \
  --output tsv \
  --only-show-errors)

if [[ "$AUTH_ROLE_COUNT" -eq 0 ]]; then
  echo "Auth Website Contributor assignment does not exist."
  echo "Creating assignment..."

  az role assignment create \
    --assignee-object-id "$AUTH_PRINCIPAL_ID" \
    --assignee-principal-type ServicePrincipal \
    --role "$WEBSITE_CONTRIBUTOR_ROLE_ID" \
    --scope "$AUTH_APP_ID" \
    --only-show-errors \
    --output none

  echo "Auth Website Contributor assignment created."
else
  echo "Auth Website Contributor assignment already exists."
fi


# --------------------------------------------------
# Data API RBAC
# --------------------------------------------------

echo
echo "Retrieving Data deployment identity principal ID..."

DATA_PRINCIPAL_ID=$(az identity show \
  --resource-group "$RESOURCE_GROUP" \
  --name "$DATA_GHA_IDENTITY" \
  --query "principalId" \
  --output tsv \
  --only-show-errors)

echo "Retrieving Data App Service resource ID..."

DATA_APP_ID=$(az webapp show \
  --resource-group "$RESOURCE_GROUP" \
  --name "$DATA_APP" \
  --query "id" \
  --output tsv \
  --only-show-errors)


echo "Checking Data Website Contributor assignment..."


DATA_ROLE_COUNT=$(az role assignment list \
  --assignee-object-id "$DATA_PRINCIPAL_ID" \
  --role "$WEBSITE_CONTRIBUTOR_ROLE_ID" \
  --scope "$DATA_APP_ID" \
  --fill-principal-name false \
  --query "length(@)" \
  --output tsv \
  --only-show-errors)


if [[ "$DATA_ROLE_COUNT" -eq 0 ]]; then
  echo "Data Website Contributor assignment does not exist."
  echo "Creating assignment..."

  az role assignment create \
    --assignee-object-id "$DATA_PRINCIPAL_ID" \
    --assignee-principal-type ServicePrincipal \
    --role "$WEBSITE_CONTRIBUTOR_ROLE_ID" \
    --scope "$DATA_APP_ID" \
    --only-show-errors \
    --output none

  echo "Data Website Contributor assignment created."
else
  echo "Data Website Contributor assignment already exists."
fi


echo
echo "Step 9 completed successfully."
