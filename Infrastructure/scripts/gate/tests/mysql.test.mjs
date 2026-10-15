// The MySQL administrator password: both APIs connect as the administrator and Azure never returns the password, so the gate
// protects it structurally. These tests pin every rule; nothing here touches Azure. Run:
//   node --test Infrastructure/scripts/gate/tests/mysql.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { baseWorld, run, copy, ids } from "./fixtures.mjs";

const TYPE = "Microsoft.DBforMySQL/flexibleServers";
const SERVER = "mysql-test";
const WHY = "approved in this test: the reason is written down";

const liveServer = () => ({
  name: SERVER,
  location: "swedencentral",
  version: "8.0.21",
  sku: { name: "Standard_B2s", tier: "Burstable" },
  administratorLogin: "adm",
  network: { publicNetworkAccess: "Disabled" },
  backup: { backupRetentionDays: 14, geoRedundantBackup: "Disabled" },
  highAvailability: { mode: "Disabled" },
  storage: { storageSizeGb: 32, autoGrow: "Enabled", autoIoScaling: "Disabled" },
});

const desiredServer = (extra = {}) => ({
  type: TYPE,
  name: SERVER,
  location: "swedencentral",
  sku: { name: "Standard_B2s", tier: "Burstable" },
  properties: {
    version: "8.0.21",
    network: { publicNetworkAccess: "Disabled" },
    backup: { backupRetentionDays: 14, geoRedundantBackup: "Disabled" },
    highAvailability: { mode: "Disabled" },
    storage: { storageSizeGB: 32, autoGrow: "Enabled", autoIoScaling: "Disabled" },
    ...extra,
  },
});

/** @param mode manifest mode (undefined = no mysqlServer entry)  @param o exists/declared/props/changeType */
function world(mode, { exists = true, declared = false, props = {}, changeType, allowCreate = false } = {}) {
  const w = copy(baseWorld());
  if (mode !== undefined) w.manifest.deployments.main.mysqlServer = { name: SERVER, mode, why: WHY };
  if (exists) {
    w.live.resources.push({ type: TYPE, name: SERVER });
    w.live.mysql = liveServer();
  }
  if (declared) {
    w.desiredResources.push(desiredServer(props));
    w.whatif.changes.push({ resourceId: "m", type: TYPE, name: SERVER, changeType: changeType ?? (exists ? "NoChange" : "Create"), deltas: [] });
  }
  if (allowCreate) {
    w.manifest.deployments.main.allowedCreates.push({ type: TYPE, name: SERVER, why: WHY });
    w.manifest.deployments.main.touches.push({ type: TYPE, name: SERVER });
  }
  return w;
}
const has = (report, id, severity = "fail") => assert.ok(ids(report, severity).includes(id), `expected ${id} (${severity}) among ${JSON.stringify(ids(report, severity))}`);
const lacks = (report, id) => assert.ok(!ids(report).includes(id), `did not expect ${id}`);

// ---- mode existing: the server is not written at all ------------------------------------------------------------------
test("existing: a server that is not part of the deployment is left alone, and the report says why the password is safe", () => {
  const r = run(world("existing"));
  assert.equal(r.verdict, "PASS", JSON.stringify(ids(r)));
  has(r, "DB-PASSWORD-KEPT", "info");
});

test("existing: a template that writes the server is rejected, with or without a password", () => {
  has(run(world("existing", { declared: true })), "DB-SERVER-WRITTEN");
  const withPassword = run(world("existing", { declared: true, props: { administratorLoginPassword: "__GATE:MYSQL_ADMIN_PASSWORD__" } }));
  has(withPassword, "DB-SERVER-WRITTEN");
  has(withPassword, "DB-PASSWORD-RESENT");
});

test("existing: a deployment that depends on a server that does not exist is rejected", () => {
  has(run(world("existing", { exists: false })), "DB-SERVER-MISSING");
});

test("existing: what-if showing a write to the server is rejected even when the template looks innocent", () => {
  const w = world("existing");
  w.whatif.changes.push({ resourceId: "m", type: TYPE, name: SERVER, changeType: "Modify", deltas: [] });
  has(run(w), "WHATIF-RESOURCE-NOT-APPROVED");
});

// ---- mode update: written without the creation-only properties ---------------------------------------------------------
test("update: the server may be written without login and password, and the approval is recorded in the report", () => {
  const r = run(world("update", { declared: true }));
  assert.equal(r.verdict, "PASS", JSON.stringify(ids(r)));
  has(r, "DB-SERVER-UPDATE", "allowed");
});

test("update: a password, or the creation-only login, in the request is rejected", () => {
  const pw = run(world("update", { declared: true, props: { administratorLoginPassword: "__GATE:MYSQL_ADMIN_PASSWORD__" } }));
  has(pw, "DB-PASSWORD-RESENT");
  const literal = run(world("update", { declared: true, props: { administratorLoginPassword: "hunter2-not-a-secret" } }));
  has(literal, "DB-PASSWORD-RESENT");
  has(run(world("update", { declared: true, props: { administratorLogin: "adm" } })), "DB-CREATE-ONLY-PROPERTY");
});

test("update: an expression the gate cannot evaluate could be a password, so it is rejected", () => {
  const r = run(world("update", { declared: true, props: { administratorLoginPassword: "[parameters('somethingUnknown')]" } }));
  has(r, "DB-PASSWORD-UNVERIFIABLE");
});

test("update: the manifest says update but the template does not write the server, and a changed property is reported", () => {
  has(run(world("update")), "DB-MODE-MISMATCH");
  const drift = world("update", { declared: true });
  drift.desiredResources.find((x) => x.type === TYPE).properties.storage.storageSizeGB = 16;
  has(run(drift), "DB-CHANGE");
});

// ---- mode create: only for a server that does not exist ---------------------------------------------------------------
test("create: a new server needs login and a password fed from a secure parameter, and a listed create", () => {
  const ok = run(world("create", { exists: false, declared: true, allowCreate: true, props: { administratorLogin: "adm", administratorLoginPassword: "__GATE:MYSQL_ADMIN_PASSWORD__" } }));
  assert.equal(ok.verdict, "PASS", JSON.stringify(ids(ok)));
  has(ok, "DB-PASSWORD-OPAQUE", "info");
  // not listed in allowedCreates: the general create rule still applies
  const unlisted = run(world("create", { exists: false, declared: true, props: { administratorLogin: "adm", administratorLoginPassword: "__GATE:MYSQL_ADMIN_PASSWORD__" } }));
  has(unlisted, "WHATIF-CREATE");
});

test("create: on a server that already exists it would reset the password, so it is rejected", () => {
  const r = run(world("create", { declared: true, props: { administratorLogin: "adm", administratorLoginPassword: "__GATE:MYSQL_ADMIN_PASSWORD__" } }));
  has(r, "DB-CREATE-ON-EXISTING");
  has(r, "DB-PASSWORD-RESENT");
});

test("create: no password, a literal password or no login is rejected", () => {
  const base = { exists: false, declared: true, allowCreate: true };
  has(run(world("create", { ...base, props: { administratorLogin: "adm" } })), "DB-PASSWORD-MISSING-ON-CREATE");
  has(run(world("create", { ...base, props: { administratorLogin: "adm", administratorLoginPassword: "a-literal-value-in-code" } })), "DB-PASSWORD-LITERAL");
  has(run(world("create", { ...base, props: { administratorLoginPassword: "__GATE:MYSQL_ADMIN_PASSWORD__" } })), "DB-LOGIN-MISSING-ON-CREATE");
});

// ---- the manifest itself ----------------------------------------------------------------------------------------------
test("a deployment with no mysqlServer entry may not declare a MySQL server", () => {
  has(run(world(undefined, { declared: true })), "DB-SERVER-UNAPPROVED");
});

test("an unknown mode, or an entry without a reason, is rejected", () => {
  has(run(world("recreate")), "DB-MODE-UNKNOWN");
  const noWhy = world("existing");
  delete noWhy.manifest.deployments.main.mysqlServer.why;
  has(run(noWhy), "MANIFEST-ENTRY-SHAPE");
});

test("a second server that the manifest does not name is rejected", () => {
  const w = world("existing");
  w.desiredResources.push({ ...desiredServer(), name: "mysql-other" });
  w.whatif.changes.push({ resourceId: "o", type: TYPE, name: "mysql-other", changeType: "NoChange", deltas: [] });
  has(run(w), "DB-SERVER-UNAPPROVED");
});

test("a password that production already holds is never an acceptable 'update', whatever the manifest says", () => {
  // belt and braces: even a manifest that approves update and lists the create cannot send a password to a live server
  const w = world("update", { declared: true, props: { administratorLoginPassword: "__GATE:MYSQL_ADMIN_PASSWORD__" } });
  w.manifest.deployments.main.allowedChanges.push({ resource: SERVER, property: "administratorLoginPassword", why: "someone tried to approve it" });
  const r = run(w);
  assert.equal(r.verdict, "FAIL");
  has(r, "DB-PASSWORD-RESENT");
});
