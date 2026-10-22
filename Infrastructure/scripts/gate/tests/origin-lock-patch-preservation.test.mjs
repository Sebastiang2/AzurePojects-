// Offline preservation harness. No non-production App Service exists in the subscription, so the PATCH semantics are
// MODELLED here (JSON merge: objects merge, arrays and scalars replace; omitted properties are kept) and compared with
// the destructive replace semantics of a sparse PUT. This proves the plan body touches only the two perimeter fields and
// that the comparison tool catches a reset; it does NOT replace the approved before/after check against the real App Service.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { compareWebConfig } from "../../compare-web-config.mjs";
import { planOriginLockPatch } from "../../origin-lock-patch-plan.mjs";

const manifest = JSON.parse(readFileSync(new URL("../../../safety/manifest.json", import.meta.url), "utf8"));
const rules = manifest.deployments.main.originLock.rules;

const baseline = () => ({
  properties: {
    // runtime / always on / TLS / protocol
    linuxFxVersion: "DOTNETCORE|10.0", alwaysOn: true, minTlsVersion: "1.2", scmMinTlsVersion: "1.2", ftpsState: "FtpsOnly",
    http20Enabled: true, webSocketsEnabled: true, healthCheckPath: null, use32BitWorkerProcess: false,
    // VNet integration
    vnetName: "vnet-invi-prod", vnetRouteAllEnabled: false, vnetPrivatePortsCount: 0,
    // authentication
    siteAuthEnabled: false, publicNetworkAccess: "Enabled",
    // SCM separation
    scmIpSecurityRestrictionsUseMain: false, scmIpSecurityRestrictionsDefaultAction: "Allow",
    scmIpSecurityRestrictions: [{ ipAddress: "Any", action: "Allow", priority: 2147483647, name: "Allow all" }],
    // unrelated
    cors: { allowedOrigins: ["https://invi.lol"], supportCredentials: false }, defaultDocuments: ["index.html"],
    autoHealEnabled: false, requestTracingEnabled: false, detailedErrorLoggingEnabled: false,
    // main perimeter
    ipSecurityRestrictions: [{ ipAddress: "Any", action: "Allow", priority: 2147483647, name: "Allow all" }],
    ipSecurityRestrictionsDefaultAction: "Allow",
  },
});
const appSettings = [
  ["WebDrafts__Enabled", "false"], ["WebDrafts__TrustCloudflareConnectingIp", "false"], ["PlaceSuggestions__Enabled", "false"],
  ["WebDrafts__PlaceSuggestionsPaused", "true"], ["WEBSITE_WARMUP_PATH", "/v1/extras/ready"], ["WEBSITE_WARMUP_STATUSES", "200"],
].map(([name, value]) => ({ name, value }));

const merge = (target, patch) => {
  if (patch === null || typeof patch !== "object" || Array.isArray(patch)) return structuredClone(patch);
  const out = { ...target };
  for (const [key, value] of Object.entries(patch)) out[key] = merge(target?.[key], value);
  return out;
};
const applyPatch = (live, plan) => merge(live, plan.body);
const applySparsePut = (_live, plan) => structuredClone(plan.body);

const plan = (state, web) => planOriginLockPatch({ state, web, appSettings, rules });
const liveWithRules = () => {
  const web = baseline();
  web.properties.ipSecurityRestrictions = rules.map((r) => ({ ...r, tag: "Default", description: "managed" }));
  web.properties.ipSecurityRestrictionsDefaultAction = "Deny";
  return web;
};

test("the plan body contains exactly the two perimeter fields", () => {
  for (const [state, web] of [["enable", baseline()], ["rollback", liveWithRules()]]) {
    const body = plan(state, web).body;
    assert.deepEqual(Object.keys(body), ["properties"]);
    assert.deepEqual(Object.keys(body.properties).sort(), ["ipSecurityRestrictions", "ipSecurityRestrictionsDefaultAction"]);
  }
});

test("enable changes only the perimeter; VNet, runtime, Always On, TLS, auth, SCM, CORS and the rest are preserved", () => {
  const before = baseline();
  const after = applyPatch(before, plan("enable", before));
  const { changed, unexpected } = compareWebConfig(before, after);
  assert.deepEqual(unexpected, []);
  assert.deepEqual(changed.sort(), ["ipSecurityRestrictions", "ipSecurityRestrictionsDefaultAction"]);
  assert.equal(after.properties.ipSecurityRestrictionsDefaultAction, "Deny");
  assert.equal(after.properties.ipSecurityRestrictions.length, 22);
  for (const key of ["vnetName", "vnetRouteAllEnabled", "alwaysOn", "minTlsVersion", "scmMinTlsVersion", "siteAuthEnabled",
    "scmIpSecurityRestrictionsUseMain", "scmIpSecurityRestrictions", "cors", "linuxFxVersion"]) {
    assert.deepEqual(after.properties[key], before.properties[key], key);
  }
});

test("rollback returns to the baseline perimeter and preserves everything else", () => {
  const live = liveWithRules();
  const after = applyPatch(live, plan("rollback", live));
  assert.equal(after.properties.ipSecurityRestrictionsDefaultAction, "Allow");
  assert.deepEqual(after.properties.ipSecurityRestrictions, []);
  assert.deepEqual(compareWebConfig(live, after).unexpected, []);
});

test("a PATCH on config/web cannot touch App Settings (warm-up and feature flags are a separate resource)", () => {
  const body = plan("enable", baseline()).body;
  assert.equal(JSON.stringify(body).includes("WEBSITE_WARMUP"), false);
  assert.equal(JSON.stringify(body).includes("WebDrafts__"), false);
});

test("negative control: a sparse PUT-style replace resets unrelated settings and the comparison catches it", () => {
  const before = baseline();
  const after = applySparsePut(before, plan("enable", before));
  const { unexpected } = compareWebConfig(before, after);
  for (const path of ["vnetName", "alwaysOn", "minTlsVersion", "siteAuthEnabled", "scmIpSecurityRestrictionsUseMain"]) {
    assert.ok(unexpected.includes(path), `${path} should be reported as reset`);
  }
});

test("the comparison reports paths only, never values", () => {
  const { changed } = compareWebConfig({ properties: { a: "secret-a" } }, { properties: { a: "secret-b" } });
  assert.deepEqual(changed, ["a"]);
});

test("the plan refuses to run when SCM, Always On, TLS or auth have drifted from the baseline", () => {
  for (const mutate of [(p) => (p.scmIpSecurityRestrictionsUseMain = true), (p) => (p.alwaysOn = false),
    (p) => (p.minTlsVersion = "1.0"), (p) => (p.siteAuthEnabled = true)]) {
    const web = baseline();
    mutate(web.properties);
    assert.throws(() => plan("enable", web), /differs from the reviewed baseline/);
  }
});
