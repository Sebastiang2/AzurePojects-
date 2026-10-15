#!/usr/bin/env bash
# Read-only collection of the production state the safety gate compares against.
#
#   collect-live.sh <outDir> <subscriptionId> <resourceGroup> <app-name>...
#
# Only list/show/get operations are used (az ... show|list, az rest --method get). Output is stored as JSON in <outDir>
# and every call is logged in <outDir>/calls.json with its exit code, so that a call that failed (missing permission,
# throttling, outage) is visible to the gate as missing evidence and never as "nothing there".
#
# Secret handling: app settings and connection strings are piped straight into a sanitizer and never touch disk raw;
# other listings pass through strip-sensitive.mjs. Key Vault secrets are never read, not even their names.
set -u
export MSYS_NO_PATHCONV=1

OUT="${1:?usage: collect-live.sh <outDir> <subscriptionId> <resourceGroup> <app>...}"
SUB="${2:?subscription id}"
RG="${3:?resource group}"
shift 3
APPS=("$@")

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Node is a native Windows program under Git Bash: it needs C:/... paths, not /c/...
if command -v cygpath >/dev/null 2>&1; then HERE_NODE="$(cygpath -m "$HERE")"; else HERE_NODE="$HERE"; fi
SANITIZE="$HERE_NODE/sanitize-appsettings.mjs"
STRIP="$HERE_NODE/strip-sensitive.mjs"

mkdir -p "$OUT/apps"
CALLS="$OUT/.calls.tsv"
: >"$CALLS"

az() { command az "$@" --only-show-errors; }

# Node is a native Windows program under Git Bash and needs C:/... paths.
native() { if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s' "$1"; fi; }

record() { printf '%s\t%s\n' "$1" "$2" >>"$CALLS"; }

# call <name> <command...>  : stdout -> <name>.json
call() {
  local name="$1"; shift
  "$@" >"$OUT/$name.json" 2>"$OUT/$name.err"
  record "$name" "$?"
}

# call_stripped <name> <command...> : stdout -> strip-sensitive -> <name>.json
call_stripped() {
  local name="$1"; shift
  "$@" 2>"$OUT/$name.err" | node "$STRIP" >"$OUT/$name.json"
  local rc=("${PIPESTATUS[@]}")
  if [ "${rc[0]}" -ne 0 ]; then record "$name" "${rc[0]}"; else record "$name" "${rc[1]}"; fi
}

# call_bag <name> <command...> : stdout -> sanitize-appsettings -> <name>.json (names, kinds, non-secret values only)
call_bag() {
  local name="$1"; shift
  "$@" 2>"$OUT/$name.err" | node "$SANITIZE" >"$OUT/$name.json"
  local rc=("${PIPESTATUS[@]}")
  if [ "${rc[0]}" -ne 0 ]; then record "$name" "${rc[0]}"; else record "$name" "${rc[1]}"; fi
}

REST="https://management.azure.com/subscriptions/$SUB/resourceGroups/$RG/providers"
STARTED="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

call account                az account show --subscription "$SUB" -o json
call resources              az resource list --subscription "$SUB" -o json

for app in "${APPS[@]}"; do
  site="$REST/Microsoft.Web/sites/$app"
  call         "apps/$app.show"                   az webapp show -g "$RG" -n "$app" --subscription "$SUB" -o json
  call_stripped "apps/$app.config"                az webapp config show -g "$RG" -n "$app" --subscription "$SUB" -o json
  call_bag     "apps/$app.appsettings"            az webapp config appsettings list -g "$RG" -n "$app" --subscription "$SUB" -o json
  call         "apps/$app.kvrefs"                 az rest --method get --url "$site/config/configreferences/appsettings?api-version=2022-03-01" -o json
  call         "apps/$app.slots"                  az webapp deployment slot list -g "$RG" -n "$app" --subscription "$SUB" -o json
  call         "apps/$app.slotconfignames"        az rest --method get --url "$site/config/slotConfigNames?api-version=2024-04-01" -o json
  call         "apps/$app.accessrestrictions"     az webapp config access-restriction show -g "$RG" -n "$app" --subscription "$SUB" -o json
  call         "apps/$app.publishpolicy.ftp"      az rest --method get --url "$site/basicPublishingCredentialsPolicies/ftp?api-version=2024-04-01" -o json
  call         "apps/$app.publishpolicy.scm"      az rest --method get --url "$site/basicPublishingCredentialsPolicies/scm?api-version=2024-04-01" -o json
  call         "apps/$app.hostnamebindings"       az rest --method get --url "$site/hostNameBindings?api-version=2024-04-01" -o json
  call         "apps/$app.networkconfig"          az rest --method get --url "$site/config/virtualNetwork?api-version=2024-04-01" -o json
  call_stripped "apps/$app.authsettingsv2"        az rest --method get --url "$site/config/authsettingsV2?api-version=2024-04-01" -o json
  call         "apps/$app.diag"                   az monitor diagnostic-settings list --resource "/subscriptions/$SUB/resourceGroups/$RG/providers/Microsoft.Web/sites/$app" -o json
done

call         plan                  az appservice plan show -g "$RG" -n asp-invi-prod-001 --subscription "$SUB" -o json
call_stripped certs-detail         az rest --method get --url "$REST/Microsoft.Web/certificates?api-version=2024-04-01" -o json

call         vnet                  az network vnet show -g "$RG" -n vnet-invi-prod-001 --subscription "$SUB" -o json
call         subnets               az network vnet subnet list -g "$RG" --vnet-name vnet-invi-prod-001 --subscription "$SUB" -o json
call         nsgs                  az network nsg list -g "$RG" --subscription "$SUB" -o json
call         private-endpoints     az network private-endpoint list -g "$RG" --subscription "$SUB" -o json
call         private-dns-zones     az network private-dns zone list -g "$RG" --subscription "$SUB" -o json

# Zone links need the zone names from the call above.
if [ -s "$OUT/private-dns-zones.json" ]; then
  for zone in $(node -e 'try{const z=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(z.map((x)=>x.name).join(" "))}catch{}' "$(native "$OUT/private-dns-zones.json")"); do
    call "dnslinks.$zone" az network private-dns link vnet list -g "$RG" -z "$zone" --subscription "$SUB" -o json
  done
fi

call_stripped mysql                az mysql flexible-server show -g "$RG" -n mysql-invi-prod-001 --subscription "$SUB" -o json
call         keyvault              az keyvault show -n kv-invi-prod-001 --subscription "$SUB" -o json
call         keyvault.diag         az monitor diagnostic-settings list --resource "/subscriptions/$SUB/resourceGroups/$RG/providers/Microsoft.KeyVault/vaults/kv-invi-prod-001" -o json
call         mysql.diag            az monitor diagnostic-settings list --resource "/subscriptions/$SUB/resourceGroups/$RG/providers/Microsoft.DBforMySQL/flexibleServers/mysql-invi-prod-001" -o json

call         roleassignments       az role assignment list --all --subscription "$SUB" -o json
call         identities            az identity list -g "$RG" --subscription "$SUB" -o json
if [ -s "$OUT/identities.json" ]; then
  for id in $(node -e 'try{const z=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(z.map((x)=>x.name).join(" "))}catch{}' "$(native "$OUT/identities.json")"); do
    call "fic.$id" az identity federated-credential list --identity-name "$id" -g "$RG" --subscription "$SUB" -o json
  done
fi

call         swa.list              az staticwebapp list -g "$RG" --subscription "$SUB" -o json
if [ -s "$OUT/swa.list.json" ]; then
  for swa in $(node -e 'try{const z=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(z.map((x)=>x.name).join(" "))}catch{}' "$(native "$OUT/swa.list.json")"); do
    call "swa.$swa.hostnames" az staticwebapp hostname list -n "$swa" -g "$RG" --subscription "$SUB" -o json
  done
fi

printf '%s\n' "$STARTED" >"$OUT/collected-at.txt"

# calls.json: [{ name, rc, required }]
node -e '
const fs = require("fs");
const lines = fs.readFileSync(process.argv[1], "utf8").split("\n").filter(Boolean);
const calls = lines.map((l) => { const [name, rc] = l.split("\t"); return { name, rc: Number(rc), required: true }; });
fs.writeFileSync(process.argv[2], JSON.stringify(calls, null, 2));
const failed = calls.filter((c) => c.rc !== 0);
console.log(`collected ${calls.length} read-only listings, ${failed.length} failed${failed.length ? ": " + failed.map((c) => c.name).join(", ") : ""}`);
process.exit(failed.length ? 1 : 0);
' "$(native "$CALLS")" "$(native "$OUT/calls.json")"
