import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("production keeps Data API readiness warm-up explicitly disabled by default", () => {
  const parameters = read("environments/prod.bicepparam");
  assert.match(parameters, /^param dataApiReadinessWarmupEnabled = false$/m);
});

test("warm-up accepts only the database-backed readiness endpoint and HTTP 200", () => {
  const module = read("modules/appservice.bicep");
  assert.match(module, /healthCheckPath:\s*dataApiReadinessWarmupEnabled \? '\/v1\/extras\/ready' : null/);
  assert.match(module, /WEBSITE_WARMUP_PATH:\s*'\/v1\/extras\/ready'/);
  assert.match(module, /WEBSITE_WARMUP_STATUSES:\s*'200'/);
  assert.doesNotMatch(module, /WEBSITE_WARMUP_PATH:\s*'\/v1\/extras\/is-up'/);
});

test("warm-up settings are omitted when disabled so a reviewed false switch is a rollback", () => {
  const module = read("modules/appservice.bicep");
  assert.match(module, /dataApiReadinessWarmupEnabled \? \{[\s\S]*WEBSITE_WARMUP_PATH[\s\S]*\} : \{\}/);
  assert.match(module, /healthCheckPath:[\s\S]*: null/);
});
