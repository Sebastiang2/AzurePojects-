import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const sql = (name) => readFileSync(new URL(`../sql/${name}`, import.meta.url), "utf8");

test("adds a dedicated System provider instead of reusing a human sign-in provider", () => {
  const migration = sql("invi-activities-user-provider-system.sql");
  assert.match(migration, /'System'/);
  assert.match(migration, /@provider_baseline_type/);
  assert.match(migration, /@provider_system_type/);
  assert.match(migration, /unexpected UserTable\.Provider definition; no schema change was made/);
});

test("system user creation requires System and has no authentication or admin credentials", () => {
  const migration = sql("invi-activities-user-create.sql");
  assert.match(migration, /Provider\s*=\s*'System'/);
  assert.match(migration, /Password IS NULL AND Email IS NULL[\s\S]*PhoneNumber IS NULL AND ExternalId IS NULL/);
  assert.match(migration, /isActive = 1 AND isSuspended = 0 AND isAdmin = 0[\s\S]*isVerified = 0/);
  assert.match(migration, /COLUMN_TYPE LIKE '%''System''%'/);
});

// Both scripts must re-apply the column's current attributes (read from information_schema) instead of
// hard-coding or dropping them: a bare MODIFY COLUMN silently turns NOT NULL into NULL and resets the collation.
for (const name of ["invi-activities-user-provider-system.sql", "invi-activities-user-provider-system.rollback.sql"]) {
  test(`${name} preserves nullability, character set and collation`, () => {
    const script = sql(name);
    for (const attribute of ["CHARACTER_SET_NAME", "COLLATION_NAME", "IS_NULLABLE", "COLUMN_DEFAULT", "COLUMN_COMMENT"]) {
      assert.match(script, new RegExp(attribute), `${attribute} must be read from information_schema`);
    }
    assert.match(script, /' CHARACTER SET ', CHARACTER_SET_NAME,\s*' COLLATE ', COLLATION_NAME/);
    assert.match(script, /IF\(IS_NULLABLE = 'NO', ' NOT NULL', ' NULL'\)/);
    assert.match(script, /@provider_attributes IS NOT NULL/);
    assert.doesNotMatch(script, /NULL DEFAULT NULL'/, "must not hard-code a nullable column");
    assert.doesNotMatch(script, /utf8mb4_unicode_ci/, "must not hard-code a collation");
  });
}

test("adding System is metadata-only so it never rebuilds UserTable", () => {
  assert.match(sql("invi-activities-user-provider-system.sql"), /, ALGORITHM=INSTANT'\)/);
});

test("schema rollback refuses to remove System while any user row or the identity uses it", () => {
  const rollback = sql("invi-activities-user-provider-system.rollback.sql");
  assert.match(rollback, /SELECT COUNT\(\*\) FROM UserTable WHERE Provider = 'System'/);
  assert.match(rollback, /@system_provider_user_count = 0 AND @invi_activities_count = 0/);
  assert.match(rollback, /System cannot be removed while a user row uses it or Invi Activities exists/);
});

test("schema rollback blocks writers and rejects truncation while System is removed", () => {
  const rollback = sql("invi-activities-user-provider-system.rollback.sql");
  assert.match(rollback, /STRICT_ALL_TABLES/);
  assert.match(rollback, /ALGORITHM=COPY, LOCK=SHARED/);
  assert.doesNotMatch(rollback, /ALGORITHM=INSTANT/, "removing an enum member cannot be instant");
});

test("prod sets a verified creator id and the safety manifest allows that one new Data API setting", () => {
  const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
  const id = /^param dataApiActivityCreatorId = (\d+)$/m.exec(read("environments/prod.bicepparam"));
  assert.ok(id && Number(id[1]) > 0, "dataApiActivityCreatorId must be a positive UserId in prod");
  const manifest = JSON.parse(read("safety/manifest.json"));
  const allowed = JSON.stringify(manifest).includes('"ADMIN_ACTIVITY_CREATOR_ID"');
  assert.ok(allowed, "manifest must list ADMIN_ACTIVITY_CREATOR_ID as an allowed new setting");
});

test("origin-lock rollback is explicit and its WebDrafts brake is safety-gated", () => {
  const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
  const appService = read("modules/appservice.bicep");
  const manifest = JSON.parse(read("safety/manifest.json"));
  const dataApi = manifest.apps["app-invi-data-api-prod-001"];

  assert.match(appService, /ipSecurityRestrictions:\s*dataApiCloudflareOriginLockEnabled\s*\?\s*cloudflareOriginAccessRestrictions\s*:\s*\[\]/);
  assert.match(appService, /ipSecurityRestrictionsDefaultAction:\s*dataApiCloudflareOriginLockEnabled\s*\?\s*'Deny'\s*:\s*'Allow'/);
  assert.match(appService, /effectiveWebDraftsTrustCloudflareConnectingIp\s*=\s*dataApiCloudflareOriginLockEnabled\s*&&\s*webDraftsTrustCloudflareConnectingIp/);
  assert.match(appService, /WebDrafts__TrustCloudflareConnectingIp:\s*toLower\(string\(effectiveWebDraftsTrustCloudflareConnectingIp\)\)/);
  assert.ok(dataApi.required.includes("WebDrafts__PlaceSuggestionsPaused"));
  assert.equal(dataApi.mustEqual.WebDrafts__PlaceSuggestionsPaused, "true");
  assert.ok(manifest.deployments.main.allowedNewSettings["app-invi-data-api-prod-001"].includes("WebDrafts__PlaceSuggestionsPaused"));
});

test("origin lock has the exact reviewed ranges and never applies main restrictions to SCM", () => {
  const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
  const appService = read("modules/appservice.bicep");
  const params = read("environments/prod.bicepparam");
  const manifest = JSON.parse(read("safety/manifest.json"));
  const deployment = manifest.deployments.main;
  const declared = [...appService.matchAll(/\{ name: '([^']+)', priority: (\d+), action: 'Allow', ipAddress: '([^']+)' \}/g)]
    .map((m) => ({ name: m[1], priority: Number(m[2]), action: "Allow", ipAddress: m[3] }));
  assert.equal(declared.length, 22);
  assert.deepEqual(declared, deployment.originLock.rules);
  assert.equal(declared.filter((r) => r.name.includes("-v4-")).length, 15);
  assert.equal(declared.filter((r) => r.name.includes("-v6-")).length, 7);
  assert.match(params, /^param dataApiCloudflareOriginLockEnabled = false$/m);
  assert.match(params, /^param webDraftsTrustCloudflareConnectingIp = false$/m);
  assert.match(appService, /scmIpSecurityRestrictions: \[\]/);
  assert.match(appService, /scmIpSecurityRestrictionsDefaultAction: 'Allow'/);
  assert.match(appService, /scmIpSecurityRestrictionsUseMain: false/);
  assert.deepEqual(deployment.allowedChanges.map(({ resource, property, before, after }) => ({ resource, property, before, after })), [
    { resource: "app-invi-data-api-prod-001", property: "siteConfig.ipSecurityRestrictionsDefaultAction", before: "Allow", after: "Deny" },
    { resource: "app-invi-data-api-prod-001", property: "siteConfig.ipSecurityRestrictionsDefaultAction", before: "Deny", after: "Allow" },
  ]);
});
