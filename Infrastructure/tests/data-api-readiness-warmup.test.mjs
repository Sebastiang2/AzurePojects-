import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("canonical production preserves the active dedicated warm-up while Health Check stays off", () => {
  const parameters = read("environments/prod.bicepparam");
  const main = read("main.bicep");
  const module = read("modules/appservice.bicep");
  assert.match(parameters, /^param dataApiReadinessWarmupEnabled = true$/m);
  assert.match(parameters, /^param dataApiHealthCheckEnabled = false$/m);
  for (const disabled of ["webDraftsEnabled", "webDraftsTrustCloudflareConnectingIp", "dataApiCloudflareOriginLockEnabled", "placeSuggestionsEnabled"]) {
    assert.match(parameters, new RegExp(`^param ${disabled} = false$`, "m"));
  }
  assert.match(parameters, /^param webDraftsPlaceSuggestionsPaused = true$/m);
  for (const source of [main, module]) {
    assert.match(source, /^param dataApiReadinessWarmupEnabled bool = false$/m);
    assert.match(source, /^param dataApiHealthCheckEnabled bool = false$/m);
  }
});

test("main passes independent controls through to the App Service module", () => {
  const main = read("main.bicep");
  assert.match(main, /^\s+dataApiReadinessWarmupEnabled: dataApiReadinessWarmupEnabled$/m);
  assert.match(main, /^\s+dataApiHealthCheckEnabled: dataApiHealthCheckEnabled$/m);
});

test("Health Check uses the readiness endpoint independently of startup warm-up", () => {
  const module = read("modules/appservice.bicep");
  assert.match(module, /healthCheckPath:\s*dataApiHealthCheckEnabled \? '\/v1\/extras\/ready' : null/);
  assert.doesNotMatch(module, /healthCheckPath:\s*dataApiReadinessWarmupEnabled/);
});

test("startup warm-up independently requires HTTP 200 from the readiness endpoint", () => {
  const module = read("modules/appservice.bicep");
  assert.match(module, /dataApiReadinessWarmupEnabled \? \{\s*WEBSITE_WARMUP_PATH:\s*'\/v1\/extras\/ready'\s*WEBSITE_WARMUP_STATUSES:\s*'200'\s*\} : \{\}/);
  assert.match(module, /WEBSITE_WARMUP_PATH:\s*'\/v1\/extras\/ready'/);
  assert.match(module, /WEBSITE_WARMUP_STATUSES:\s*'200'/);
  assert.doesNotMatch(module, /WEBSITE_WARMUP_PATH:\s*'\/v1\/extras\/is-up'/);
  assert.doesNotMatch(module, /dataApiHealthCheckEnabled \? \{\s*WEBSITE_WARMUP_PATH/);
});

test("full main deployment cannot silently activate or remove warm-up", () => {
  const manifest = JSON.parse(read("safety/manifest.json"));
  const main = manifest.deployments.main;
  const settings = main.allowedNewSettings?.["app-invi-data-api-prod-001"] ?? [];
  assert.deepEqual(settings.filter((setting) => setting.startsWith("WEBSITE_WARMUP_")), []);
  assert.deepEqual(main.allowedRemovedSettings?.["app-invi-data-api-prod-001"] ?? [], []);
  assert.ok(!(main.allowedChanges ?? []).some((change) => change.property === "siteConfig.healthCheckPath"));
});

test("dedicated deployment can write only Data API App Settings", () => {
  const manifest = JSON.parse(read("safety/manifest.json"));
  const deployment = manifest.deployments["data-api-warmup"];
  const template = read("data-api-warmup.bicep");
  const parameters = read("environments/prod.data-api-warmup.bicepparam");
  assert.deepEqual(deployment.touches, [{ type: "Microsoft.Web/sites/config", name: "app-invi-data-api-prod-001/appsettings" }]);
  assert.deepEqual(deployment.allowedNewSettings["app-invi-data-api-prod-001"], [
    "WebDrafts__PlaceSuggestionsPaused", "WEBSITE_WARMUP_PATH", "WEBSITE_WARMUP_STATUSES",
  ]);
  assert.deepEqual(deployment.allowedRemovedSettings["app-invi-data-api-prod-001"], [
    "WEBSITE_WARMUP_PATH", "WEBSITE_WARMUP_STATUSES",
  ]);
  assert.deepEqual(deployment.allowedChanges, []);
  assert.match(template, /resource dataApi 'Microsoft\.Web\/sites@2024-11-01' existing/);
  assert.match(template, /resource dataAppInsights 'Microsoft\.Insights\/components@2020-02-02' existing/);
  assert.match(template, /resource dataApiAppSettings 'Microsoft\.Web\/sites\/config@2024-11-01' =/);
  assert.doesNotMatch(template, /resource authApi |healthCheckPath:/);
  assert.match(parameters, /^param dataApiReadinessWarmupEnabled = true$/m);
  assert.doesNotMatch(parameters, /^param dataApiHealthCheckEnabled = true$/m);
  assert.match(template, /dataApiReadinessWarmupEnabled \? \{\s*WEBSITE_WARMUP_PATH:\s*'\/v1\/extras\/ready'\s*WEBSITE_WARMUP_STATUSES:\s*'200'\s*\} : \{\}/);
});

test("unsafe sparse web configuration deployment is absent", () => {
  const manifest = JSON.parse(read("safety/manifest.json"));
  assert.equal(manifest.deployments["data-api-origin-lock"], undefined);
  const deploy = read("scripts/deploy.sh");
  assert.doesNotMatch(deploy, /data-api-origin-lock/);
  assert.match(read("scripts/origin-lock-patch-plan.mjs"), /method: "PATCH"/);
});


test("dedicated full settings bag keeps the canonical Data API setting names", () => {
  const keys = (source) => {
    const body = source.match(/resource dataApiAppSettings[\s\S]*?properties: union\(\{([\s\S]*?)\}, dataApiReadinessWarmupEnabled/);
    assert.ok(body, "Data API App Settings bag must be present");
    return [...body[1].matchAll(/^\s+([A-Za-z][A-Za-z0-9_]*):/gm)].map((match) => match[1]).sort();
  };
  assert.deepEqual(keys(read("data-api-warmup.bicep")), keys(read("modules/appservice.bicep")));
});

test("dedicated production parameters do not drift from the canonical production values", () => {
  const assignments = (path) => new Map([...read(path).matchAll(/^param ([A-Za-z][A-Za-z0-9_]*) = (.+)$/gm)]
    .map((match) => [match[1], match[2]]));
  const canonical = assignments("environments/prod.bicepparam");
  const dedicated = assignments("environments/prod.data-api-warmup.bicepparam");
  for (const [name, value] of dedicated) {
    if (name === "databaseUser") {
      assert.equal(value, canonical.get("mysqlAdminUsername"));
    } else if (canonical.has(name)) {
      assert.equal(value, canonical.get(name), `${name} must match the canonical production parameter`);
    }
  }
});
