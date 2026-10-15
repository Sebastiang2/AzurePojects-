#!/usr/bin/env bash
# Offline validation of the Bicep code: build, lint (bicepconfig.json), parameter files and a few static checks.
# No Azure access and no secrets are needed: parameters that the deploying shell would supply are given placeholders.
#
#   Infrastructure/scripts/validate.sh
#
# Exit code 0 = everything passed. Lint warnings are listed but do not fail the run; lint errors, build errors and failed
# static checks do. The same script runs in .github/workflows/iac-validate.yml.
set -uo pipefail

cd "$(dirname "$0")/.."   # Infrastructure/
repo_root="$(cd .. && pwd)"

# Placeholders for values the real deployment reads from the environment (never real values).
export MYSQL_ADMIN_PASSWORD="${MYSQL_ADMIN_PASSWORD:-validate-only-not-a-secret}"
export REVENUECAT_SECRET_API_KEY="${REVENUECAT_SECRET_API_KEY:-validate-only-not-a-secret}"
export REVENUECAT_WEBHOOK_AUTHORIZATION="${REVENUECAT_WEBHOOK_AUTHORIZATION:-validate-only-not-a-secret}"
export ADMIN_ENTRA_CLIENT_SECRET="${ADMIN_ENTRA_CLIENT_SECRET:-validate-only-not-a-secret}"

failures=0
note() { printf '%s\n' "$*"; }
fail() { printf 'FAIL  %s\n' "$*"; failures=$((failures + 1)); }
ok() { printf 'ok    %s\n' "$*"; }

note "== build: every template compiles"
for template in main.bicep modules/*.bicep; do
  if output="$(az bicep build --file "$template" --stdout 2>&1 >/dev/null)"; then
    ok "build $template"
  else
    fail "build $template"; printf '%s\n' "$output" | sed 's/^/      /'
  fi
done

note "== lint (bicepconfig.json): errors fail, warnings are shown"
# The exit status of `az bicep lint` decides, not only the text: a linter that did not run (Bicep CLI missing, template
# unreadable) prints no "Error" lines, and counting lines alone would report that as a pass.
for template in main.bicep modules/*.bicep; do
  output="$(az bicep lint --file "$template" 2>&1)"; lint_rc=$?
  output="$(printf '%s\n' "$output" | grep -v 'new Bicep release')"
  errors="$(printf '%s\n' "$output" | grep -c ' : Error ' || true)"
  warnings="$(printf '%s\n' "$output" | grep -c ' : Warning ' || true)"
  if [ "$errors" -gt 0 ]; then
    fail "lint $template ($errors error(s))"; printf '%s\n' "$output" | grep ' : Error ' | sed 's/^/      /'
  elif [ "$lint_rc" -ne 0 ]; then
    fail "lint $template did not complete (exit $lint_rc)"; printf '%s\n' "$output" | sed 's/^/      /'
  else
    ok "lint $template ($warnings warning(s))"
  fi
done

note "== parameter files compile against their templates"
for parameters in environments/*.bicepparam; do
  if output="$(az bicep build-params --file "$parameters" --stdout 2>&1 >/dev/null)"; then
    ok "params $parameters"
  else
    fail "params $parameters"; printf '%s\n' "$output" | sed 's/^/      /'
  fi
done

note "== static checks"
# 1. a compiled copy of main.bicep must not be tracked: it goes stale and misleads (.gitignore lists it)
if git -C "$repo_root" ls-files --error-unmatch Infrastructure/main.json >/dev/null 2>&1; then
  fail "Infrastructure/main.json is tracked but is a generated artifact (git rm --cached it)"
else
  ok "no tracked compiled main.json"
fi
# 2. secure parameters in parameter files come from the environment, never from a literal
node - <<'NODE' || failures=$((failures + 1))
const fs = require("fs");
const path = require("path");
const root = process.cwd();
const secure = new Set();
for (const file of [path.join("main.bicep"), ...fs.readdirSync("modules").filter((f) => f.endsWith(".bicep")).map((f) => path.join("modules", f))]) {
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  lines.forEach((line, i) => {
    if (/^@secure\(\)/.test(line.trim())) {
      for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
        const m = lines[j].match(/^\s*param\s+([A-Za-z0-9_]+)\s/);
        if (m) { secure.add(m[1]); break; }
      }
    }
  });
}
let bad = 0;
for (const file of fs.readdirSync("environments").filter((f) => f.endsWith(".bicepparam"))) {
  for (const line of fs.readFileSync(path.join("environments", file), "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*param\s+([A-Za-z0-9_]+)\s*=\s*(.*)$/);
    if (!m || !secure.has(m[1])) continue;
    const value = m[2].trim();
    const fromEnvironment = /^readEnvironmentVariable\(/.test(value);
    const emptyDefault = value === "''";
    if (!fromEnvironment && !emptyDefault) { console.log(`FAIL  ${file}: secure parameter ${m[1]} has a literal value`); bad++; }
  }
}
// 3. no high-entropy literal that looks like a key in any Bicep or parameter file
// The key may be the *name* of a secret or a setting (...Name, ...Names, ...SettingName); only values matter.
const pattern = /\b([A-Za-z_]*(?:password|secret|api[_-]?key|token|connectionstring|sharedaccesskey|accountkey|private[_-]?key)[A-Za-z_]*)['"]?\s*[:=]\s*['"][A-Za-z0-9+\/=_-]{20,}['"]/i;
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);
for (const file of walk(".").filter((f) => /\.(bicep|bicepparam)$/.test(f))) {
  fs.readFileSync(file, "utf8").split(/\r?\n/).forEach((line, i) => {
    const hit = line.match(pattern);
    if (hit && !/Names?$/.test(hit[1]) && !/readEnvironmentVariable|@Microsoft\.KeyVault/.test(line)) { console.log(`FAIL  ${file}:${i + 1}: looks like a secret literal`); bad++; }
  });
}
if (bad === 0) console.log("ok    secure parameters come from the environment; no secret-like literals");
process.exit(bad === 0 ? 0 : 1);
NODE

note "== unit and template regression tests (the ones present in this tree)"
for dir in scripts/gate/tests tests; do
  if ls "$dir"/*.test.mjs >/dev/null 2>&1; then
    output="$(node --test "$dir"/*.test.mjs 2>&1)"; test_rc=$?
    summary="$(printf '%s\n' "$output" | grep -E '^ℹ (tests|pass|fail|skipped)' | tr '\n' ' ')"
    if [ "$test_rc" -eq 0 ]; then
      ok "node --test $dir  $summary"
    else
      fail "node --test $dir  $summary"; printf '%s\n' "$output" | grep -E '^✖' | head -20 | sed 's/^/      /'
    fi
  fi
done

if [ "$failures" -eq 0 ]; then
  note "== all checks passed"
else
  note "== $failures check(s) failed"
fi
exit "$failures"
