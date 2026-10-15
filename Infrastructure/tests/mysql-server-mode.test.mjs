// Regression tests for how the MySQL server and its administrator password are handled by the templates. They evaluate the
// real Bicep with `az bicep snapshot` (offline: no deployment, no Azure call) and look at what would be sent:
//
//   existing  no server resource at all (the normal redeploy: the password cannot change)
//   update    the server without administratorLogin and administratorLoginPassword
//   create    the server with both
//
// Skipped when the Azure CLI or Bicep is not installed. Run:
//   node --test Infrastructure/tests/mysql-server-mode.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const infra = join(here, "..");
const SUBSCRIPTION = "00000000-0000-0000-0000-000000000000";
const TYPE = "Microsoft.DBforMySQL/flexibleServers";

const azVersion = spawnSync("az", ["bicep", "version"], { shell: process.platform === "win32", encoding: "utf8" });
const haveBicep = azVersion.status === 0;

function snapshot(paramFile, env = {}) {
  const r = spawnSync(
    "az",
    ["bicep", "snapshot", "--file", paramFile, "--subscription-id", SUBSCRIPTION, "--resource-group", "rg-test", "--location", "swedencentral", "--only-show-errors"],
    { shell: process.platform === "win32", encoding: "utf8", env: { ...process.env, ...env } },
  );
  assert.equal(r.status, 0, `az bicep snapshot failed: ${r.stderr}`);
  const out = paramFile.replace(/\.bicepparam$/, ".snapshot.json");
  return JSON.parse(readFileSync(out, "utf8")).predictedResources ?? [];
}
const servers = (resources) => resources.filter((r) => r.type === TYPE);
const databases = (resources) => resources.filter((r) => r.type === `${TYPE}/databases`);

// ---- the module on its own -------------------------------------------------------------------------------------------
function moduleParams(dir, mode, extra = "") {
  const file = join(dir, `module-${mode}.bicepparam`);
  writeFileSync(
    file,
    `using './mysql.bicep'
param workloadName = 'invi'
param environment = 'prod'
param instance = '001'
param location = 'swedencentral'
param tags = {}
param mysqlSubnetId = '/subscriptions/${SUBSCRIPTION}/resourceGroups/rg-test/providers/Microsoft.Network/virtualNetworks/vnet-test/subnets/snet-mysql'
param privateDnsZoneMysqlId = '/subscriptions/${SUBSCRIPTION}/resourceGroups/rg-test/providers/Microsoft.Network/privateDnsZones/test.private.mysql.database.azure.com'
param mysqlServerMode = '${mode}'
param mysqlAdminUsername = 'inviadmin'
${extra}
param mysqlSkuName = 'Standard_B2s'
param mysqlSkuTier = 'Burstable'
param mysqlVersion = '8.0.21'
param storageSizeGB = 32
param backupRetentionDays = 14
param highAvailabilityMode = 'Disabled'
param databaseName = 'invi'
`,
  );
  return file;
}

test("module, mode existing: the server is not part of the deployment, only the database is", { skip: !haveBicep }, () => {
  const dir = mkdtempSync(join(tmpdir(), "mysql-mode-"));
  try {
    cpSync(join(infra, "modules", "mysql.bicep"), join(dir, "mysql.bicep"));
    const resources = snapshot(moduleParams(dir, "existing", "param mysqlAdminPassword = 'a-value-that-must-never-be-sent'"));
    assert.equal(servers(resources).length, 0, "the server must not be written in mode existing");
    assert.equal(databases(resources).length, 1);
    assert.ok(!JSON.stringify(resources).includes("a-value-that-must-never-be-sent"), "the password value must not appear anywhere in the request");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("module, mode update: the server is written without administratorLogin and administratorLoginPassword", { skip: !haveBicep }, () => {
  const dir = mkdtempSync(join(tmpdir(), "mysql-mode-"));
  try {
    cpSync(join(infra, "modules", "mysql.bicep"), join(dir, "mysql.bicep"));
    const resources = snapshot(moduleParams(dir, "update", "param mysqlAdminPassword = 'a-value-that-must-never-be-sent'"));
    const [server] = servers(resources);
    assert.ok(server, "the server is written in mode update");
    for (const key of ["administratorLogin", "administratorLoginPassword"]) assert.ok(!(key in server.properties), `${key} must be absent (not null, not empty) in mode update`);
    assert.ok(!JSON.stringify(resources).includes("a-value-that-must-never-be-sent"));
    assert.equal(server.properties.storage.storageSizeGB, 32);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("module, mode create: the server is created with login and password", { skip: !haveBicep }, () => {
  const dir = mkdtempSync(join(tmpdir(), "mysql-mode-"));
  try {
    cpSync(join(infra, "modules", "mysql.bicep"), join(dir, "mysql.bicep"));
    const resources = snapshot(moduleParams(dir, "create", "param mysqlAdminPassword = 'placeholder-for-the-test'"));
    const [server] = servers(resources);
    assert.ok(server);
    assert.equal(server.properties.administratorLogin, "inviadmin");
    assert.ok(server.properties.administratorLoginPassword, "a created server gets its password");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("module: the default mode is existing and an unknown mode does not compile", { skip: !haveBicep }, () => {
  const source = readFileSync(join(infra, "modules", "mysql.bicep"), "utf8");
  assert.match(source, /param mysqlServerMode string = 'existing'/);
  assert.match(source, /@secure\(\)\s*param mysqlAdminPassword string = ''/);
  const dir = mkdtempSync(join(tmpdir(), "mysql-mode-"));
  try {
    cpSync(join(infra, "modules", "mysql.bicep"), join(dir, "mysql.bicep"));
    const file = moduleParams(dir, "recreate");
    const r = spawnSync("az", ["bicep", "build-params", "--file", file, "--stdout"], { shell: process.platform === "win32", encoding: "utf8" });
    assert.notEqual(r.status, 0, "mode 'recreate' must be rejected by @allowed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- the production parameter file ------------------------------------------------------------------------------------
test("prod.bicepparam: mode existing, the password is not read from the environment and nothing writes the server", { skip: !haveBicep }, () => {
  const params = readFileSync(join(infra, "environments", "prod.bicepparam"), "utf8");
  const code = params.split(/\r?\n/).filter((l) => !/^\s*\/\//.test(l)).join("\n");
  assert.match(code, /param mysqlServerMode = 'existing'/);
  assert.ok(!/MYSQL_ADMIN_PASSWORD/.test(code), "the production parameter file must not read the administrator password");
  assert.ok(!/param mysqlAdminPassword/.test(code), "no value for the password in the production parameter file");

  const dummy = { REVENUECAT_SECRET_API_KEY: "test-not-a-secret", REVENUECAT_WEBHOOK_AUTHORIZATION: "test-not-a-secret", MYSQL_ADMIN_PASSWORD: "set-in-the-shell-but-must-not-be-used" };
  // evaluated in a copy: the snapshot file is written next to the parameter file and must not end up in the repository
  const dir = mkdtempSync(join(tmpdir(), "mysql-prod-"));
  try {
    cpSync(infra, join(dir, "Infrastructure"), { recursive: true, filter: (src) => !/[\\/](node_modules|tests)([\\/]|$)/.test(src) });
    const resources = snapshot(join(dir, "Infrastructure", "environments", "prod.bicepparam"), dummy);
    assert.equal(servers(resources).length, 0, "a normal deployment must not write the MySQL server");
    assert.equal(databases(resources).length, 1);
    assert.ok(!JSON.stringify(resources).includes("set-in-the-shell-but-must-not-be-used"), "a password in the shell must not reach the request");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("main.bicep passes the mode through: update and create change what is written", { skip: !haveBicep }, () => {
  const dir = mkdtempSync(join(tmpdir(), "mysql-main-"));
  try {
    cpSync(infra, join(dir, "Infrastructure"), { recursive: true, filter: (src) => !/[\\/](node_modules|tests)([\\/]|$)/.test(src) });
    const prod = join(dir, "Infrastructure", "environments", "prod.bicepparam");
    const original = readFileSync(prod, "utf8");
    const env = { REVENUECAT_SECRET_API_KEY: "test-not-a-secret", REVENUECAT_WEBHOOK_AUTHORIZATION: "test-not-a-secret", MYSQL_ADMIN_PASSWORD: "placeholder-for-the-test" };

    writeFileSync(prod, original.replace("param mysqlServerMode = 'existing'", "param mysqlServerMode = 'update'"));
    const updated = servers(snapshot(prod, env));
    assert.equal(updated.length, 1);
    assert.ok(!("administratorLogin" in updated[0].properties) && !("administratorLoginPassword" in updated[0].properties));

    writeFileSync(prod, original.replace("param mysqlServerMode = 'existing'", "param mysqlServerMode = 'create'\nparam mysqlAdminPassword = readEnvironmentVariable('MYSQL_ADMIN_PASSWORD')"));
    const created = servers(snapshot(prod, env));
    assert.equal(created.length, 1);
    assert.equal(created[0].properties.administratorLogin, "inviadmin");
    assert.ok(created[0].properties.administratorLoginPassword);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
