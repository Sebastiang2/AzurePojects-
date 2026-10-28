import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const studio = read("modules/studioapi.bicep");
const rbac = read("modules/studioapi-rbac.bicep");
const params = read("environments/prod.studioapi.bicepparam");
const rbacParams = read("environments/prod.studioapi.rbac-owner.bicepparam");
const manifest = JSON.parse(read("safety/manifest.json"));

test("VNet integration and Route All are set in the site resource itself, as on the admin app", () => {
  const site = /resource studioApi 'Microsoft\.Web\/sites@[^']+' = \{[\s\S]*?\n\}/.exec(studio)?.[0] ?? "";
  assert.match(site, /virtualNetworkSubnetId: appServiceSubnet\.id/);
  assert.match(site, /outboundVnetRouting: \{\s*applicationTraffic: true/);
  assert.match(site, /vnetRouteAllEnabled: true/);
  assert.match(site, /keyVaultReferenceIdentity: 'SystemAssigned'/);
  assert.doesNotMatch(studio, /sites\/networkConfig/, "a separate networkConfig resource lost Route All on the admin app");
});

test("the site is closed by default and never opens SCM through the main-site rules", () => {
  assert.match(studio, /param studioInboundOpen bool = false/);
  assert.match(studio, /ipSecurityRestrictions: studioInboundOpen \? inboundAllowRules : \[\]/);
  assert.match(studio, /ipSecurityRestrictionsDefaultAction: 'Deny'/);
  assert.match(studio, /scmIpSecurityRestrictionsUseMain: false/);
  assert.match(params, /^param studioInboundOpen = false$/m);
});

test("background jobs need Always On; Health check stays off until it is switched on", () => {
  assert.match(studio, /alwaysOn: true/);
  assert.match(studio, /param studioHealthCheckEnabled bool = false/);
  assert.match(studio, /healthCheckPath: studioHealthCheckEnabled \? '\/health' : null/);
  assert.match(params, /^param studioHealthCheckEnabled = false$/m);
});

test("secrets are Key Vault references only, and every referenced secret gets per-secret access in B", () => {
  assert.match(studio, /'@Microsoft\.KeyVault\(VaultName=\$\{keyVaultName\};SecretName=\$\{reference\.secretName\}\)'/);
  assert.doesNotMatch(studio, /@secure\(\)/, "no secret value passes through this deployment");
  const referenced = [...(/param keyVaultReferences = \[([\s\S]*?)\n\]/.exec(params)?.[1] ?? "").matchAll(/secretName: '([^']+)'/g)].map((m) => m[1]);
  const granted = [...(/param secretNames = \[([\s\S]*?)\]/.exec(rbacParams)?.[1] ?? "").matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.ok(referenced.length > 0);
  assert.deepEqual([...referenced].sort(), [...granted].sort(), "keyVaultReferences and secretNames must name the same secrets");
  assert.match(rbac, /module secretAccess 'rbac-keyvault-secret-scope\.bicep'/, "access per secret, never vault-wide");
  assert.doesNotMatch(rbac, /scope: keyVault\b/);
});

test("the GitHub identity can publish to the Studio site only, and its credential exists only with a repository", () => {
  assert.match(rbac, /'de139f84-1756-47ae-9be6-808fbbe84772'/, "Website Contributor");
  assert.match(rbac, /scope: studioApi\n/);
  assert.match(rbac, /principalId: githubDeployPrincipalId/);
  assert.match(studio, /federatedIdentityCredentials@[^']+' = if \(!empty\(githubRepository\)\)/);
  assert.match(studio, /subject: 'repo:\$\{githubRepository\}:environment:\$\{githubEnvironment\}'/);
});

test("Swagger stays off and the platform does not build on the shared instance", () => {
  assert.doesNotMatch(studio, /^\s*ENABLE_SWAGGER:/m);
  assert.match(studio, /SCM_DO_BUILD_DURING_DEPLOYMENT: 'false'/);
  assert.match(studio, /STUDIO_RESOURCES_ENABLED: 'true'/);
});

test("the manifest approves exactly the Studio resources for A and lists the new deploy identity", () => {
  const a = manifest.deployments["studioapi-a"];
  assert.equal(a.template, "Infrastructure/modules/studioapi.bicep");
  assert.equal(a.parameters, "Infrastructure/environments/prod.studioapi.bicepparam");
  for (const entry of [...a.allowedCreates, ...a.touches]) {
    assert.match(entry.name, /studio-api-prod-001/, `${entry.type} ${entry.name} is not a Studio resource`);
  }
  assert.ok(manifest.identities.known["id-gha-invi-studio-api-prod-001"], "the gate fails on an unreviewed identity");
  const b = manifest.deployments["studioapi-b-rbac"];
  assert.equal(b.template, "Infrastructure/modules/studioapi-rbac.bicep");
});

test("the collector skips a site only when the listing and the site itself both say it does not exist", () => {
  const collector = read("scripts/gate/collect-live.sh");
  assert.match(collector, /\[ "\$RESOURCES_RC" = "0" \] \|\| return 1/, "a failed resource listing never skips a site");
  assert.match(collector, /grep -Fxqi -- "\$app" && return 1/, "a listed site is always collected");
  assert.match(collector, /show_not_found "apps\/\$app\.absent" az webapp show/);
  assert.match(collector, /ResourceNotFound\|could not be found\|was not found/);
});
