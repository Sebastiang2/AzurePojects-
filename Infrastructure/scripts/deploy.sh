#!/usr/bin/env bash
# Deploys ONE reviewed Bicep deployment to production, behind the safety gate. Incremental mode only.
#
#   Infrastructure/scripts/deploy.sh --deployment <key> [--dry-run] [--allow-non-main]
#
#   --deployment  key in Infrastructure/safety/manifest.json: main, adminapp-a, adminapp-b-rbac, adminapp-c-domain,
#                 swa-web, swa-domain-app-cetchapp-com, swa-domain-invi-lol, swa-domain-www-invi-lol
#   --dry-run     rehearsal: runs every check and the gate, prints what would be deployed and every reason a real run would
#                 stop, and NEVER deploys (it also needs no terminal and tolerates a dirty tree and missing secure parameters,
#                 which it then reports as blockers)
#
# What changed from the previous version of this script (see docs/deploy-safety-gate.md):
#   - the gate (preflight.sh) must PASS first, and its approval is bound to the digest of the exact files and evidence it saw
#   - the what-if is judged by the gate and shown to you reduced (no secret values); the raw what-if is never printed
#   - approval is typed, per deployment, per digest; there is no standing "yes"; evidence older than the manifest's limit is
#     refused even after the approval is typed
#   - template and parameter file come from the manifest, never from ambient state; the subscription is passed on every call
#     and the default subscription of the Azure CLI is never changed
#   - `az bicep build` no longer writes a main.json into the tree
#   - the old steps that created GitHub identities, federated credentials and role assignments with imperative CLI calls are
#     gone: they bypassed Bicep, and step 8 enforced the stale prod-migration credentials. Identities and their credentials
#     are now only READ and compared by the gate; adopting them into Bicep is a separate change (IaC-5).
#
# Secure parameters are read from the environment (see the manifest's secureEnvironment for the deployment). They are used
# only by the deployment itself; the gate runs on placeholders.
set -euo pipefail
export MSYS_NO_PATHCONV=1

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
MANIFEST="$REPO_ROOT/Infrastructure/safety/manifest.json"
to_native() { if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s' "$1"; fi; }
# git.exe and node.exe are native Windows programs: with MSYS_NO_PATHCONV=1 an MSYS path (/c/Users/...) is passed through
# unchanged and they cannot open it. Every path that goes to a native program is converted first.
REPO_ROOT_N="$(to_native "$REPO_ROOT")"

DEPLOYMENT=""
ALLOW_NON_MAIN=0
DRY_RUN=0
while [ $# -gt 0 ]; do
  case "$1" in
    --deployment) DEPLOYMENT="${2:-}"; shift 2 ;;
    --allow-non-main) ALLOW_NON_MAIN=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "ERROR: unknown argument: $1" >&2; exit 2 ;;
  esac
done
[ -n "$DEPLOYMENT" ] || { echo "ERROR: --deployment <key> is required (see --help)" >&2; exit 2; }

echo "======================================"
echo " INVI Azure deployment: $DEPLOYMENT$([ "$DRY_RUN" -eq 1 ] && echo ' (DRY RUN: nothing will be deployed)')"
echo "======================================"

# A blocker stops a real run at once; a dry run records it and carries on, so the rehearsal shows everything at once.
BLOCKERS=()
block() {
  if [ "$DRY_RUN" -eq 1 ]; then
    BLOCKERS+=("$1")
    echo "BLOCKER: $1"
  else
    echo "ERROR: $1" >&2
    exit "${2:-1}"
  fi
}

# Approval has to be given by a person at a terminal (a dry run asks for nothing).
if [ "$DRY_RUN" -eq 0 ] && { [ ! -t 0 ] || [ ! -t 1 ]; }; then
  echo "ERROR: this script needs an interactive terminal: the approval is typed." >&2
  exit 2
fi
for tool in az node git; do command -v "$tool" >/dev/null 2>&1 || { echo "ERROR: $tool is not installed." >&2; exit 2; }; done

MANIFEST_N="$(to_native "$MANIFEST")"
field() { node -e 'const m=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); const d=m.deployments?.[process.argv[2]]; if(!d){process.exit(3)} const v=process.argv[3].split(".").reduce((a,k)=>a?.[k],{scope:m.scope,d,top:m}); process.stdout.write(Array.isArray(v)?v.join(" "):String(v??""))' "$MANIFEST_N" "$DEPLOYMENT" "$1"; }

SUB="$(field scope.subscriptionId)" || { echo "ERROR: '$DEPLOYMENT' is not a deployment in the manifest." >&2; exit 2; }
RG="$(field scope.resourceGroup)"
TEMPLATE="$(field d.template)"
PARAMETERS="$(field d.parameters)"
DEPLOYMENT_NAME="$(field d.deploymentName)"
SECURE="$(field d.secureEnvironment)"
REQUIRED_BACKEND_REVISION="$(field d.requiredBackendRevision)"
WARMUP_MODE=""
if [ -n "$REQUIRED_BACKEND_REVISION" ]; then
  WARMUP_MODE="$(node -e '
const fs = require("fs");
const read = (file) => {
  const matches = [...fs.readFileSync(file, "utf8").matchAll(/^param dataApiReadinessWarmupEnabled = (true|false)$/gm)];
  if (matches.length !== 1) process.exit(1);
  return matches[0][1];
};
const dedicated = read(process.argv[1]);
if (dedicated !== read(process.argv[2])) process.exit(1);
process.stdout.write(dedicated);
' "$(to_native "$REPO_ROOT/$PARAMETERS")" "$(to_native "$REPO_ROOT/Infrastructure/environments/prod.bicepparam")")" || block "warm-up parameters are missing or differ between the dedicated and main production files."
fi
MAX_AGE="$(field top.maxEvidenceAgeMinutes)"
MAX_AGE="${MAX_AGE:-30}"

echo "Subscription:   $SUB"
echo "Resource group: $RG"
echo "Template:       $TEMPLATE"
echo "Parameters:     $PARAMETERS"
echo "Name / mode:    $DEPLOYMENT_NAME / Incremental"
echo

# ---- 1. the working tree is what was reviewed ---------------------------------------------------------------------------
GATE_ARGS=()
if [ -n "$(git -C "$REPO_ROOT_N" status --porcelain)" ]; then
  block "the working tree has uncommitted changes. Deploy only what is committed and reviewed."
  GATE_ARGS+=(--allow-dirty)
fi
echo "Fetching origin to compare with main (read-only)..."
if git -C "$REPO_ROOT_N" fetch --quiet origin main; then
  HEAD_SHA="$(git -C "$REPO_ROOT_N" rev-parse HEAD)"
  MAIN_SHA="$(git -C "$REPO_ROOT_N" rev-parse origin/main)"
  if [ "$HEAD_SHA" != "$MAIN_SHA" ]; then
    if [ "$ALLOW_NON_MAIN" -ne 1 ]; then
      block "HEAD ($HEAD_SHA) is not origin/main ($MAIN_SHA). Deployments follow merge; --allow-non-main is only for a reviewed commit that is not merged yet."
    else
      echo "WARNING: deploying $HEAD_SHA, which is not origin/main ($MAIN_SHA)."
    fi
  fi
else
  HEAD_SHA="$(git -C "$REPO_ROOT_N" rev-parse HEAD)"
  block "could not fetch origin/main; cannot verify what is deployed."
fi

# ---- 2. secure parameters are present and are not placeholders ---------------------------------------------------------
for name in $SECURE; do
  value="${!name:-}"
  if [ -z "${value//[[:space:]]/}" ]; then
    block "$name is not set (the parameter file reads it with readEnvironmentVariable)."
  else
    case "$value" in __GATE:*) block "$name holds a gate placeholder, not a real value." ;; esac
  fi
done
[ -z "$SECURE" ] || echo "Secure parameters required: $SECURE (values are never shown)"

if [ -n "$REQUIRED_BACKEND_REVISION" ]; then
  echo "Comparing the supplied RevenueCat values with production without printing them..."
  if ! bash "$HERE/verify-secure-parameters.sh" --deployment "$DEPLOYMENT"; then
    block "secure deployment inputs are missing or differ from production."
  fi
fi

if [ "$WARMUP_MODE" = "true" ]; then
  echo "Verifying the currently running Data API before changing its App Settings..."
  if ! node "$HERE/verify-data-api-ready.mjs" "$REQUIRED_BACKEND_REVISION" 3 3; then
    block "Data API readiness or approved backend revision did not pass before the configuration change."
  fi
fi

# ---- 3. the gate -------------------------------------------------------------------------------------------------------
WORK="$(mktemp -d "${TMPDIR:-/tmp}/invi-deploy.XXXXXX")"
echo
echo "Running the safety gate (read-only; several minutes)..."
if ! bash "$HERE/preflight.sh" --deployment "$DEPLOYMENT" --work "$WORK" ${GATE_ARGS[@]+"${GATE_ARGS[@]}"}; then
  block "the safety gate did not pass. Report: $WORK/report.md"
fi
REPORT="$WORK/report.json"
if [ ! -f "$REPORT" ]; then
  block "the gate produced no report"
  echo "DRY RUN finished with blockers; nothing was deployed."
  exit 1
fi
DIGEST="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).digest)' "$(to_native "$REPORT")")"
SHORT="${DIGEST:0:12}"

# ---- 4. what the approval covers ---------------------------------------------------------------------------------------
echo
echo "================ What you are approving ================"
node -e '
const fs = require("fs");
const r = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const m = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const d = m.deployments[process.argv[3]];
console.log(`gate verdict ${r.verdict}, digest ${r.digest.slice(0, 12)}…, what-if ${JSON.stringify(r.whatIf.counts)}`);
console.log(`evidence collected ${r.evidence.liveCollectedAt}`);
if (d.mysqlServer) {
  const text = { existing: "NOT written: the administrator password and every server property stay as they are", update: "written WITHOUT administratorLogin and administratorLoginPassword", create: "CREATED with login and password (only valid when the server does not exist)" }[d.mysqlServer.mode];
  console.log(`\nMySQL server ${d.mysqlServer.name}: mode ${d.mysqlServer.mode} - ${text}`);
}
console.log(`\nResources this deployment may change (manifest, "touches"):`);
for (const t of d.touches ?? []) console.log(`  - ${t.type} ${t.name}`);
const allowed = r.findings.filter((f) => f.severity === "allowed");
console.log(`\nChanges the manifest allows (${allowed.length}):`);
for (const f of allowed) console.log(`  - ${f.id} ${f.subject}: ${f.message}`.slice(0, 200));
console.log(`\nResidual risks the gate cannot verify (${r.residualRisks.length}):`);
for (const x of r.residualRisks) console.log(`  - ${x.id}: ${x.text}`.slice(0, 400));
' "$(to_native "$REPORT")" "$MANIFEST_N" "$DEPLOYMENT"
echo "========================================================"
echo
echo "Full report: $WORK/report.md"

DEPLOY_CMD=(az deployment group create --name "$DEPLOYMENT_NAME" --resource-group "$RG" --subscription "$SUB"
            --parameters "$(to_native "$REPO_ROOT/$PARAMETERS")" --mode Incremental --only-show-errors --output none)

if [ "$DRY_RUN" -eq 1 ]; then
  echo
  echo "DRY RUN. A real run would execute exactly this after the typed approval:"
  echo "  ${DEPLOY_CMD[*]}"
  if [ "${#BLOCKERS[@]}" -gt 0 ]; then
    echo
    echo "A real run would STOP for ${#BLOCKERS[@]} reason(s):"
    for b in "${BLOCKERS[@]}"; do echo "  - $b"; done
    echo "Nothing was deployed."
    exit 1
  fi
  echo "No blocker found. Nothing was deployed."
  exit 0
fi

# ---- 5. approval, bound to the digest ----------------------------------------------------------------------------------
echo "Type exactly   DEPLOY $DEPLOYMENT $SHORT   to deploy, anything else cancels."
read -r -p "> " CONFIRM
if [ "$CONFIRM" != "DEPLOY $DEPLOYMENT $SHORT" ]; then
  echo "Cancelled. Nothing was deployed."
  exit 0
fi

# The files must still be the ones the gate saw, and the evidence must still be fresh: the approval may have waited.
CURRENT_HEAD="$(git -C "$REPO_ROOT_N" rev-parse HEAD)"
if [ "$CURRENT_HEAD" != "$HEAD_SHA" ] || [ -n "$(git -C "$REPO_ROOT_N" status --porcelain)" ]; then
  echo "ERROR: the working tree changed after the gate ran. Nothing was deployed." >&2
  exit 1
fi
AGE_MIN="$(node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); console.log(Math.floor((Date.now()-new Date(r.evidence.liveCollectedAt).getTime())/60000))' "$(to_native "$REPORT")")"
if ! [ "$AGE_MIN" -ge 0 ] 2>/dev/null || [ "$AGE_MIN" -gt "$MAX_AGE" ]; then
  echo "ERROR: the gate's evidence is $AGE_MIN minute(s) old (limit $MAX_AGE). Production may have changed; run this script again. Nothing was deployed." >&2
  exit 1
fi

# ---- 6. deploy ---------------------------------------------------------------------------------------------------------
echo
echo "Deploying $DEPLOYMENT_NAME (Incremental)..."
"${DEPLOY_CMD[@]}"
STATE="$(az deployment group show --name "$DEPLOYMENT_NAME" --resource-group "$RG" --subscription "$SUB" --query properties.provisioningState --output tsv --only-show-errors)"
echo "Deployment state: $STATE"
[ "$STATE" = "Succeeded" ] || { echo "ERROR: deployment did not finish in Succeeded state. See docs/deploy-runbook.md (rollback)." >&2; exit 1; }

# ---- 7. verify ---------------------------------------------------------------------------------------------------------
echo
echo "Verifying the result (the gate again, on the new state)..."
POST="$(mktemp -d "${TMPDIR:-/tmp}/invi-postdeploy.XXXXXX")"
if bash "$HERE/preflight.sh" --deployment "$DEPLOYMENT" --work "$POST"; then
  echo "Post-deployment verification passed. Report: $POST/report.md"
else
  echo "ERROR: the deployment succeeded but the post-deployment verification FAILED. Investigate now: $POST/report.md (see docs/deploy-runbook.md)" >&2
  exit 1
fi

if [ "$WARMUP_MODE" = "true" ]; then
  echo "Waiting for the Data API to recover after the App Settings write..."
  node "$HERE/verify-data-api-ready.mjs" "$REQUIRED_BACKEND_REVISION" 30 3 || {
    echo "ERROR: Data API readiness did not recover at the approved revision. Do not automatically retry or roll back." >&2
    exit 1
  }
elif [ "$WARMUP_MODE" = "false" ]; then
  # A broken /ready is the reason to roll back warm-up; it must not prevent removal of the setting.
  echo "Warm-up rollback: checking liveness after removal, without requiring /ready or a particular backend revision..."
  node "$HERE/verify-data-api-ready.mjs" --liveness 30 3 || {
    echo "ERROR: warm-up settings were removed, but Data API liveness did not recover. Investigate; do not deploy again automatically." >&2
    exit 1
  }
fi

for app in $(node -e 'const m=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); console.log(Object.keys(m.apps??{}).join(" "))' "$MANIFEST_N"); do
  state="$(az webapp show --resource-group "$RG" --name "$app" --subscription "$SUB" --query state --output tsv --only-show-errors 2>/dev/null || echo unknown)"
  echo "App $app: $state"
  [ "$state" = "Running" ] || { echo "ERROR: $app is not running." >&2; exit 1; }
done

echo
echo "Done."
