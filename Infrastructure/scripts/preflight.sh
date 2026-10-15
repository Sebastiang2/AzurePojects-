#!/usr/bin/env bash
# Pre-deployment safety gate. READ-ONLY and fail-closed: it never deploys, and anything it cannot verify is a failure.
#
#   Infrastructure/scripts/preflight.sh --deployment <key> [--work <dir>] [--report <file>] [--allow-dirty]
#
#   --deployment  key in Infrastructure/safety/manifest.json (main, adminapp-a, adminapp-b-rbac, ...)
#   --work        directory for the evidence (default: a new temporary directory). Contains no secret values.
#   --report      copy the JSON report here
#   --allow-dirty allow uncommitted changes (local review only; a deployment requires a clean tree)
#   --reuse-live  use live evidence collected earlier by this gate instead of collecting it again (local review and tests
#                 only; deploy.sh never uses it, and the freshness limit in the manifest still applies)
#
# What it does, in order (see docs/deploy-safety-gate.md):
#   1. scope     subscription, tenant and resource group are the ones in the manifest; template and parameter file are the
#                ones the manifest lists for this deployment; Incremental mode
#   2. compile   Bicep build, lint and parameter build
#   3. evaluate  offline evaluation of template + parameters (az bicep snapshot) with PLACEHOLDERS for secure parameters
#   4. what-if   az deployment group what-if against production, reduced in-pipe to a secret-free list
#   5. live      read-only collection of production state (names and non-secret values only)
#   6. analyse   Infrastructure/scripts/gate/analyze.mjs compares all of the above with the manifest
#
# Secure parameters are NEVER given real values here. The gate overrides them with placeholders, so it cannot leak a secret
# and cannot validate one either: that is a stated residual risk the approver has to acknowledge.
#
# Exit code: 0 = PASS, 1 = FAIL, 2 = the gate could not run. Only 0 may be followed by a deployment.
set -uo pipefail
export MSYS_NO_PATHCONV=1

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
GATE="$HERE/gate"
MANIFEST="$REPO_ROOT/Infrastructure/safety/manifest.json"

to_native() { if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s' "$1"; fi; }

DEPLOYMENT=""
WORK=""
REPORT=""
ALLOW_DIRTY=0
REUSE_LIVE=""
NOW_ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --deployment) DEPLOYMENT="${2:-}"; shift 2 ;;
    --work) WORK="${2:-}"; shift 2 ;;
    --report) REPORT="${2:-}"; shift 2 ;;
    --allow-dirty) ALLOW_DIRTY=1; shift ;;
    --now) NOW_ARGS=(--now "${2:-}"); shift 2 ;;
    --reuse-live) REUSE_LIVE="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,28p' "$0"; exit 0 ;;
    *) echo "preflight: unknown argument: $1" >&2; exit 2 ;;
  esac
done
[ -n "$DEPLOYMENT" ] || { echo "preflight: --deployment <key> is required" >&2; exit 2; }
for tool in az node git; do command -v "$tool" >/dev/null 2>&1 || { echo "preflight: $tool is not installed" >&2; exit 2; }; done
[ -f "$MANIFEST" ] || { echo "preflight: manifest not found: $MANIFEST" >&2; exit 2; }

MANIFEST_N="$(to_native "$MANIFEST")"
field() { node -e 'const m=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); const d=m.deployments?.[process.argv[2]]; if(!d){process.exit(3)} const v=process.argv[3].split(".").reduce((a,k)=>a?.[k],{scope:m.scope,d}); process.stdout.write(Array.isArray(v)?v.join(" "):String(v??""))' "$MANIFEST_N" "$DEPLOYMENT" "$1"; }

SUB="$(field scope.subscriptionId)" || { echo "preflight: deployment '$DEPLOYMENT' is not in the manifest" >&2; exit 2; }
TENANT="$(field scope.tenantId)"
RG="$(field scope.resourceGroup)"
LOCATION="$(field scope.location)"
TEMPLATE="$(field d.template)"
PARAMETERS="$(field d.parameters)"
ALL_SECURE="$(node -e 'const m=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); console.log([...new Set(Object.values(m.deployments).flatMap((d)=>d.secureEnvironment??[]))].join(" "))' "$MANIFEST_N")"

[ -f "$REPO_ROOT/$TEMPLATE" ] || { echo "preflight: template not found: $TEMPLATE" >&2; exit 2; }
[ -f "$REPO_ROOT/$PARAMETERS" ] || { echo "preflight: parameter file not found: $PARAMETERS" >&2; exit 2; }

if [ -z "$WORK" ]; then WORK="$(mktemp -d "${TMPDIR:-/tmp}/invi-gate.XXXXXX")"; fi
mkdir -p "$WORK/live" "$WORK/eval"
WORK_N="$(to_native "$WORK")"

# Secure parameters: placeholders only, whatever the caller's shell holds. A real value must never reach a gate run.
for name in $ALL_SECURE; do export "$name=__GATE:${name}__"; done

echo "== safety gate: $DEPLOYMENT"
echo "   subscription $SUB, resource group $RG"
echo "   template     $TEMPLATE"
echo "   parameters   $PARAMETERS"
echo "   evidence     $WORK"

STEPS=""
step() { STEPS="${STEPS:+$STEPS,}$1=$2"; }

# ---- 1. scope ----------------------------------------------------------------------------------------------------------
ACCOUNT_TENANT=""
ACCOUNT_SUB=""
RG_EXISTS=false
if account_json="$(az account show --subscription "$SUB" --only-show-errors -o json 2>"$WORK/account.err")"; then
  ACCOUNT_SUB="$(printf '%s' "$account_json" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).id||""))')"
  ACCOUNT_TENANT="$(printf '%s' "$account_json" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).tenantId||""))')"
  step scope 0
else
  echo "   ! could not read subscription $SUB: $(head -c 300 "$WORK/account.err")"
  step scope 1
fi
if [ -n "$ACCOUNT_SUB" ] && az group show -n "$RG" --subscription "$SUB" --only-show-errors -o none 2>"$WORK/rg.err"; then RG_EXISTS=true; fi

# ---- 2. compile --------------------------------------------------------------------------------------------------------
echo "-- compile"
(cd "$REPO_ROOT/Infrastructure" && az bicep build --file "$(to_native "$REPO_ROOT/$TEMPLATE")" --stdout >/dev/null 2>"$WORK/compile.err"); step compile "$?"
lint_out="$(cd "$REPO_ROOT/Infrastructure" && az bicep lint --file "$(to_native "$REPO_ROOT/$TEMPLATE")" 2>&1 | grep -v 'new Bicep release' || true)"
lint_errors="$(printf '%s\n' "$lint_out" | grep -c ' : Error ' || true)"
if [ "${lint_errors:-0}" -gt 0 ]; then step lint 1; printf '%s\n' "$lint_out" | grep ' : Error ' | head -20; else step lint 0; fi
(cd "$REPO_ROOT/Infrastructure" && az bicep build-params --file "$(to_native "$REPO_ROOT/$PARAMETERS")" --stdout >/dev/null 2>"$WORK/params.err"); step params "$?"

# ---- 3. offline evaluation ---------------------------------------------------------------------------------------------
echo "-- evaluate (placeholders for secure parameters)"
rm -rf "$WORK/eval"; mkdir -p "$WORK/eval"
cp -r "$REPO_ROOT/Infrastructure" "$WORK/eval/Infrastructure"
# Evaluation copy only: without @secure() the placeholders flow through union()/if() so the whole settings bag can be
# evaluated. The copy is never deployed.
find "$WORK/eval/Infrastructure" -name '*.bicep' -print0 | xargs -0 sed -i -E 's/@secure\(\)//g'
# The lint configuration would reject the copy (secrets without @secure()); lint is judged on the real files in step 2.
rm -f "$WORK/eval/Infrastructure/bicepconfig.json"
PARAM_EVAL="$WORK/eval/$PARAMETERS"
if (cd "$WORK/eval" && az bicep snapshot --file "$(to_native "$PARAM_EVAL")" --resource-group "$RG" --subscription-id "$SUB" --location "$LOCATION" --only-show-errors >/dev/null 2>"$WORK/snapshot.err"); then
  mv "${PARAM_EVAL%.bicepparam}.snapshot.json" "$WORK/snapshot.json" && step snapshot 0 || step snapshot 1
else
  step snapshot 1
fi

# ---- 4. what-if (real template, placeholders; reduced in-pipe, never stored raw) ----------------------------------------
echo "-- what-if"
az deployment group what-if --resource-group "$RG" --subscription "$SUB" --parameters "$(to_native "$REPO_ROOT/$PARAMETERS")" \
  --no-pretty-print -o json --only-show-errors 2>"$WORK/whatif.err" \
  | node "$(to_native "$GATE/summarize-whatif.mjs")" "$WORK_N/whatif.json" 2>>"$WORK/whatif.err"
wi=("${PIPESTATUS[@]}")
if [ "${wi[0]}" -ne 0 ]; then step whatif "${wi[0]}"; elif [ "${wi[1]}" -ne 0 ]; then step whatif "${wi[1]}"; else step whatif 0; fi

# ---- 5. live state -----------------------------------------------------------------------------------------------------
echo "-- live state (read-only)"
APPS="$(node -e '
const fs=require("fs");
const m=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
const names=new Set(Object.keys(m.apps??{}));
try{const s=JSON.parse(fs.readFileSync(process.argv[2],"utf8")); for(const r of s.predictedResources??[]) if(/^microsoft\.web\/sites$/i.test(r.type)) names.add(r.name);}catch{}
console.log([...names].join(" "));
' "$MANIFEST_N" "$WORK_N/snapshot.json" 2>/dev/null)"
if [ -n "$REUSE_LIVE" ]; then
  echo "   (reusing live evidence from $REUSE_LIVE)"
  cp -r "$REUSE_LIVE/." "$WORK/live/"
  LIVE_AT="$(tr -d '
' <"$WORK/live/collected-at.txt")"
  step live 0
else
  LIVE_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  # shellcheck disable=SC2086
  bash "$GATE/collect-live.sh" "$WORK/live" "$SUB" "$RG" $APPS; step live "$?"
fi

# ---- 6. analyse --------------------------------------------------------------------------------------------------------
CTX_ARGS=(--repo-root "$(to_native "$REPO_ROOT")" --manifest "$MANIFEST_N" --deployment "$DEPLOYMENT" --work "$WORK_N"
          --steps "$STEPS" --subscription "$ACCOUNT_SUB" --tenant "$ACCOUNT_TENANT" --resource-group "$RG"
          --resource-group-exists "$RG_EXISTS" --live-collected-at "$LIVE_AT")
[ "$ALLOW_DIRTY" -eq 1 ] && CTX_ARGS+=(--allow-dirty)
node "$(to_native "$GATE/context.mjs")" "${CTX_ARGS[@]}" || exit 2

node "$(to_native "$GATE/analyze.mjs")" --work "$WORK_N" --manifest "$MANIFEST_N" --deployment "$DEPLOYMENT" \
  --out "$WORK_N/report.json" --md "$WORK_N/report.md" "${NOW_ARGS[@]}"
rc=$?
[ -n "$REPORT" ] && [ -f "$WORK/report.json" ] && cp "$WORK/report.json" "$REPORT"
echo
case "$rc" in
  0) echo "== GATE PASS ($DEPLOYMENT). Report: $WORK/report.md" ;;
  1) echo "== GATE FAIL ($DEPLOYMENT). Nothing may be deployed. Report: $WORK/report.md" ;;
  *) echo "== GATE COULD NOT RUN ($DEPLOYMENT). Treat as FAIL." ;;
esac
exit "$rc"
