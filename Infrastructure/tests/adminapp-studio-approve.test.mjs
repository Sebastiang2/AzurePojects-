import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { evaluateSnapshot, haveSnapshot } from "./bicep-snapshot.mjs";

// Approval of Studio sign-ups from the admin panel (docs/studio-web-rollout.md, option B): the panel's server calls the Studio
// API's admin route with X-Studio-Admin-Key. The admin app gets the API address and a Key Vault reference to the key, and its
// identity gets read access to that one secret.
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const admin = read("modules/adminapp.bicep");
const params = read("environments/prod.adminapp.bicepparam");
const rbacParams = read("environments/prod.adminapp.rbac-owner.bicepparam");
const studioApiParams = read("environments/prod.studioapi.bicepparam");
const studioWebParams = read("environments/prod.studio-web.ingress-public.bicepparam");
const manifest = JSON.parse(read("safety/manifest.json"));
const site = "app-invi-admin-prod-001";
const apiUrl = "https://app-invi-studio-api-prod-001.azurewebsites.net";
const keyReference = "@Microsoft.KeyVault(VaultName=kv-invi-prod-001;SecretName=studio-admin-api-key)";
const code = (text) => text.replace(/^\s*\/\/.*$/gm, "");

test("the module sets the Studio settings only when asked, and the key only as a Key Vault reference", () => {
  assert.match(admin, /param studioApiBaseUrl string = ''/);
  assert.match(admin, /param studioAdminKeySecretName string = ''/);
  assert.match(admin, /empty\(studioApiBaseUrl\) \? \{\} : \{ INVI_STUDIO_API_BASE_URL: studioApiBaseUrl \}/);
  assert.match(
    admin,
    /empty\(studioAdminKeySecretName\) \? \{\} : \{ STUDIO_ADMIN_API_KEY: '@Microsoft\.KeyVault\(VaultName=\$\{keyVaultName\};SecretName=\$\{studioAdminKeySecretName\}\)' \}/,
  );
  assert.doesNotMatch(code(admin), /NEXT_PUBLIC_[A-Z_]*STUDIO/, "nothing about the Studio API is embedded in the browser build");
});

test("production points the panel at the Studio API on Azure and at the key that API checks", () => {
  assert.match(code(params), new RegExp(`^param studioApiBaseUrl = '${apiUrl.replaceAll(".", "\\.")}'$`, "m"));
  assert.match(code(params), /^param studioAdminKeySecretName = 'studio-admin-api-key'$/m);
  // The same API that Studio web calls, and the same secret the API compares X-Studio-Admin-Key with.
  assert.match(studioWebParams, new RegExp(`ONBOARDING_API_BASE_URL: '${apiUrl.replaceAll(".", "\\.")}'`));
  assert.match(studioApiParams, /setting: 'STUDIO_ADMIN_API_KEY'\n\s+secretName: 'studio-admin-api-key'/);
  assert.match(studioApiParams, /ADMIN_ACCESS_MODE: 'enforce'/);
});

test("the admin identity may read studio-admin-api-key, one secret, not the vault", () => {
  const names = [...(/param secretNames = \[([\s\S]*?)\]/.exec(rbacParams)?.[1] ?? "").matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(names, ["admin-publishing-api-key", "admin-publishing-api-key-test", "studio-admin-api-key"]);
  const rbac = read("modules/adminapp-rbac.bicep");
  assert.match(rbac, /module secretAccess 'rbac-keyvault-secret-scope\.bicep'/);
  assert.doesNotMatch(rbac, /scope: keyVault\b/);
});

test("the manifest approves exactly the two settings, holds their values and knows the one new role assignment", () => {
  const app = manifest.apps[site];
  for (const name of ["INVI_STUDIO_API_BASE_URL", "STUDIO_ADMIN_API_KEY"]) assert.ok(app.required.includes(name), name);
  assert.equal(app.mustEqual.INVI_STUDIO_API_BASE_URL, apiUrl);
  assert.equal(app.mustEqual.STUDIO_ADMIN_API_KEY, keyReference, "a literal key can never pass the gate");

  const a = manifest.deployments["adminapp-a"];
  assert.deepEqual(a.allowedNewSettings, { [site]: ["INVI_STUDIO_API_BASE_URL", "STUDIO_ADMIN_API_KEY"] });
  assert.deepEqual([a.allowedRemovedSettings, a.allowedChanges, a.allowedCreates], [{}, [], []]);

  const b = manifest.deployments["adminapp-b-rbac"];
  assert.equal(b.allowedCreates.length, 1);
  const [created] = b.allowedCreates;
  assert.equal(created.type, "Microsoft.Authorization/roleAssignments");
  assert.ok(b.touches.some((t) => t.name === created.name), "the new assignment is one the deployment may touch");
  assert.equal(b.allowedUnsupported.find((u) => u.module === "secretAccess").count, 2, "the two guid()-named assignments");
  const known = manifest.rbac.knownAssignments.find((k) => k.name === created.name);
  assert.ok(known, "listed in rbac.knownAssignments, or every later gate run fails with RBAC-UNREVIEWED");
  assert.equal(known.role, "Key Vault Secrets User");
  assert.match(known.scope, /\/vaults\/kv-invi-prod-001\/secrets\/studio-admin-api-key$/);
});

// Evaluated offline (no deployment, no Azure call), like studio-web.test.mjs. Skipped when neither `az bicep snapshot` nor the
// Bicep CLI is installed. The Entra secret is a placeholder: the parameter file reads it from the environment. The settings bag
// holds the Application Insights connection string, which exists only at deployment time, so the snapshot keeps the whole bag
// as one ARM expression; the parameters are resolved inside it, which is what is checked here.
test("rendered: the settings bag carries the address and the reference, and leaves both out when they are not set", { skip: !haveSnapshot }, () => {
  const dir = mkdtempSync(join(tmpdir(), "adminapp-studio-"));
  try {
    mkdirSync(join(dir, "modules"));
    mkdirSync(join(dir, "environments"));
    cpSync(new URL("../modules/adminapp.bicep", import.meta.url), join(dir, "modules", "adminapp.bicep"));
    const env = { ADMIN_ENTRA_CLIENT_SECRET: "placeholder-not-a-secret" };
    const bag = (text, name) => {
      const file = join(dir, "environments", `${name}.bicepparam`);
      writeFileSync(file, text);
      const rendered = evaluateSnapshot(file, { env });
      assert.ok(rendered.ok, rendered.error);
      const properties = rendered.resources.find((r) => r.type === "Microsoft.Web/sites/config" && r.name === `${site}/appsettings`).properties;
      return typeof properties === "string" ? properties : JSON.stringify(properties);
    };
    const entry = (name, value) => `createObject('${name}', '${value}')`;

    const production = bag(params, "prod");
    assert.ok(production.includes(entry("INVI_STUDIO_API_BASE_URL", apiUrl)), "the address of the Studio API on Azure");
    assert.ok(production.includes(entry("STUDIO_ADMIN_API_KEY", keyReference)), "the key as a Key Vault reference, never its value");
    for (const [, name, value] of production.matchAll(/'(NEXT_PUBLIC_[A-Z_]+)', '([^']*)'/g)) {
      assert.doesNotMatch(value, /studio-api|studio-admin-api-key|KeyVault/i, `${name} is embedded in the browser build`);
    }

    const unset = bag(params.replace(/^param studioApiBaseUrl = .*$/m, "").replace(/^param studioAdminKeySecretName = .*$/m, ""), "unset");
    assert.doesNotMatch(unset, /INVI_STUDIO_API_BASE_URL|STUDIO_ADMIN_API_KEY/, "left out when the parameters are empty");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
