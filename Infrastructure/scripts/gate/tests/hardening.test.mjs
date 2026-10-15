// Tests added after the review of the gate itself: the approved-resource list, measured (not asserted) secure-parameter
// handling, slot settings, case sensitivity, the evidence scrubber, and the scripts that orchestrate the gate. Run:
//   node --test Infrastructure/scripts/gate/tests/hardening.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { baseWorld, run, copy, ids } from "./fixtures.mjs";
import { looksSecret } from "../lib/secrets.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const gateDir = join(here, "..");
const scriptsDir = join(gateDir, "..");
const mutate = (fn) => {
  const w = copy(baseWorld());
  fn(w);
  return w;
};
const failsWith = (report, id) => assert.ok(ids(report).includes(id), `expected ${id} among ${JSON.stringify(ids(report))}`);
const haveBash = spawnSync("bash", ["-c", "true"]).status === 0;

// ---- approved resources -------------------------------------------------------------------------------------------------
test("a change to a resource that is not in the deployment's approved list is rejected", () => {
  const r = run(mutate((w) => {
    w.whatif.changes.push({ resourceId: "x", type: "Microsoft.Insights/components", name: "other", changeType: "Modify", deltas: [] });
    w.desiredResources.push({ type: "Microsoft.Insights/components", name: "other", properties: {} });
  }));
  failsWith(r, "WHATIF-RESOURCE-NOT-APPROVED");
});

test("the same change passes once the manifest lists the resource", () => {
  const r = run(mutate((w) => {
    w.whatif.changes.push({ resourceId: "x", type: "Microsoft.Insights/components", name: "other", changeType: "Modify", deltas: [] });
    w.desiredResources.push({ type: "Microsoft.Insights/components", name: "other", properties: {} });
    w.manifest.deployments.main.touches.push({ type: "Microsoft.Insights/components", name: "oth*" });
  }));
  assert.equal(r.verdict, "PASS", JSON.stringify(ids(r)));
});

test("a manifest without an approved-resource list is rejected", () => {
  failsWith(run(mutate((w) => delete w.manifest.deployments.main.touches)), "WHATIF-TOUCHES-MISSING");
});

test("more unanalysable resources in an allowed module than the manifest approved are rejected", () => {
  const r = run(mutate((w) => {
    w.manifest.deployments.main.allowedUnsupported = [{ module: "rbac", count: 1, why: "one role assignment" }];
    w.whatif.changes.push({ resourceId: "u", type: "Microsoft.Authorization/roleDefinitions", name: "y", changeType: "Unsupported", unsupportedReason: "declared at 'properties.template.resources.rbac.properties.template.resources[1]'", deltas: [] });
  }));
  failsWith(r, "WHATIF-UNSUPPORTED-COUNT");
});

// ---- secure parameters: measured, not asserted --------------------------------------------------------------------------
test("a variable the parameter file reads but preflight did not override with a placeholder is rejected", () => {
  const r = run(mutate((w) => w.context.envReads.push("SOMETHING_ELSE")));
  failsWith(r, "SECURE-ENV");
  failsWith(r, "ENV-READ-UNDECLARED");
});

test("a sensitive parameter missing from the deploying shell stops a deployment run and is information in a review run", () => {
  const deploy = run(mutate((w) => (w.context.secureEnvironment.presence.TEST_SECRET = false)));
  failsWith(deploy, "SECURE-MISSING");
  const review = run(mutate((w) => {
    w.context.secureEnvironment.presence.TEST_SECRET = false;
    w.context.git.requireClean = false;
  }));
  assert.equal(review.verdict, "PASS");
  assert.ok(ids(review, "info").includes("SECURE-MISSING"));
});

// ---- slots --------------------------------------------------------------------------------------------------------------
const slotBag = (props) => ({ type: "Microsoft.Web/sites/slots/config", name: "app-test/staging/appsettings", properties: props });

test("a slot's settings must hold the same invariants as the site's (WebDrafts cannot be switched on in a slot)", () => {
  const r = run(mutate((w) => w.desiredResources.push(slotBag({ A: "1", FLAG: "true", SECRET_KEY: "__GATE:TEST_SECRET__" }))));
  failsWith(r, "SLOT-BAG-INVARIANT");
});

test("a slot bag that lacks required settings, wires a secret wrongly or holds a secret literal is rejected", () => {
  failsWith(run(mutate((w) => w.desiredResources.push(slotBag({ FLAG: "false", SECRET_KEY: "__GATE:TEST_SECRET__" })))), "SLOT-BAG-REQUIRED-MISSING");
  failsWith(run(mutate((w) => w.desiredResources.push(slotBag({ A: "1", FLAG: "false", SECRET_KEY: "__GATE:OTHER__" })))), "SLOT-BAG-SECURE-FEED");
  failsWith(run(mutate((w) => w.desiredResources.push(slotBag({ A: "1", FLAG: "false", SECRET_KEY: "__GATE:TEST_SECRET__", SOME_TOKEN: "literal-value" })))), "SLOT-BAG-SECRET-LITERAL");
});

test("a slot bag that satisfies the site's rules passes the slot-settings checks", () => {
  const r = run(mutate((w) => w.desiredResources.push(slotBag({ A: "1", FLAG: "false", SECRET_KEY: "__GATE:TEST_SECRET__" }))));
  assert.ok(!ids(r).some((id) => id.startsWith("SLOT-BAG")), JSON.stringify(ids(r)));
});

// ---- case sensitivity ---------------------------------------------------------------------------------------------------
test("a case-only change of a case-sensitive property (app command line) is a change", () => {
  const r = run(mutate((w) => {
    w.desiredResources.find((x) => x.name === "app-test").properties.siteConfig.appCommandLine = "dotnet cetchappapi.dll";
    w.live.apps["app-test"].config.appCommandLine = "dotnet CetchAppAPI.dll";
  }));
  failsWith(r, "SITE-PROP-CHANGE");
});

test("enum-like site properties are still compared without case", () => {
  const r = run(mutate((w) => {
    w.desiredResources.find((x) => x.name === "app-test").properties.siteConfig.ftpsState = "disabled";
    w.live.apps["app-test"].config.ftpsState = "Disabled";
  }));
  assert.equal(r.verdict, "PASS", JSON.stringify(ids(r)));
});

test("an app setting value that differs only in case is a change; booleans are compared without case", () => {
  const bag = (w) => w.desiredResources.find((x) => x.name === "app-test/appsettings").properties;
  const both = (w, name, desired, live) => {
    bag(w)[name] = desired;
    w.live.apps["app-test"].appsettings.push({ name, kind: "plain", value: live, slotSetting: false });
  };
  // Same bytes except for case: a URL path or a file name is case sensitive on Linux, so this must not pass as "equal".
  failsWith(run(mutate((w) => both(w, "ExportPath", "/Data/Exports", "/data/exports"))), "BAG-VALUE-CHANGE");
  // Identical value: nothing to report (guards against the previous assertion passing for an unrelated reason).
  assert.equal(run(mutate((w) => both(w, "ExportPath", "/data/exports", "/data/exports"))).verdict, "PASS");
  // Booleans are what ARM and the portal capitalise differently.
  const ok = run(mutate((w) => {
    bag(w).FLAG = "False";
    w.live.apps["app-test"].appsettings.find((e) => e.name === "FLAG").value = "false";
  }));
  assert.equal(ok.verdict, "PASS", JSON.stringify(ids(ok)));
});

// ---- scrubbers ----------------------------------------------------------------------------------------------------------
function pipe(script, input) {
  const r = spawnSync(process.execPath, [join(gateDir, script)], { input: JSON.stringify(input), encoding: "utf8" });
  return { status: r.status, out: r.stdout, err: r.stderr };
}

test("looksSecret: keys, JWTs and credentials are secret; host names, URLs and GUIDs are not", () => {
  assert.ok(looksSecret("OpenAI__ApiKey", "x"));
  // built at run time so that no JWT-shaped literal sits in the repository (secret scanners flag those)
  const jwt = ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiIxMjM0In0", "c2lnbmF0dXJl"].join(".");
  assert.ok(looksSecret("Anything", jwt));
  assert.ok(looksSecret("Anything", "Server=db;Password=hunter2"));
  assert.ok(looksSecret("Anything", "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789"));
  assert.ok(!looksSecret("Database__Host", "mysql-invi-prod-001.mysql.database.azure.com"));
  assert.ok(!looksSecret("InviteBaseUrl", "https://app.cetchapp.com/"));
});

test("strip-sensitive drops secret values and containers but keeps names that merely describe a secret", () => {
  const { status, out } = pipe("strip-sensitive.mjs", {
    siteConfig: { appSettings: [{ name: "A", value: "v" }], azureStorageAccounts: { share: { accountName: "acct", accessKey: "k3y", mountPath: "/m" } }, machineKey: { validationKey: "v" } },
    properties: { clientSecretSettingName: "MICROSOFT_PROVIDER_AUTHENTICATION_SECRET", login: { tokenStore: { enabled: false } }, primaryKey: "pk" },
  });
  assert.equal(status, 0);
  const text = out;
  assert.ok(!text.includes("k3y") && !text.includes('"pk"') && !text.includes("appSettings") && !text.includes("machineKey"));
  assert.ok(text.includes("MICROSOFT_PROVIDER_AUTHENTICATION_SECRET") && text.includes('"enabled": false') && text.includes("accountName"));
});

test("sanitize-appsettings keeps names and kinds and never a secret value", () => {
  const secret = "S3cr3tValueThatMustNeverBeStored0123";
  const { status, out } = pipe("sanitize-appsettings.mjs", [
    { name: "RevenueCat__SecretApiKey", value: secret },
    { name: "Url", value: "https://example.org/" },
    { name: "Ref", value: "@Microsoft.KeyVault(VaultName=v;SecretName=s)" },
    { name: "Opaque", value: secret },
  ]);
  assert.equal(status, 0);
  assert.ok(!out.includes(secret));
  const parsed = JSON.parse(out);
  assert.deepEqual(parsed.map((e) => [e.name, e.kind]), [["RevenueCat__SecretApiKey", "secret-literal"], ["Url", "plain"], ["Ref", "keyvault-reference"], ["Opaque", "secret-literal"]]);
});

test("the what-if reducer treats connection strings, auth settings and storage mounts as opaque", () => {
  const { status, out } = pipe("summarize-whatif.mjs", {
    status: "Succeeded",
    changes: [
      {
        resourceId: "/subscriptions/s/resourceGroups/g/providers/Microsoft.Web/sites/app/config/connectionstrings",
        changeType: "Modify",
        before: { properties: { Main: { value: "tok.en.value-with-dots-1234567890", type: "MySql" } } },
        after: { properties: { Main: { value: "tok.en.value-with-dots-1234567890", type: "MySql" }, Extra: { value: "x" } } },
        delta: [{ path: "properties.Extra", propertyChangeType: "Create", before: null, after: { value: "tok.en.value-with-dots-1234567890" } }],
      },
    ],
  });
  assert.equal(status, 0);
  assert.ok(!out.includes("tok.en.value"));
  assert.deepEqual(JSON.parse(out).changes[0].bag.after, ["Extra", "Main"]);
});

test("env-reads lists exactly the variables a parameter file reads", () => {
  const dir = mkdtempSync(join(tmpdir(), "env-reads-"));
  try {
    const file = join(dir, "x.bicepparam");
    writeFileSync(file, "using 'x.bicep'\nparam a = readEnvironmentVariable('FIRST')\nparam b = readEnvironmentVariable( 'SECOND', 'default')\nparam c = 'readEnvironmentVariable'\n");
    const r = spawnSync(process.execPath, [join(gateDir, "env-reads.mjs"), file], { encoding: "utf8" });
    assert.deepEqual(r.stdout.trim().split(/\r?\n/), ["FIRST", "SECOND"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- the scripts themselves ---------------------------------------------------------------------------------------------
const WRITE_VERBS = /\baz\b[^\n|;&]*\b(create|update|delete|set|add|remove|start|stop|restart|swap|purge|import|assign|apply|upload|move|regenerate|reset|invoke|deploy|import|restore|recover)\b/i;

test("the gate's collector and orchestrator contain no Azure write verb (what-if and snapshot are the only POST-like calls)", () => {
  for (const file of ["preflight.sh", "validate.sh", "gate/collect-live.sh", "verify-secure-parameters.sh"]) {
    const source = readFileSync(join(scriptsDir, file), "utf8");
    const lines = source.split(/\r?\n/).filter((l) => !/^\s*#/.test(l));
    for (const line of lines) {
      if (/az\s+deployment\s+group\s+what-if/.test(line) || /az\s+bicep\s+(snapshot|build|build-params|lint)/.test(line)) continue;
      assert.ok(!WRITE_VERBS.test(line), `${file}: ${line.trim()}`);
      if (/az\s+rest\b/.test(line)) assert.match(line, /--method\s+get\b/, `${file}: az rest without --method get: ${line.trim()}`);
    }
  }
});

test("the collector writes nothing to disk that did not pass a scrubber", () => {
  const source = readFileSync(join(scriptsDir, "gate", "collect-live.sh"), "utf8");
  const writes = source.split(/\r?\n/).filter((l) => /(^|[^2&])>\s*"\$OUT\//.test(l) && !/^\s*#/.test(l));
  assert.ok(writes.length >= 2, "expected the scrubbing helpers to be found");
  for (const line of writes) {
    assert.ok(/node\s+"\$(STRIP|SANITIZE)"/.test(line) || /\.err"/.test(line) || /collected-at\.txt/.test(line), `unscrubbed write: ${line.trim()}`);
  }
  // every listing goes through `call` (scrubbed) or `call_bag` (sanitised); none is redirected on its own
  assert.ok(!/call_stripped/.test(source), "call_stripped was folded into call");
  assert.ok(!/\baz\b[^\n|]*>\s*"\$OUT/.test(source), "an az command is redirected straight to disk");
});

test("validate.sh decides on the linter's exit status, not on the absence of error lines", () => {
  const source = readFileSync(join(scriptsDir, "validate.sh"), "utf8");
  assert.match(source, /az bicep lint --file "\$template" 2>&1\)"; lint_rc=\$\?/);
  assert.match(source, /\[ "\$lint_rc" -ne 0 \]/);
  assert.ok(!/az bicep lint[^\n]*\|\| true/.test(source), "lint output must not be forced to success");
});

test("only deploy.sh can deploy, and it is the only script with `az deployment group create`", () => {
  for (const file of ["gate/collect-live.sh", "preflight.sh", "validate.sh", "verify-secure-parameters.sh"]) {
    assert.ok(!/az\s+deployment\s+group\s+create/.test(readFileSync(join(scriptsDir, file), "utf8")), `${file} must not deploy`);
  }
  const deploy = readFileSync(join(scriptsDir, "deploy.sh"), "utf8");
  assert.ok(/--mode Incremental/.test(deploy) && !/--mode Complete/.test(deploy));
});

test("deploy.sh runs the gate before anything is deployed; only a PASS can reach the deploy command", () => {
  const src = readFileSync(join(scriptsDir, "deploy.sh"), "utf8");
  const gate = src.indexOf('bash "$HERE/preflight.sh" --deployment "$DEPLOYMENT" --work "$WORK"');
  const approval = src.indexOf('read -r -p "> " CONFIRM');
  const dryRunExit = src.indexOf('if [ "$DRY_RUN" -eq 1 ]; then\n  echo\n  echo "DRY RUN. A real run');
  const deploy = src.indexOf('"${DEPLOY_CMD[@]}"\n');
  assert.ok(gate > 0 && dryRunExit > gate && approval > dryRunExit && deploy > approval, `order gate=${gate} dry=${dryRunExit} approval=${approval} deploy=${deploy}`);
  // a gate that did not pass is a blocker, and in a real run a blocker exits
  assert.match(src, /if ! bash "\$HERE\/preflight\.sh"[^\n]*; then\n\s*block "the safety gate did not pass/);
  assert.match(src, /block\(\) \{\n\s*if \[ "\$DRY_RUN" -eq 1 \]; then[\s\S]*?else[\s\S]*?exit "\$\{2:-1\}"/);
  // the typed approval is bound to the digest and the evidence age is re-checked after it
  assert.match(src, /"DEPLOY \$DEPLOYMENT \$SHORT"/);
  assert.ok(src.indexOf("AGE_MIN=") > approval && src.indexOf("AGE_MIN=") < deploy, "evidence age is checked between approval and deploy");
  // exactly one place deploys
  assert.equal((src.match(/az deployment group create/g) ?? []).length, 1 + (src.match(/#.*az deployment group create/g) ?? []).length);
});

test("README and the Copilot instructions never tell anyone to run a bare `az deployment group create`", () => {
  const root = join(scriptsDir, "..", "..");
  for (const file of ["README.md", ".github/copilot-instructions.md"]) {
    for (const line of readFileSync(join(root, file), "utf8").split(/\r?\n/)) {
      if (/az deployment group create/.test(line)) assert.match(line, /aldri|never|omgår/i, `${file}: ${line.trim()}`);
    }
  }
});

test("a script that disables MSYS path conversion hands native programs only native paths (git -C)", () => {
  // git.exe cannot open /c/Users/...: with MSYS_NO_PATHCONV=1 the path must be converted by the script itself (found by the
  // first real `deploy.sh --dry-run` on Windows).
  for (const file of ["deploy.sh", "preflight.sh", "verify-secure-parameters.sh", "gate/collect-live.sh"]) {
    const source = readFileSync(join(scriptsDir, file), "utf8");
    if (!/MSYS_NO_PATHCONV=1/.test(source)) continue;
    for (const line of source.split(/\r?\n/)) {
      if (/^\s*#/.test(line) || !/\bgit\s+-C\s+"/.test(line)) continue;
      assert.match(line, /git\s+-C\s+"(\$[A-Z_]+_N|\$\(to_native)/, `${file}: ${line.trim()}`);
    }
  }
});

test("every shell script parses", { skip: !haveBash }, () => {
  for (const file of ["preflight.sh", "deploy.sh", "validate.sh", "gate/collect-live.sh", "verify-secure-parameters.sh"]) {
    const r = spawnSync("bash", ["-n", join(scriptsDir, file)], { encoding: "utf8" });
    assert.equal(r.status, 0, `${file}: ${r.stderr}`);
  }
});

test("deploy.sh and preflight.sh refuse missing or unknown arguments", { skip: !haveBash }, () => {
  const bash = (script, args) => spawnSync("bash", [join(scriptsDir, script), ...args], { encoding: "utf8", input: "" });
  assert.equal(bash("deploy.sh", []).status, 2);
  assert.equal(bash("deploy.sh", ["--deployment", "nope"]).status, 2);
  assert.equal(bash("preflight.sh", []).status, 2);
  assert.equal(bash("preflight.sh", ["--deployment", "nope"]).status, 2);
  assert.equal(bash("deploy.sh", ["--deployment", "main", "--frobnicate"]).status, 2);
});

test("a real deploy.sh run without a terminal refuses before it does anything", { skip: !haveBash }, () => {
  const r = spawnSync("bash", [join(scriptsDir, "deploy.sh"), "--deployment", "main"], { encoding: "utf8", input: "" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /interactive terminal/);
});

// ---- verify-secure-parameters.sh (operator-run; tested against a stub `az`, never against Azure) -------------------------
const verifyScript = join(scriptsDir, "verify-secure-parameters.sh");

function runVerify({ live, fail = false, shell = {}, deployment = "main", manifest }) {
  const stubDir = mkdtempSync(join(tmpdir(), "stub-az-"));
  try {
    writeFileSync(join(stubDir, "az"), '#!/usr/bin/env bash\nif [ "${STUB_AZ_FAIL:-0}" = "1" ]; then echo "boom" >&2; exit 1; fi\nprintf \'%s\r\n\' "${STUB_AZ_VALUE-}"\n', { mode: 0o755 });
    const env = { ...process.env, PATH: `${stubDir}${process.platform === "win32" ? ";" : ":"}${process.env.PATH}`, STUB_AZ_VALUE: live ?? "", STUB_AZ_FAIL: fail ? "1" : "0" };
    for (const name of ["MYSQL_ADMIN_PASSWORD", "REVENUECAT_SECRET_API_KEY", "REVENUECAT_WEBHOOK_AUTHORIZATION", "ADMIN_ENTRA_CLIENT_SECRET"]) delete env[name];
    Object.assign(env, shell);
    // Never let this test reach the real Azure CLI: refuse to run unless the stub is what `az` resolves to.
    const resolved = spawnSync("bash", ["-c", "command -v az"], { encoding: "utf8", env }).stdout;
    assert.ok(resolved.includes("stub-az-"), `the stub az is not first on PATH (resolved ${JSON.stringify(resolved.trim())})`);
    const args = [verifyScript, "--deployment", deployment, ...(manifest ? ["--manifest", manifest] : [])];
    const r = spawnSync("bash", args, { encoding: "utf8", env });
    return { status: r.status, out: `${r.stdout}${r.stderr}` };
  } finally {
    rmSync(stubDir, { recursive: true, force: true });
  }
}
const ALL = { REVENUECAT_SECRET_API_KEY: "live-value-AAA", REVENUECAT_WEBHOOK_AUTHORIZATION: "live-value-AAA" };

test("verify-secure-parameters: matching values print MATCH, exit 0, and never a value", { skip: !haveBash }, () => {
  const r = runVerify({ live: "live-value-AAA", shell: ALL });
  assert.equal(r.status, 0, r.out);
  assert.equal((r.out.match(/\bMATCH\b/g) ?? []).length, 2, r.out);
  // the MySQL administrator password is not part of a normal deployment any more
  assert.ok(!/MYSQL_ADMIN_PASSWORD/.test(r.out), "the administrator password must not be asked for");
  assert.ok(!r.out.includes("live-value-AAA"), "a value was printed");
});

test("verify-secure-parameters: a different value is a MISMATCH and exits 1 without printing either value", { skip: !haveBash }, () => {
  const r = runVerify({ live: "other-value-BBB", shell: ALL });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /MISMATCH/);
  for (const v of ["live-value-AAA", "other-value-BBB"]) assert.ok(!r.out.includes(v), "a value was printed");
});

test("verify-secure-parameters: a missing variable, a placeholder and an unreadable live value all fail", { skip: !haveBash }, () => {
  const missing = runVerify({ live: "x", shell: {} });
  assert.equal(missing.status, 1);
  assert.match(missing.out, /MISSING\s+REVENUECAT_SECRET_API_KEY/);
  const placeholder = runVerify({ live: "x", shell: { ...ALL, REVENUECAT_SECRET_API_KEY: "__GATE:REVENUECAT_SECRET_API_KEY__" } });
  assert.equal(placeholder.status, 1);
  assert.match(placeholder.out, /PLACEHOLDER/);
  const unreadable = runVerify({ fail: true, shell: ALL });
  assert.equal(unreadable.status, 1);
  assert.match(unreadable.out, /UNKNOWN/);
});

test("verify-secure-parameters: a Key Vault reference in production is a mismatch (the deployment would replace it)", { skip: !haveBash }, () => {
  const r = runVerify({ live: "@Microsoft.KeyVault(VaultName=kv;SecretName=s)", shell: ALL });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /Key Vault reference/);
});

test("verify-secure-parameters: a setting that does not exist yet is NEW, not a failure", { skip: !haveBash }, () => {
  const r = runVerify({ live: "None", shell: ALL });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /NEW/);
});

test("verify-secure-parameters: a deployment without secure parameters is trivially fine; an unknown one is a usage error", { skip: !haveBash }, () => {
  assert.equal(runVerify({ deployment: "swa-web" }).status, 0);
  assert.equal(runVerify({ deployment: "nope" }).status, 2);
});

test("verify-secure-parameters: a variable no app setting receives is reported NOT-VERIFIABLE, never compared", { skip: !haveBash }, () => {
  // a creating deployment reads the administrator password: Azure never returns it, so it cannot be compared
  const dir = mkdtempSync(join(tmpdir(), "verify-manifest-"));
  try {
    const manifestFile = join(dir, "manifest.json");
    writeFileSync(manifestFile, JSON.stringify({
      scope: { subscriptionId: "00000000-0000-0000-0000-000000000001", resourceGroup: "rg-test" },
      apps: {},
      deployments: { create: { secureEnvironment: ["MYSQL_ADMIN_PASSWORD"] } },
    }));
    const r = runVerify({ live: "x", deployment: "create", manifest: manifestFile, shell: { MYSQL_ADMIN_PASSWORD: "a-secret-that-must-not-print" } });
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /NOT-VERIFIABLE\s+MYSQL_ADMIN_PASSWORD/);
    assert.ok(!r.out.includes("a-secret-that-must-not-print"));
    const missing = runVerify({ live: "x", deployment: "create", manifest: manifestFile, shell: {} });
    assert.equal(missing.status, 1);
    assert.match(missing.out, /MISSING\s+MYSQL_ADMIN_PASSWORD/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the production manifest leaves the MySQL server alone and asks for no administrator password", () => {
  const manifest = JSON.parse(readFileSync(join(scriptsDir, "..", "safety", "manifest.json"), "utf8"));
  const main = manifest.deployments.main;
  assert.equal(main.mysqlServer.mode, "existing");
  assert.ok(!main.secureEnvironment.includes("MYSQL_ADMIN_PASSWORD"));
  assert.ok(!main.touches.some((t) => /DBforMySQL\/flexibleServers$/i.test(t.type)), "the server is not a write target of the normal deployment");
  for (const [key, d] of Object.entries(manifest.deployments)) {
    if (key !== "main") assert.equal(d.mysqlServer, undefined, `${key} must not carry a MySQL policy`);
  }
});

test("verify-secure-parameters never echoes the compared values", () => {
  const source = readFileSync(verifyScript, "utf8");
  assert.ok(!/set\s+-[a-z]*x/.test(source), "xtrace would print every value");
  for (const line of source.split(/\r?\n/)) {
    if (/^\s*#/.test(line)) continue;
    if (/\b(echo|printf)\b/.test(line)) assert.ok(!/\$\{?(live_value|shell_value|!env)\b/.test(line), `value printed: ${line.trim()}`);
  }
  assert.ok(/LIVE_VALUE="\$live_value" SHELL_VALUE="\$shell_value" node/.test(source), "values must reach node through its environment");
});

// ---- Easy Auth: the resource replaces the whole configuration ----------------------------------------------------------
const authWorld = (liveProps, baseline) =>
  mutate((w) => {
    w.desiredResources.push({ type: "Microsoft.Web/sites/config", name: "app-test/authsettingsV2", properties: { platform: { enabled: true } } });
    w.whatif.changes.push({ resourceId: "a", type: "Microsoft.Web/sites/config", name: "app-test/authsettingsV2", changeType: "NoChange" });
    w.live.apps["app-test"].authsettingsv2 = { properties: { platform: { enabled: true }, ...liveProps } };
    if (baseline) w.manifest.defaults.authSettingsV2 = { "app-test": baseline };
  });

test("Easy Auth: a setting only production has is a customisation that the deployment would remove", () => {
  const custom = { login: { allowedExternalRedirectUrls: ["https://x.example"] } };
  failsWith(run(authWorld(custom)), "AUTH-LIVE-ONLY");
  // accepted only when the manifest records exactly that value as a known default or reviewed customisation
  const known = run(authWorld(custom, { "login.allowedExternalRedirectUrls": ["https://x.example"] }));
  assert.equal(known.verdict, "PASS", JSON.stringify(ids(known)));
  failsWith(run(authWorld({ login: { allowedExternalRedirectUrls: ["https://y.example"] } }, { "login.allowedExternalRedirectUrls": ["https://x.example"] })), "AUTH-LIVE-ONLY");
  // unset values are the same as not set
  const unset = run(authWorld({ login: { allowedExternalRedirectUrls: [], routes: null } }));
  assert.equal(unset.verdict, "PASS", JSON.stringify(ids(unset)));
});

// ---- manifest hygiene ---------------------------------------------------------------------------------------------------
test("every allowedChanges entry must be one of the documented shapes", () => {
  const withEntry = (entry) => run(mutate((w) => w.manifest.deployments.main.allowedChanges.push(entry)));
  const why = "reviewed and approved in the PR that adds this entry";
  failsWith(withEntry({ resource: "app-test", property: "siteConfig.alwaysOn" }), "MANIFEST-ENTRY-SHAPE");
  failsWith(withEntry({ resource: "app-test", property: "some thing with spaces", why }), "MANIFEST-ENTRY-SHAPE");
  failsWith(withEntry({ resource: "app-test", property: "siteConfig.alwaysOn", why, unexpected: 1 }), "MANIFEST-ENTRY-SHAPE");
  failsWith(withEntry({ whatif: true, resource: "x", property: "properties.a", why }), "MANIFEST-ENTRY-SHAPE");
  failsWith(withEntry({ property: "siteConfig.alwaysOn", why }), "MANIFEST-ENTRY-SHAPE");
  const ok = withEntry({ resource: "app-test", property: "setting:SOME_NAME", before: "a", after: "b", why });
  assert.ok(!ids(ok).includes("MANIFEST-ENTRY-SHAPE"), JSON.stringify(ids(ok)));
});
