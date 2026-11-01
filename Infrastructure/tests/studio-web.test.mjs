import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const app = read("modules/studio-web.bicep");
const rbac = read("modules/studio-web-rbac.bicep");
const domain = read("modules/studio-web-domain.bicep");
const params = read("environments/prod.studio-web.bicepparam");
const rbacParams = read("environments/prod.studio-web.rbac-owner.bicepparam");
const domainParams = read("environments/prod.studio-web.domain-studio-invi-lol.bicepparam");
const tlsParams = read("environments/prod.studio-web.domain-studio-invi-lol-tls.bicepparam");
const manifest = JSON.parse(read("safety/manifest.json"));

test("Studio uses the existing production plan with Node 22 and the secure launcher", () => {
  assert.match(app, /var appServicePlanName = 'asp-\$\{workloadName\}-\$\{environment\}-\$\{instance\}'/);
  assert.match(app, /var studioName = 'app-\$\{workloadName\}-studio-\$\{environment\}-\$\{instance\}'/);
  assert.match(params, /^param location = 'swedencentral'$/m);
  assert.match(params, /^param linuxFxVersion = 'NODE\|22-lts'$/m);
  assert.match(params, /^param appCommandLine = 'node launch\.mjs'$/m);
  assert.match(app, /httpsOnly: true/);
  assert.match(app, /SCM_DO_BUILD_DURING_DEPLOYMENT: 'false'/);
  assert.match(app, /allow: false/g);
});

test("production URLs, Render API and origin settings are explicit", () => {
  for (const expected of [
    "NODE_ENV: 'production'",
    "STUDIO_ENVIRONMENT: 'production'",
    "HOSTNAME: '0.0.0.0'",
    "ONBOARDING_API_BASE_URL: 'https://invi-studio-api.onrender.com'",
    "STUDIO_PUBLIC_URL: 'https://studio.invi.lol'",
    "STUDIO_PUBLIC_ORIGIN: 'https://studio.invi.lol'",
  ]) assert.match(params, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(params, /STUDIO_BILLING_PREVIEW|STUDIO_BILLING_EXEMPT/);
});

test("secrets load in-process from the private vault with per-secret RBAC", () => {
  assert.match(app, /KEY_VAULT_URI: keyVaultUri/);
  assert.match(app, /KEY_VAULT_MAP:/);
  assert.match(app, /virtualNetworkSubnetId: appServiceSubnet\.id/);
  assert.match(app, /outboundVnetRouting: \{\s*applicationTraffic: true/);
  assert.match(app, /vnetRouteAllEnabled: true/);
  assert.doesNotMatch(app, /@Microsoft\.KeyVault/);

  const mappedSecrets = [...params.matchAll(/^\s+secretName: '([^']+)'$/gm)].map((match) => match[1]).sort();
  const granted = [...rbacParams.matchAll(/^\s+'([^']+)'$/gm)].map((match) => match[1]).sort();
  assert.deepEqual(mappedSecrets, granted);
  assert.match(rbac, /module secretAccess 'rbac-keyvault-secret-scope\.bicep'/);
  assert.doesNotMatch(rbac, /scope: keyVault\b/);
});

test("GitHub OIDC is limited to the canonical repository production environment", () => {
  assert.match(params, /^param githubRepository = 'CetchApp\/invi-studio'$/m);
  assert.match(params, /^param githubEnvironment = 'production'$/m);
  assert.match(app, /subject: 'repo:\$\{githubRepository\}:environment:\$\{githubEnvironment\}'/);
  assert.equal(
    manifest.identities.known["id-gha-invi-studio-prod-001"]["github-production"].subject,
    "repo:CetchApp/invi-studio:environment:production",
  );
  assert.match(rbac, /scope: studio\n/);
  assert.match(rbac, /de139f84-1756-47ae-9be6-808fbbe84772/);
});

test("domain binding and TLS are separate reviewed deployments", () => {
  assert.match(domain, /resource studio 'Microsoft\.Web\/sites@[^']+' existing/);
  assert.match(domainParams, /^param tlsMode = 'none'$/m);
  assert.match(tlsParams, /^param tlsMode = 'managed'$/m);
  assert.equal(manifest.deployments["studio-web-c-domain"].parameters, "Infrastructure/environments/prod.studio-web.domain-studio-invi-lol.bicepparam");
  assert.equal(manifest.deployments["studio-web-d-domain-tls"].parameters, "Infrastructure/environments/prod.studio-web.domain-studio-invi-lol-tls.bicepparam");
});

test("Studio deployments cannot touch existing production applications or data resources", () => {
  const keys = ["studio-web-a", "studio-web-b-rbac", "studio-web-c-domain", "studio-web-d-domain-tls"];
  const forbidden = /data-api|auth-api|admin|mysql|Microsoft\.KeyVault\/vaults$|studio-api/;
  for (const key of keys) {
    const deployment = manifest.deployments[key];
    assert.ok(deployment);
    for (const entry of [...deployment.allowedCreates, ...deployment.touches]) {
      assert.doesNotMatch(`${entry.type}/${entry.name}`, forbidden, `${key} includes unrelated resource ${entry.type}/${entry.name}`);
    }
  }
  assert.ok(manifest.deployments["studioapi-a"], "PR #25 studioapi-a remains in the manifest");
  assert.ok(manifest.deployments["studioapi-b-rbac"], "PR #25 studioapi-b-rbac remains in the manifest");
});

test("the new app does not block unrelated deploys before it exists", () => {
  assert.equal(manifest.apps["app-invi-studio-prod-001"].introducedBy, "studio-web-a");
  assert.match(read("scripts/deploy.sh"), /gate\/apps-to-verify\.mjs/);
});
