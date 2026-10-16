// What the gate must do when a deployment CREATES an App Service (Studio and the onboarding API were the first): a site that does not
// exist has nothing to read, but its settings still have to satisfy the manifest, TLS can be added to a bound host name as a separate approved
// step, and the deploy identity of an app (a user-assigned identity) gets a role assignment whose name the gate can predict.
// Synthetic data only (fixtures.mjs); nothing here is production data.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { appsToVerify } from "../apps-to-verify.mjs";
import { armGuid } from "../lib/guid.mjs";
import { baseWorld, copy, ids, run, RG, SUB } from "./fixtures.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const PREFIX = `/subscriptions/${SUB}/resourceGroups/${RG}/providers`;
const bag = (world) => world.desiredResources.find((r) => r.name === "app-test/appsettings").properties;

/** The base world with the site removed from the live side: the template would create it. */
function newSiteWorld() {
  const world = copy(baseWorld());
  delete world.live.apps["app-test"];
  world.live.resources = world.live.resources.filter((r) => r.name !== "app-test");
  return world;
}

// ---- a new site: no live evidence is needed, and the settings are still judged ----------------------------------------------------------
test("a site that does not exist yet is not an evidence failure", () => {
  const report = run(newSiteWorld());
  for (const id of ["EVIDENCE-APPSETTINGS", "EVIDENCE-SITE", "EVIDENCE-UNREADABLE", "EVIDENCE-CALL"]) assert.ok(!ids(report).includes(id), id);
  assert.ok(ids(report, "info").includes("BAG-NEW-SITE"));
  assert.ok(ids(report, "info").includes("SITE-NEW"));
});

test("a new site must still declare the required settings", () => {
  const world = newSiteWorld();
  delete bag(world).A;
  assert.ok(ids(run(world)).includes("BAG-REQUIRED-MISSING"));
});

test("a new site must still satisfy the invariants (a flag that has to be off)", () => {
  const world = newSiteWorld();
  bag(world).FLAG = "true";
  assert.ok(ids(run(world)).includes("BAG-INVARIANT"));
});

test("a new site may not declare a secret as a literal, but a Key Vault reference is fine", () => {
  const literal = newSiteWorld();
  bag(literal).PAYMENT_API_KEY = "a-plain-looking-value-123";
  assert.ok(ids(run(literal)).includes("BAG-SECRET-LITERAL"));
  const vaulted = newSiteWorld();
  bag(vaulted).PAYMENT_API_KEY = "@Microsoft.KeyVault(VaultName=kv-test;SecretName=payment-api-key)";
  assert.ok(!ids(run(vaulted)).includes("BAG-SECRET-LITERAL"));
});

test("a new site: a secure parameter must be wired the way the manifest says", () => {
  const world = newSiteWorld();
  bag(world).SECRET_KEY = "typed-in-the-template";
  const failures = ids(run(world));
  assert.ok(failures.includes("BAG-SECURE-FEED-MISSING"));
  assert.ok(failures.includes("BAG-SECRET-LITERAL"));
});

test("an existing site is still judged as before (control)", () => {
  const world = copy(baseWorld());
  delete bag(world).A;
  const report = run(world);
  assert.ok(ids(report).includes("BAG-REQUIRED-MISSING"));
  assert.ok(!ids(report, "info").includes("BAG-NEW-SITE"));
});

// ---- TLS as a second, approved step -----------------------------------------------------------------------------------------------------
function bindingWorld() {
  const world = copy(baseWorld());
  world.live.apps["app-test"].hostnamebindings = { value: [{ name: "app-test/studio.example.test", properties: { sslState: "Disabled", hostNameType: "Verified" } }] };
  world.desiredResources.push({
    type: "Microsoft.Web/sites/hostNameBindings",
    name: "app-test/studio.example.test",
    properties: { siteName: "app-test", hostNameType: "Verified", sslState: "SniEnabled" },
  });
  return world;
}
const sslAllowance = (extra = {}) => ({ resource: "app-test/studio.example.test", property: "sslState", before: "Disabled", after: "SniEnabled", why: "second step: TLS for the bound host name", ...extra });

test("switching a bound host name from no TLS to SNI is refused unless the manifest names it", () => {
  assert.ok(ids(run(bindingWorld())).includes("BINDING-SSL-CHANGE"));
});

test("the manifest can approve exactly that switch", () => {
  const world = bindingWorld();
  world.manifest.deployments.main.allowedChanges = [sslAllowance()];
  const report = run(world);
  assert.ok(!ids(report).includes("BINDING-SSL-CHANGE"));
  assert.ok(ids(report, "allowed").includes("BINDING-SSL-CHANGE"));
});

test("an approval for another before/after pair, or another host name, does not cover it", () => {
  for (const extra of [{ before: "SniEnabled" }, { after: "IpBasedEnabled" }, { resource: "app-test/other.example.test" }]) {
    const world = bindingWorld();
    world.manifest.deployments.main.allowedChanges = [sslAllowance(extra)];
    assert.ok(ids(run(world)).includes("BINDING-SSL-CHANGE"), JSON.stringify(extra));
  }
});

// ---- the deploy identity of an app: a user-assigned identity gets Website Contributor on the app ----------------------------------------
const SITE_ID = `${PREFIX}/Microsoft.Web/sites/app-test`;
const IDENTITY_ID = `${PREFIX}/Microsoft.ManagedIdentity/userAssignedIdentities/id-deploy`;
const WEBSITE_CONTRIBUTOR = `/subscriptions/${SUB}/providers/Microsoft.Authorization/roleDefinitions/de139f84-1756-47ae-9be6-808fbbe84772`;
const DEPLOY_PRINCIPAL = "33333333-3333-3333-3333-333333333333";
const guidArgs = `'${SITE_ID}', reference('${IDENTITY_ID}', '2024-11-30').principalId, '${WEBSITE_CONTRIBUTOR}'`;

function deployIdentityWorld({ identityLive = true } = {}) {
  const world = copy(baseWorld());
  world.desiredResources.push({
    type: "Microsoft.Authorization/roleAssignments",
    name: `[guid(${guidArgs})]`,
    id: `[extensionResourceId('${SITE_ID}', 'Microsoft.Authorization/roleAssignments', guid(${guidArgs}))]`,
    properties: { roleDefinitionId: WEBSITE_CONTRIBUTOR, principalId: `[reference('${IDENTITY_ID}', '2024-11-30').principalId]` },
  });
  if (identityLive) {
    world.live.identities.push({ name: "id-deploy", principalId: DEPLOY_PRINCIPAL });
    world.live.fic["id-deploy"] = [];
    world.manifest.identities.known["id-deploy"] = {};
  }
  return world;
}
const predicted = armGuid(SITE_ID, DEPLOY_PRINCIPAL, WEBSITE_CONTRIBUTOR);

test("a role assignment for a user-assigned identity gets a predicted name, and a new one is refused until the manifest lists that name", () => {
  const report = run(deployIdentityWorld());
  const refused = report.findings.find((f) => f.id === "RBAC-NEW" && f.severity === "fail");
  assert.ok(refused, "RBAC-NEW is expected");
  assert.equal(refused.subject, predicted);
  assert.ok(!ids(report).includes("RBAC-UNVERIFIABLE"));
});

test("the manifest can approve that exact assignment", () => {
  const world = deployIdentityWorld();
  world.manifest.deployments.main.allowedCreates = [{ type: "Microsoft.Authorization/roleAssignments", name: predicted, why: "Website Contributor for the deploy identity of app-test" }];
  const report = run(world);
  assert.ok(ids(report, "allowed").includes("RBAC-NEW"));
  assert.ok(!ids(report).includes("RBAC-NEW"));
});

test("without the identity there is no principal to predict from: unverifiable, never accepted", () => {
  assert.ok(ids(run(deployIdentityWorld({ identityLive: false }))).includes("RBAC-UNVERIFIABLE"));
});

// ---- which apps deploy.sh checks for state Running ------------------------------------------------------------------------------------
test("apps-to-verify: every app, except one that another deployment introduces and that does not exist yet", () => {
  const manifest = { apps: { old: {}, "new-api": { introducedBy: "onboardingapi" }, "new-web": { introducedBy: "studio" } } };
  assert.deepEqual(appsToVerify(manifest, "main", ["old"]), ["old"], "an unrelated deployment is not blocked by apps that are not there yet");
  assert.deepEqual(appsToVerify(manifest, "onboardingapi", ["old"]), ["old", "new-api"], "the introducing deployment must find its app running");
  assert.deepEqual(appsToVerify(manifest, "main", ["old", "NEW-API"]), ["old", "new-api"], "once the app exists it is checked like any other (case-insensitive)");
  assert.deepEqual(appsToVerify(manifest, "main", []), ["old"], "no site exists at all: only apps that another deployment introduces are excused, the others are still required");
});

test("apps-to-verify: an unreadable list of sites excuses nothing (fail-closed)", () => {
  const manifest = { apps: { old: {}, "new-api": { introducedBy: "onboardingapi" } } };
  assert.deepEqual(appsToVerify(manifest, "main", ["*"]), ["old", "new-api"]);
});

// ---- the live collector --------------------------------------------------------------------------------------------------------------
function collect({ listFails }) {
  const dir = mkdtempSync(join(tmpdir(), "collect-live-"));
  try {
    mkdirSync(join(dir, "bin"));
    const log = join(dir, "az.log");
    writeFileSync(
      join(dir, "bin", "az"),
      `#!/usr/bin/env bash
echo "$*" >> "${log}"
case "$*" in
  *"resource list"*) ${listFails ? "exit 1" : `echo '[{"type":"Microsoft.Web/sites","name":"app-existing"}]'`} ;;
  *) echo '{}' ;;
esac
`,
    );
    chmodSync(join(dir, "bin", "az"), 0o755);
    const out = join(dir, "out");
    const result = spawnSync("bash", [join(here, "..", "collect-live.sh"), out, SUB, RG, "app-existing", "app-new"], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${join(dir, "bin")}:${process.env.PATH}` },
    });
    return { log: readFileSync(log, "utf8"), calls: JSON.parse(readFileSync(join(out, "calls.json"), "utf8")), stdout: result.stdout };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("collect-live reads an existing app and leaves an app that is not in the resource list alone", { skip: process.platform === "win32" }, () => {
  const { log, calls, stdout } = collect({ listFails: false });
  assert.match(log, /webapp show -g rg-test -n app-existing /);
  assert.doesNotMatch(log, /-n app-new/, "no call may be made for an app that does not exist");
  assert.ok(!calls.some((c) => c.name.startsWith("apps/app-new")), "and none may be recorded as failed");
  assert.match(stdout, /app-new does not exist yet/);
});

test("collect-live never concludes that an app is absent from a resource list it could not read", { skip: process.platform === "win32" }, () => {
  const { log, calls } = collect({ listFails: true });
  assert.match(log, /-n app-new/, "the app is read as usual: absence has not been proven");
  assert.ok(calls.some((c) => c.name === "resources" && c.rc !== 0), "and the failed list is recorded as a failed call, which stops the gate");
});
