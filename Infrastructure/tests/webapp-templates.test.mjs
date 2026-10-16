// Regression tests for the Studio and onboarding API deployments. They evaluate the real Bicep with `az bicep snapshot` (offline: no deployment and
// no Azure call) and look at what would be sent, and they cross-check the app deployments against the role assignments of studio-platform-rbac:
// a secret an app loads without a role on it can never be read, and a role on a secret nobody loads is access nobody needs.
//
// Skipped when the Azure CLI or Bicep is not installed. Run:
//   node --test Infrastructure/tests/webapp-templates.test.mjs
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { looksSecret } from "../scripts/gate/lib/secrets.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const SUBSCRIPTION = "00000000-0000-0000-0000-000000000000";
const RG = "rg-test";
const haveBicep = spawnSync("az", ["bicep", "version"], { shell: process.platform === "win32", encoding: "utf8" }).status === 0;

let work;
before(() => {
  work = mkdtempSync(join(tmpdir(), "webapp-templates-"));
  cpSync(join(here, ".."), join(work, "Infrastructure"), { recursive: true });
});
after(() => rmSync(work, { recursive: true, force: true }));

function snapshot(paramFile, env = {}) {
  const file = join(work, "Infrastructure", "environments", paramFile);
  const r = spawnSync(
    "az",
    ["bicep", "snapshot", "--file", file, "--subscription-id", SUBSCRIPTION, "--resource-group", RG, "--location", "swedencentral", "--only-show-errors"],
    { shell: process.platform === "win32", encoding: "utf8", env: { ...process.env, ...env } },
  );
  assert.equal(r.status, 0, `az bicep snapshot failed: ${r.stderr}`);
  return JSON.parse(readFileSync(file.replace(/\.bicepparam$/, ".snapshot.json"), "utf8")).predictedResources ?? [];
}
const ofType = (resources, type) => resources.filter((r) => r.type.toLowerCase() === type.toLowerCase());
const one = (resources, type) => {
  const found = ofType(resources, type);
  assert.equal(found.length, 1, `${type}: expected exactly one, found ${found.length}`);
  return found[0];
};

const APPS = [
  { file: "prod.onboardingapi.bicepparam", site: "app-invi-onboarding-api-prod-001", insights: "appi-invi-onboarding-api-prod-001", identity: "id-gha-invi-onboarding-api-prod-001", repo: "CetchApp/cetchapp-onboarding-api", runtime: "DOTNETCORE|10.0" },
  { file: "prod.studio.bicepparam", site: "app-invi-studio-prod-001", insights: "appi-invi-studio-prod-001", identity: "id-gha-invi-studio-prod-001", repo: "CetchApp/invi-studio", runtime: "NODE|24-lts" },
];

for (const app of APPS) {
  test(`${app.site}: declares exactly the resources the manifest approves, and nothing else`, { skip: !haveBicep }, () => {
    const resources = snapshot(app.file);
    const names = resources.map((r) => `${r.type} ${r.name}`).sort();
    assert.deepEqual(names, [
      `Microsoft.Insights/components ${app.insights}`,
      `Microsoft.Insights/diagnosticSettings diag-${app.site}`,
      `Microsoft.ManagedIdentity/userAssignedIdentities ${app.identity}`,
      `Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials ${app.identity}/github-production`,
      `Microsoft.Web/sites ${app.site}`,
      `Microsoft.Web/sites/basicPublishingCredentialsPolicies ${app.site}/ftp`,
      `Microsoft.Web/sites/basicPublishingCredentialsPolicies ${app.site}/scm`,
      `Microsoft.Web/sites/config ${app.site}/appsettings`,
    ].sort());
    assert.equal(ofType(resources, "Microsoft.Authorization/roleAssignments").length, 0, "an app deployment creates no role assignment: it must not need an Owner");
  });

  test(`${app.site}: hardened site, private network path, no platform health check`, { skip: !haveBicep }, () => {
    const site = one(snapshot(app.file), "Microsoft.Web/sites");
    const p = site.properties;
    assert.equal(site.kind, "app,linux");
    assert.equal(site.identity.type, "SystemAssigned");
    assert.equal(p.httpsOnly, true);
    assert.match(p.virtualNetworkSubnetId, /virtualNetworks\/vnet-invi-prod-001\/subnets\/snet-appservice-integration$/, "VNet integration on the existing subnet: the private MySQL and Key Vault are reachable only through it");
    assert.equal(p.outboundVnetRouting.applicationTraffic, true, "Route All in the same request as the site (Azure drops it when it is a separate resource)");
    assert.match(p.serverFarmId, /serverfarms\/asp-invi-prod-001$/, "the existing plan, not a new one");
    assert.equal(p.siteConfig.linuxFxVersion, app.runtime);
    assert.equal(p.siteConfig.ftpsState, "Disabled");
    assert.equal(p.siteConfig.minTlsVersion, "1.2");
    assert.equal(p.siteConfig.scmMinTlsVersion, "1.2");
    assert.equal(p.siteConfig.healthCheckPath, undefined, "no App Service Health check on the shared single instance (it could get the instance replaced under the APIs)");
    for (const policy of ofType(snapshot(app.file), "Microsoft.Web/sites/basicPublishingCredentialsPolicies")) assert.equal(policy.properties.allow, false, policy.name);
  });

  test(`${app.site}: the deploy identity trusts exactly one GitHub repository and environment`, { skip: !haveBicep }, () => {
    const credential = one(snapshot(app.file), "Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials");
    assert.equal(credential.properties.subject, `repo:${app.repo}:environment:production`);
    assert.equal(credential.properties.issuer, "https://token.actions.githubusercontent.com");
    assert.deepEqual(credential.properties.audiences, ["api://AzureADTokenExchange"]);
  });

  test(`${app.site}: secrets are loaded by the app from Key Vault, not set as App Settings, and no name is set twice`, { skip: !haveBicep }, () => {
    // App Service Key Vault references do not resolve against this vault (every reference on the two APIs reports "Reference was not able to be resolved"),
    // so the app reads its secrets itself: it is told where the vault is (KEY_VAULT_URI) and which secret goes in which variable (KEY_VAULT_MAP).
    const text = readFileSync(join(here, "..", "environments", app.file), "utf8");
    const keys = (param) => {
      const block = new RegExp(`^param ${param} = \\{\\r?\\n([\\s\\S]*?)^\\}`, "m").exec(text)?.[1] ?? "";
      return [...block.matchAll(/^ {2}([A-Za-z0-9_]+):/gm)].map((m) => m[1]);
    };
    assert.ok(keys("appSettings").length > 5 && keys("settingSecretNames").length >= 2, "the parameter blocks were found");
    assert.deepEqual(keys("appSettings").filter((k) => keys("settingSecretNames").includes(k)), [], "a name is either an App Setting or a secret the app loads, never both");
    assert.equal(new Set(keys("appSettings")).size, keys("appSettings").length, "no name is declared twice in appSettings");

    const bag = one(snapshot(app.file), "Microsoft.Web/sites/config").properties;
    // `az bicep snapshot` leaves environment() unevaluated; this is the exact expression, and what it gives in the public cloud.
    const vaultUri = String(bag.KEY_VAULT_URI).replace("[format('https://{0}{1}/', 'kv-invi-prod-001', environment().suffixes.keyvaultDns)]", "https://kv-invi-prod-001.vault.azure.net/");
    assert.equal(vaultUri, "https://kv-invi-prod-001.vault.azure.net/");
    const pairs = String(bag.KEY_VAULT_MAP).split(";").map((pair) => pair.split(":"));
    assert.ok(pairs.every((pair) => pair.length === 2 && /^[a-z0-9-]+$/.test(pair[0]) && /^[A-Z][A-Z0-9_]+$/.test(pair[1])), `KEY_VAULT_MAP is secret:NAME pairs: ${bag.KEY_VAULT_MAP}`);
    assert.deepEqual(pairs.map((pair) => pair[1]), [...keys("settingSecretNames")].sort(), "the map lists exactly the names of settingSecretNames, sorted by name");
    for (const name of keys("settingSecretNames")) assert.equal(bag[name], undefined, `${name} is not an App Setting: the app puts it in its environment itself`);
    assert.ok(!Object.values(bag).some((value) => String(value).includes("@Microsoft.KeyVault(")), "no Key Vault reference: the platform cannot resolve them against this vault");
    assert.ok(!looksSecret("KEY_VAULT_URI", vaultUri) && !looksSecret("KEY_VAULT_MAP", bag.KEY_VAULT_MAP), "the two loader settings are not taken for secrets by the gate");

    const secretName = /(secret|password|passwd|apikey|api_key|key$|token|connectionstring|salt|signing|private_key|credential)/i;
    for (const [name, value] of Object.entries(bag)) {
      if (String(value).startsWith("[")) continue;
      if (name === "APPLICATIONINSIGHTS_CONNECTION_STRING") continue;
      // STUDIO_SERVER_ONLY and STUDIO_REQUIRE_EMAIL are switches; a switch is not a secret.
      if (secretName.test(name)) assert.match(String(value), /^(true|false)$/i, `${name} looks like a secret and is a literal`);
    }
  });
}

test("the Studio key is the same Key Vault secret in both apps, and Studio reaches the API at its default host name", { skip: !haveBicep }, () => {
  const api = one(snapshot("prod.onboardingapi.bicepparam"), "Microsoft.Web/sites/config").properties;
  const studio = one(snapshot("prod.studio.bicepparam"), "Microsoft.Web/sites/config").properties;
  const secretOf = (bag, name) => Object.fromEntries(String(bag.KEY_VAULT_MAP).split(";").map((pair) => pair.split(":").reverse()))[name];
  assert.equal(secretOf(api, "STUDIO_API_KEY"), "studio-api-key");
  assert.equal(secretOf(studio, "STUDIO_API_KEY"), secretOf(api, "STUDIO_API_KEY"), "one shared key, one secret");
  assert.equal(secretOf(api, "ONBOARDING_DB_PASSWORD"), "database-password", "the same database secret the other APIs use");
  assert.equal(secretOf(studio, "STUDIO_SESSION_SECRET"), "studio-session-secret");
  assert.equal(studio.ONBOARDING_API_BASE_URL, "https://app-invi-onboarding-api-prod-001.azurewebsites.net");
  assert.equal(studio.STUDIO_REQUIRE_EMAIL, api.STUDIO_REQUIRE_EMAIL, "both apps must agree on the e-mail step");
});

test("Studio starts through launch.mjs (it loads the secrets, then runs server.js) and the onboarding API through its dll", { skip: !haveBicep }, () => {
  assert.equal(one(snapshot("prod.studio.bicepparam"), "Microsoft.Web/sites").properties.siteConfig.appCommandLine, "node launch.mjs");
  assert.equal(one(snapshot("prod.onboardingapi.bicepparam"), "Microsoft.Web/sites").properties.siteConfig.appCommandLine, "dotnet invi-studio-api.dll");
});

test("the onboarding API is locked down in its settings, and Studio trusts one origin", { skip: !haveBicep }, () => {
  const api = one(snapshot("prod.onboardingapi.bicepparam"), "Microsoft.Web/sites/config").properties;
  assert.equal(api.STUDIO_SERVER_ONLY, "true");
  assert.equal(api.ADMIN_ROUTES_ENABLED, "false");
  assert.equal(api.ENABLE_SWAGGER, "false");
  assert.equal(api.STUDIO_RESOURCES_ENABLED, "true");
  assert.equal(api.ASPNETCORE_ENVIRONMENT, "Production");
  assert.equal(api.ONBOARDING_DB_SSL_MODE, "Required");
  assert.equal(api.RESERVATION_JOBS_ENABLED, "false");
  assert.equal(api.RESERVATION_NOTIFICATIONS_MODE, "Disabled");
  for (const absent of ["OPENAI_API_KEY", "RESEND_API_KEY", "MAILBOX_PASSWORD", "ACTIVITY_CREATOR_ID"]) assert.equal(api[absent], undefined, `${absent} is not set in production`);
  const studio = one(snapshot("prod.studio.bicepparam"), "Microsoft.Web/sites/config").properties;
  assert.equal(studio.STUDIO_PUBLIC_ORIGIN, "https://studio.invi.lol");
  assert.equal(studio.NODE_ENV, "production");
});

test("every secret an app loads has a role on exactly that secret, and every role belongs to a secret an app loads", { skip: !haveBicep }, () => {
  const rbac = ofType(snapshot("prod.studio-platform-rbac.bicepparam"), "Microsoft.Authorization/roleAssignments");
  const grants = new Map(); // "<site>|<secret>" -> true
  const deploy = new Map(); // "<site>" -> role definition
  for (const ra of rbac) {
    const scope = /extensionResourceId\('([^']+)'/.exec(ra.id)?.[1] ?? "";
    const site = /reference\('[^']*\/sites\/([^'/]+)'/.exec(ra.properties.principalId + ra.name)?.[1];
    const secret = /\/vaults\/kv-invi-prod-001\/secrets\/([^/]+)$/.exec(scope)?.[1];
    if (secret && site) {
      assert.match(ra.properties.roleDefinitionId, /4633458b-17de-408a-b874-0445c86b69e6$/, "Key Vault Secrets User only");
      grants.set(`${site}|${secret}`, true);
    } else {
      assert.match(scope, /\/providers\/Microsoft\.Web\/sites\/app-invi-(studio|onboarding-api)-prod-001$/, "a non-secret grant is Website Contributor on one of the two apps");
      assert.match(ra.properties.roleDefinitionId, /de139f84-1756-47ae-9be6-808fbbe84772$/, "Website Contributor only");
      deploy.set(scope.split("/").pop(), ra.properties.roleDefinitionId);
    }
  }
  const loaded = new Map();
  for (const app of APPS) {
    const bag = one(snapshot(app.file), "Microsoft.Web/sites/config").properties;
    for (const pair of String(bag.KEY_VAULT_MAP).split(";")) loaded.set(`${app.site}|${pair.split(":")[0]}`, true);
  }
  assert.deepEqual([...loaded.keys()].sort(), [...grants.keys()].sort(), "the secrets each app loads and the secret-scoped roles must be the same set");
  assert.deepEqual([...deploy.keys()].sort(), APPS.map((a) => a.site).sort(), "each app has one deploy role, on itself");
  assert.ok(![...grants.keys()].some((k) => k.endsWith("|jwt-signing-key")), "neither app can read the JWT signing key");
});

test("domain: pass 1 binds without TLS and creates no certificate, pass 2 adds a managed certificate and SNI", { skip: !haveBicep }, () => {
  const bind = snapshot("prod.studio.domain-studio-invi-lol.bicepparam");
  assert.equal(ofType(bind, "Microsoft.Web/certificates").length, 0);
  const binding = one(bind, "Microsoft.Web/sites/hostNameBindings");
  assert.equal(binding.name, "app-invi-studio-prod-001/studio.invi.lol");
  assert.equal(binding.properties.sslState, "Disabled");
  assert.ok(!binding.properties.thumbprint, "no certificate in pass 1");
  const tls = snapshot("prod.studio.domain-studio-invi-lol-tls.bicepparam");
  const certificate = one(tls, "Microsoft.Web/certificates");
  assert.equal(certificate.name, "studio.invi.lol-app-invi-studio-prod-001");
  assert.equal(certificate.properties.canonicalName, "studio.invi.lol");
  assert.equal(one(tls, "Microsoft.Web/sites/hostNameBindings").properties.sslState, "SniEnabled");
});
