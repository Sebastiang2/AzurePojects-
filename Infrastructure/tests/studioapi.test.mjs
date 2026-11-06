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

test("the site admits the App Service integration subnet by its service endpoint, first in the list, and is still closed by default", () => {
  assert.match(studio, /var inboundAllowRules = concat\(\s*\[\s*\{\s*name: 'Allow-AppService-Subnet'\s*priority: 90\s*action: 'Allow'\s*vnetSubnetResourceId: appServiceSubnet\.id\s*\}\s*\]/);
  assert.match(studio, /var appServiceSubnetName = 'snet-appservice-integration'/);
  assert.match(studio, /ipSecurityRestrictions: studioInboundOpen \? inboundAllowRules : \[\]/, "the rules are only used when the site is opened");
  assert.match(studio, /ipSecurityRestrictionsDefaultAction: 'Deny'/);
  assert.match(params, /^param studioInboundOpen = false$/m);
});

test("the network module declares the Microsoft.Web service endpoint that the subnet rule relies on", () => {
  const network = read("modules/network.bicep");
  const subnet = /name: 'snet-appservice-integration'[\s\S]*?\n      \}\n/.exec(network)?.[0] ?? "";
  assert.match(subnet, /serviceEndpoints: \[\s*\{\s*service: 'Microsoft\.Web'\s*locations: \[\s*'\*'\s*\]\s*\}\s*\]/, "without it a deployment of main.bicep removes the endpoint the live subnet has");
  assert.match(subnet, /serviceName: 'Microsoft\.Web\/serverFarms'/, "the endpoint is on the delegated App Service integration subnet");
});

test("phase 2 is set: startup command, deploy repository (plain OIDC subject) and ADMIN_ACCESS_MODE=enforce", () => {
  const code = params.replace(/^\s*\/\/.*$/gm, "");
  assert.match(code, /^param appCommandLine = 'dotnet invi-studio-api\.dll'$/m);
  assert.match(code, /^param githubRepository = 'CetchApp\/cetchapp-onboarding-api'$/m);
  assert.match(code, /ADMIN_ACCESS_MODE: 'enforce'/);
  // The credential the module builds for that repository is the one reviewed in the manifest: a mismatch is an AADSTS700213 at the first deployment.
  const repository = /^param githubRepository = '([^']+)'$/m.exec(code)[1];
  const environment = /param githubEnvironment string = '([^']+)'/.exec(studio)[1];
  assert.equal(manifest.identities.known["id-gha-invi-studio-api-prod-001"]["github-production"].subject, `repo:${repository}:environment:${environment}`);
  // The opt-in lock-down of the shared Render service and the e-mail flow (Studio web has it off) are not switched on here.
  for (const name of ["STUDIO_SERVER_ONLY", "ADMIN_ROUTES_ENABLED", "STUDIO_REQUIRE_EMAIL"]) assert.doesNotMatch(code, new RegExp(name), `${name} stays absent`);
});

test("the database is the production one: the Core DB on the production server, with the production activity creator", () => {
  const code = params.replace(/^\s*\/\/.*$/gm, "");
  assert.match(code, /^param databaseName = 'invi'$/m);
  assert.match(code, /^param databaseUser = 'inviadmin'$/m);
  assert.match(code, /^param activityCreatorId = 1636$/m, "never the test creator 657");
  assert.match(studio, /ONBOARDING_DB_HOST: mysqlServer\.properties\.fullyQualifiedDomainName/);
  assert.match(studio, /var mysqlServerName = 'mysql-\$\{workloadName\}-\$\{environment\}-\$\{instance\}'/);
  assert.match(studio, /ONBOARDING_DB_SSL_MODE: 'Required'/);
});
