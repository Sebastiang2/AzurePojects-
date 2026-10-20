import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("production enables only warm-up while template defaults remain disabled", () => {
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

test("activation permits only the two warm-up settings, not Health Check", () => {
  const manifest = JSON.parse(read("safety/manifest.json"));
  const main = manifest.deployments.main;
  const settings = main.allowedNewSettings?.["app-invi-data-api-prod-001"] ?? [];
  assert.deepEqual(settings.filter((setting) => setting.startsWith("WEBSITE_WARMUP_")), [
    "WEBSITE_WARMUP_PATH",
    "WEBSITE_WARMUP_STATUSES",
  ]);
  assert.deepEqual(main.allowedRemovedSettings?.["app-invi-data-api-prod-001"], [
    "WEBSITE_WARMUP_PATH",
    "WEBSITE_WARMUP_STATUSES",
  ]);
  assert.ok(!(main.allowedChanges ?? []).some((change) => change.property === "siteConfig.healthCheckPath"));
});
