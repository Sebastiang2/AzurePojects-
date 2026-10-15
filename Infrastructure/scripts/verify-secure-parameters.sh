#!/usr/bin/env bash
# OPERATOR-RUN, READ-ONLY. Checks that the secure parameters in YOUR shell are the values production holds today, so that a
# deployment cannot silently replace a working secret with a stale, mistyped or empty one. The safety gate cannot do this:
# it runs on placeholders on purpose and what-if cannot see the value of a secure parameter.
#
#   Infrastructure/scripts/verify-secure-parameters.sh --deployment <key>
#
# The MySQL administrator password is not part of a normal deployment (the server is left alone: see
# docs/deploy-runbook.md), so it is not listed here. It appears only for a deployment that creates a server.
#
# Output is MATCH / MISMATCH / ... per parameter and NEVER a value, a hash or a length. The live value is read with
# `az webapp config appsettings list` (a read-only call that returns the setting to YOU) and compared inside a Node process
# that receives both values through its environment, not its argument list. Nothing is written to disk.
#
# Only parameters that are copied into an app setting can be verified. A parameter that Azure never returns (the MySQL
# administrator password) is reported as NOT-VERIFIABLE and has to be confirmed by other means: docs/deploy-runbook.md.
# A deliberate rotation shows MISMATCH by design (the deployment replaces the old value); anything else must be MATCH.
#
# Exit code: 0 = every verifiable parameter matches; 1 = a mismatch, a missing or placeholder value, or a value that could
# not be read; 2 = usage or tool error. Run it in the shell you will deploy from, before deploy.sh.
set -uo pipefail
export MSYS_NO_PATHCONV=1

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MANIFEST="$HERE/../safety/manifest.json"
to_native() { if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s' "$1"; fi; }

DEPLOYMENT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --deployment) DEPLOYMENT="${2:-}"; shift 2 ;;
    --manifest) MANIFEST="${2:-}"; shift 2 ;;   # tests only
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "ERROR: unknown argument: $1" >&2; exit 2 ;;
  esac
done
[ -n "$DEPLOYMENT" ] || { echo "ERROR: --deployment <key> is required" >&2; exit 2; }
for tool in az node; do command -v "$tool" >/dev/null 2>&1 || { echo "ERROR: $tool is not installed." >&2; exit 2; }; done
[ -f "$MANIFEST" ] || { echo "ERROR: manifest not found: $MANIFEST" >&2; exit 2; }

# One line per secure environment variable of the deployment: ENV<TAB>APP<TAB>SETTING (APP and SETTING empty = no app
# setting receives it). Only names from the manifest are printed here.
PLAN="$(node -e '
const m = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
const d = m.deployments?.[process.argv[2]];
if (!d) process.exit(3);
const feeds = new Map();
for (const [app, a] of Object.entries(m.apps ?? {})) for (const [setting, env] of Object.entries(a.secureFeeds ?? {})) feeds.set(env, [app, setting]);
for (const env of d.secureEnvironment ?? []) { const [app, setting] = feeds.get(env) ?? ["", ""]; console.log([env, app, setting].join("\t")); }
console.log("#" + m.scope.subscriptionId + "\t" + m.scope.resourceGroup);
' "$(to_native "$MANIFEST")" "$DEPLOYMENT")" || { echo "ERROR: '$DEPLOYMENT' is not a deployment in the manifest." >&2; exit 2; }

SCOPE_LINE="$(printf '%s\n' "$PLAN" | grep '^#' | head -n1)"
SUB="$(printf '%s' "${SCOPE_LINE#\#}" | cut -f1)"
RG="$(printf '%s' "${SCOPE_LINE#\#}" | cut -f2)"
PLAN="$(printf '%s\n' "$PLAN" | grep -v '^#' || true)"

echo "Secure parameters for deployment '$DEPLOYMENT' (values are never shown)"
if [ -z "$PLAN" ]; then
  echo "  none: this deployment reads no secure parameter."
  exit 0
fi

bad=0
unverifiable=0
while IFS=$'\t' read -r env app setting; do
  [ -n "$env" ] || continue
  shell_value="${!env:-}"
  shell_value="${shell_value%$'\r'}"

  if [ -z "${shell_value//[[:space:]]/}" ]; then
    echo "  MISSING          $env is not set in this shell (the deployment would fail or write an empty value)"
    bad=$((bad + 1)); continue
  fi
  case "$shell_value" in
    __GATE:*) echo "  PLACEHOLDER      $env holds a gate placeholder, not a real value"; bad=$((bad + 1)); continue ;;
  esac
  if [ -z "$app" ]; then
    echo "  NOT-VERIFIABLE   $env is set, but Azure never returns this value, so it cannot be compared (docs/deploy-runbook.md)"
    unverifiable=$((unverifiable + 1)); continue
  fi

  if ! live_value="$(az webapp config appsettings list -g "$RG" -n "$app" --subscription "$SUB" --only-show-errors \
        --query "[?name=='$setting'].value | [0]" -o tsv 2>/dev/null)"; then
    echo "  UNKNOWN          $env: the live setting $setting of $app could not be read (permission, network?)"
    bad=$((bad + 1)); continue
  fi
  live_value="${live_value%$'\r'}"
  if [ -z "$live_value" ] || [ "$live_value" = "None" ]; then
    echo "  NEW              $env: $setting is not set on $app yet; the deployment would add it"
    continue
  fi
  case "$live_value" in
    '@Microsoft.KeyVault('*)
      echo "  MISMATCH         $env: $setting on $app is a Key Vault reference; the deployment would replace it with a literal"
      bad=$((bad + 1)); continue ;;
  esac

  if LIVE_VALUE="$live_value" SHELL_VALUE="$shell_value" node -e 'process.exit(process.env.LIVE_VALUE === process.env.SHELL_VALUE ? 0 : 1)'; then
    echo "  MATCH            $env equals $setting on $app"
  else
    echo "  MISMATCH         $env differs from $setting on $app: the deployment would REPLACE the working value"
    bad=$((bad + 1))
  fi
done <<<"$PLAN"
unset live_value shell_value

echo
if [ "$bad" -gt 0 ]; then
  echo "RESULT: $bad parameter(s) must be fixed before deploying."
  exit 1
fi
if [ "$unverifiable" -gt 0 ]; then
  echo "RESULT: every verifiable parameter matches; $unverifiable cannot be verified from Azure and must be confirmed another way."
else
  echo "RESULT: every parameter matches."
fi
exit 0
