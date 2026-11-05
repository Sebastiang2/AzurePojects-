import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
const workflow = readFileSync(new URL("../../.github/workflows/iac-validate.yml", import.meta.url), "utf8");

test("Studio uses the existing production plan with Node 22 and the secure launcher", () => {
  assert.match(app, /var appServicePlanName = 'asp-\$\{workloadName\}-\$\{environment\}-\$\{instance\}'/);
  assert.match(app, /var studioName = 'app-\$\{workloadName\}-studio-\$\{environment\}-\$\{instance\}'/);
  assert.match(params, /^param location = 'swedencentral'$/m);
  assert.match(params, /^param linuxFxVersion = 'NODE\|22-lts'$/m);
  assert.match(params, /^param appCommandLine = 'node launch\.mjs'$/m);
  assert.match(app, /httpsOnly: true/);
  assert.match(app, /SCM_DO_BUILD_DURING_DEPLOYMENT: 'false'/);
  assert.match(app, /resource studioFtpPolicy 'Microsoft\.Web\/sites\/basicPublishingCredentialsPolicies@[^']+'[\s\S]*?name: 'ftp'[\s\S]*?allow: false/);
  assert.match(app, /resource studioScmPolicy 'Microsoft\.Web\/sites\/basicPublishingCredentialsPolicies@[^']+'[\s\S]*?name: 'scm'[\s\S]*?allow: false/);
});

test("first Studio deployment denies all main-site ingress while SCM remains a separate authenticated surface", () => {
  assert.match(app, /publicNetworkAccess: 'Enabled'/);
  // Closed unless ingressMode says public; a value left out is closed too, and the only rule list ever rendered is empty.
  assert.match(app, /param ingressMode string = 'closed'/);
  assert.match(app, /ipSecurityRestrictions: \[\]\s*ipSecurityRestrictionsDefaultAction: ingressMode == 'public' \? 'Allow' : 'Deny'/);
  assert.doesNotMatch(app, /ipSecurityRestrictionsDefaultAction: 'Allow'/);
  assert.match(params, /^param ingressMode = 'closed'$/m);
  assert.match(app, /scmIpSecurityRestrictionsUseMain: false/);
  assert.match(app, /scmIpSecurityRestrictionsDefaultAction: 'Allow'/);
  assert.match(app, /Basic publishing is disabled below and OIDC plus site-scoped RBAC authenticate deployments/);
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
  assert.deepEqual(mappedSecrets, ["openai-api-key", "studio-api-key", "studio-google-places-api-key", "studio-session-secret"]);
  assert.match(params, /setting: 'GOOGLE_PLACES_API_KEY'\n\s+secretName: 'studio-google-places-api-key'/);
  assert.match(params, /setting: 'OPENAI_API_KEY'\n\s+secretName: 'openai-api-key'/);
  assert.doesNotMatch(params, /MAPBOX/);
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
  const keys = ["studio-web-a", "studio-web-b-rbac", "studio-web-c-domain", "studio-web-d-domain-tls", "studio-web-e-ingress-public", "studio-web-e-ingress-close"];
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

test("pull requests run only offline Bicep validation", () => {
  assert.match(workflow, /^\s*pull_request:/m);
  assert.match(workflow, /^\s*contents: read$/m);
  assert.match(workflow, /bash Infrastructure\/scripts\/validate\.sh/);
  assert.doesNotMatch(workflow, /azure\/login|az\s+deployment|deploy\.sh/i);
});

// ---- the reviewed ingress step (deployment E) ---------------------------------------------------------------------------------

const publicParams = read("environments/prod.studio-web.ingress-public.bicepparam");
const withoutComments = (text) => text.split(/\r?\n/).filter((line) => line.trim() && !line.trim().startsWith("//")).join("\n");

test("the public ingress file is deployment A with ingressMode changed and nothing else", () => {
  assert.match(publicParams, /^using '\.\.\/modules\/studio-web\.bicep'$/m);
  assert.match(publicParams, /^param ingressMode = 'public'$/m);
  const strip = (text) => withoutComments(text).replace(/^param ingressMode = '[a-z]+'$/m, "param ingressMode = <mode>");
  assert.equal(strip(publicParams), strip(params), "the two parameter files must stay identical apart from ingressMode");
});

test("the ingress deployments are Studio-only, change one property and have a rollback", () => {
  const pub = manifest.deployments["studio-web-e-ingress-public"];
  const close = manifest.deployments["studio-web-e-ingress-close"];
  const a = manifest.deployments["studio-web-a"];
  for (const deployment of [pub, close]) {
    assert.equal(deployment.template, a.template);
    assert.deepEqual(deployment.touches, a.touches, "the same resources as deployment A, no others");
    assert.deepEqual([deployment.allowedCreates, deployment.allowedUnsupported], [[], []]);
    assert.deepEqual([deployment.allowedNewSettings, deployment.allowedRemovedSettings], [{}, {}]);
    assert.equal(deployment.allowedChanges.length, 2);
    for (const change of deployment.allowedChanges) assert.match(change.resource, /^app-invi-studio-prod-001$/);
    const [live, whatif] = deployment.allowedChanges;
    assert.equal(live.property, "siteConfig.ipSecurityRestrictionsDefaultAction");
    assert.deepEqual([whatif.whatif, whatif.type, whatif.property], [true, "Microsoft.Web/sites", "properties.siteConfig.ipSecurityRestrictionsDefaultAction"]);
  }
  assert.equal(pub.parameters, "Infrastructure/environments/prod.studio-web.ingress-public.bicepparam");
  assert.deepEqual([pub.allowedChanges[0].before, pub.allowedChanges[0].after], ["Deny", "Allow"]);
  assert.equal(close.parameters, a.parameters, "the rollback is the closed file of deployment A");
  assert.deepEqual([close.allowedChanges[0].before, close.allowedChanges[0].after], ["Allow", "Deny"]);
  assert.notEqual(pub.deploymentName, close.deploymentName);
});

// The templates are evaluated offline (`az bicep snapshot`: no deployment, no Azure call), like mysql-server-mode.test.mjs. Skipped
// when the Azure CLI or Bicep is not installed.
const haveBicep = spawnSync("az", ["bicep", "version"], { shell: process.platform === "win32", encoding: "utf8" }).status === 0;

function render(files) {
  const dir = mkdtempSync(join(tmpdir(), "studio-web-ingress-"));
  try {
    mkdirSync(join(dir, "modules"));
    mkdirSync(join(dir, "environments"));
    cpSync(new URL("../modules/studio-web.bicep", import.meta.url), join(dir, "modules", "studio-web.bicep"));
    const results = {};
    for (const [name, text] of Object.entries(files)) {
      const file = join(dir, "environments", `${name}.bicepparam`);
      writeFileSync(file, text);
      const run = spawnSync(
        "az",
        ["bicep", "snapshot", "--file", file, "--subscription-id", "00000000-0000-0000-0000-000000000000", "--resource-group", "rg-test", "--location", "swedencentral", "--only-show-errors"],
        { shell: process.platform === "win32", encoding: "utf8" },
      );
      results[name] = run.status === 0
        ? { ok: true, resources: JSON.parse(readFileSync(file.replace(/\.bicepparam$/, ".snapshot.json"), "utf8")).predictedResources }
        : { ok: false, error: `${run.stdout}${run.stderr}` };
    }
    return results;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Every leaf of every predicted resource as "type | name | path" -> value. */
function leaves(resources) {
  const out = new Map();
  const walk = (prefix, value) => {
    if (value !== null && typeof value === "object") {
      if (Array.isArray(value) && value.length === 0) out.set(prefix, "[]");
      for (const [key, child] of Object.entries(value)) walk(`${prefix}.${key}`, child);
    } else out.set(prefix, value);
  };
  for (const resource of resources) walk(`${resource.type} | ${resource.name}`, resource);
  return out;
}

test("rendered: the public file differs from deployment A in exactly one property, and a missing value is closed", { skip: !haveBicep }, () => {
  const mode = (text) => text.replace(/^param ingressMode = '[a-z]+'\r?\n/m, "");
  const rendered = render({
    closed: params,
    public: publicParams,
    left_out: mode(params),
    unknown: params.replace("param ingressMode = 'closed'", "param ingressMode = 'allowlist'"),
  });
  assert.ok(rendered.closed.ok && rendered.public.ok && rendered.left_out.ok, JSON.stringify(Object.values(rendered).map((r) => r.error ?? "ok")));

  const closed = leaves(rendered.closed.resources);
  const open = leaves(rendered.public.resources);
  const differences = [...new Set([...closed.keys(), ...open.keys()])].filter((key) => closed.get(key) !== open.get(key));
  assert.deepEqual(differences, ["Microsoft.Web/sites | app-invi-studio-prod-001.properties.siteConfig.ipSecurityRestrictionsDefaultAction"]);
  const key = differences[0];
  assert.deepEqual([closed.get(key), open.get(key)], ["Deny", "Allow"]);

  // No access rule in either state, SCM keeps its own policy, and nothing but this one site is declared with a rule or default action.
  for (const state of [closed, open]) {
    assert.equal(state.get("Microsoft.Web/sites | app-invi-studio-prod-001.properties.siteConfig.ipSecurityRestrictions"), "[]");
    assert.equal(state.get("Microsoft.Web/sites | app-invi-studio-prod-001.properties.siteConfig.scmIpSecurityRestrictionsDefaultAction"), "Allow");
    assert.equal(state.get("Microsoft.Web/sites | app-invi-studio-prod-001.properties.siteConfig.scmIpSecurityRestrictionsUseMain"), false);
    assert.equal([...state.keys()].filter((name) => /ipSecurityRestrictionsDefaultAction$/i.test(name) && !/scm/i.test(name)).length, 1);
  }
  assert.deepEqual(
    rendered.public.resources.map((resource) => resource.type).sort(),
    rendered.closed.resources.map((resource) => resource.type).sort(),
    "the same resources, no more and no fewer",
  );

  // A parameter left out fails closed, and a value that is not closed or public does not compile.
  assert.equal(leaves(rendered.left_out.resources).get(key), "Deny");
  assert.equal(rendered.unknown.ok, false, "ingressMode only accepts closed or public");
});
