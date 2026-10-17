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

test("schema rollback refuses to remove System after the identity exists", () => {
  const rollback = sql("invi-activities-user-provider-system.rollback.sql");
  assert.match(rollback, /@invi_activities_count = 0/);
  assert.match(rollback, /System cannot be removed while Invi Activities exists/);
});
