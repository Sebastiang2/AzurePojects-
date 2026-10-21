import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { planOriginLockPatch, webConfigUrl } from "../../origin-lock-patch-plan.mjs";

const rules = JSON.parse(readFileSync(new URL("../../../safety/manifest.json", import.meta.url), "utf8")).deployments.main.originLock.rules;
const settings = Object.entries({
  "WebDrafts__Enabled": "false",
  "WebDrafts__TrustCloudflareConnectingIp": "false",
  "PlaceSuggestions__Enabled": "false",
  "WebDrafts__PlaceSuggestionsPaused": "true",
  WEBSITE_WARMUP_PATH: "/v1/extras/ready",
  WEBSITE_WARMUP_STATUSES: "200",
}).map(([name, value]) => ({ name, value }));
const world = (locked = false) => ({
  state: locked ? "rollback" : "enable",
  rules: structuredClone(rules),
  appSettings: structuredClone(settings),
  web: { properties: {
    alwaysOn: true,
    linuxFxVersion: "DOTNETCORE|10.0",
    healthCheckPath: null,
    scmIpSecurityRestrictionsUseMain: false,
    scmIpSecurityRestrictions: [{ name: "Allow all", priority: 2147483647, action: "Allow" }],
    scmIpSecurityRestrictionsDefaultAction: null,
    ipSecurityRestrictions: locked ? structuredClone(rules) : [{ name: "Allow all", priority: 2147483647, action: "Allow" }],
    ipSecurityRestrictionsDefaultAction: locked ? "Deny" : null,
    minTlsVersion: "1.2",
    scmMinTlsVersion: "1.2",
    http20Enabled: true,
    webSocketsEnabled: true,
    siteAuthEnabled: false,
    vnetName: "reviewed-vnet",
  } },
});

test("activation and rollback produce only a PATCH of the two main-site properties", () => {
  for (const locked of [false, true]) {
    const input = world(locked);
    const original = structuredClone(input.web);
    const plan = planOriginLockPatch(input);
    assert.equal(plan.method, "PATCH");
    assert.equal(plan.url, webConfigUrl);
    assert.deepEqual(Object.keys(plan.body.properties).sort(), ["ipSecurityRestrictions", "ipSecurityRestrictionsDefaultAction"]);
    assert.equal(plan.body.properties.ipSecurityRestrictions.length, locked ? 0 : 22);
    assert.equal(plan.body.properties.ipSecurityRestrictionsDefaultAction, locked ? "Allow" : "Deny");
    assert.deepEqual(input.web, original);
    assert.doesNotMatch(JSON.stringify(plan), /scmIpSecurity|siteAuth|vnetName|appSettings/);
  }
});

test("unknown direct-origin rule, changed range, SCM inheritance or unsafe feature flag blocks planning", () => {
  const cases = [
    (x) => x.web.properties.ipSecurityRestrictions.push({ name: "Unknown", priority: 200, action: "Allow", ipAddress: "10.0.0.0/8" }),
    (x) => x.rules[0].ipAddress = "0.0.0.0/0",
    (x) => x.web.properties.scmIpSecurityRestrictionsUseMain = true,
    (x) => x.appSettings.find((s) => s.name === "WebDrafts__Enabled").value = "true",
  ];
  for (const mutate of cases) {
    const input = world(true);
    mutate(input);
    assert.throws(() => planOriginLockPatch(input));
  }
});

test("Azure's capitalized False setting is accepted as disabled", () => {
  const input = world();
  input.appSettings.find((s) => s.name === "WebDrafts__Enabled").value = "False";
  assert.equal(planOriginLockPatch(input).body.properties.ipSecurityRestrictions.length, 22);
});
