// A small, synthetic "world" for the gate tests: a manifest, an offline snapshot of the template, a reduced what-if result and
// the collected live state, all consistent with each other so the baseline passes. Tests mutate a deep copy and expect the
// gate to fail for exactly the reason they introduce. Nothing here is production data.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyze } from "../analyze.mjs";
import { armGuid } from "../lib/guid.mjs";

export const SUB = "00000000-0000-0000-0000-000000000001";
export const TENANT = "00000000-0000-0000-0000-000000000002";
export const RG = "rg-test";
const SCOPE_PREFIX = `/subscriptions/${SUB}/resourceGroups/${RG}/providers`;
const KV_ID = `${SCOPE_PREFIX}/Microsoft.KeyVault/vaults/kv-test`;
const ROLE = `/subscriptions/${SUB}/providers/Microsoft.Authorization/roleDefinitions/4633458b-17de-408a-b874-0445c86b69e6`;
export const PRINCIPAL = "11111111-1111-1111-1111-111111111111";
export const NOW = "2026-01-01T12:00:00.000Z";

const clone = (v) => JSON.parse(JSON.stringify(v));

export function baseWorld() {
  const roleName = armGuid(KV_ID, PRINCIPAL, ROLE);
  const manifest = {
    schemaVersion: 1,
    scope: { subscriptionId: SUB, tenantId: TENANT, resourceGroup: RG, location: "swedencentral" },
    maxEvidenceAgeMinutes: 30,
    defaults: { subnet: { privateEndpointNetworkPolicies: "Disabled", privateLinkServiceNetworkPolicies: "Enabled" } },
    apps: {
      "app-test": {
        required: ["A", "FLAG", "SECRET_KEY"],
        mustEqual: { FLAG: "false" },
        secureFeeds: { SECRET_KEY: "TEST_SECRET" },
      },
    },
    noise: [
      { type: "Microsoft.Insights/components", ops: ["Create"], paths: ["properties.Flow_Type"], why: "platform default" },
    ],
    immutable: [{ type: "Microsoft.Web/sites", path: "kind", why: "cannot change" }],
    rbac: {
      watchedRoles: ["*"],
      knownAssignments: [
        { name: roleName, role: "Key Vault Secrets User", description: "app-test on the vault", status: "declared" },
        { name: "99999999-9999-9999-9999-999999999999", role: "Owner", description: "owner", status: "accepted" },
      ],
    },
    identities: { known: { "id-test": { "fic-main": { subject: "repo:o/r:ref:refs/heads/main", status: "active" } } } },
    residualRisks: [{ id: "R-TEST", text: "a residual risk" }],
    deployments: {
      main: {
        template: "Infrastructure/main.bicep",
        parameters: "Infrastructure/environments/prod.bicepparam",
        deploymentName: "test",
        secureEnvironment: ["TEST_SECRET"],
        allowedCreates: [],
        allowedUnsupported: [],
        allowedNewSettings: {},
        allowedRemovedSettings: {},
        allowedChanges: [],
        touches: [],
      },
    },
  };

  const desiredResources = [
    {
      type: "Microsoft.Network/virtualNetworks",
      name: "vnet-test",
      properties: {
        addressSpace: { addressPrefixes: ["10.0.0.0/16"] },
        subnets: [
          {
            name: "snet-a",
            properties: {
              addressPrefix: "10.0.1.0/24",
              networkSecurityGroup: { id: `${SCOPE_PREFIX}/Microsoft.Network/networkSecurityGroups/nsg-test` },
              delegations: [{ name: "d", properties: { serviceName: "Microsoft.Web/serverFarms" } }],
            },
          },
          { name: "snet-b", properties: { addressPrefix: "10.0.2.0/24" } },
        ],
      },
    },
    {
      type: "Microsoft.Network/networkSecurityGroups",
      name: "nsg-test",
      properties: {
        securityRules: [
          { name: "Allow-A", properties: { priority: 100, direction: "Inbound", access: "Allow", protocol: "Tcp", sourcePortRange: "*", destinationPortRange: "443", sourceAddressPrefix: "10.0.1.0/24", destinationAddressPrefix: "10.0.2.0/24" } },
          { name: "Deny-B", properties: { priority: 4000, direction: "Inbound", access: "Deny", protocol: "*", sourcePortRange: "*", destinationPortRange: "*", sourceAddressPrefix: "*", destinationAddressPrefix: "*" } },
        ],
      },
    },
    {
      type: "Microsoft.Web/sites",
      name: "app-test",
      kind: "app,linux",
      identity: { type: "SystemAssigned" },
      tags: { env: "test" },
      properties: { httpsOnly: true, publicNetworkAccess: "Enabled", siteConfig: { alwaysOn: true, ftpsState: "Disabled" } },
    },
    {
      type: "Microsoft.Web/sites/config",
      name: "app-test/appsettings",
      properties: {
        A: "1",
        FLAG: "false",
        SECRET_KEY: "__GATE:TEST_SECRET__",
        VAULTED: "@Microsoft.KeyVault(VaultName=kv-test;SecretName=s)",
        COMPUTED: "[reference('/subscriptions/x/resourceGroups/y/providers/Microsoft.Foo/bar/baz', '2024-01-01').fqdn]",
      },
    },
    { type: "Microsoft.Web/sites/basicPublishingCredentialsPolicies", name: "app-test/ftp", properties: { allow: false } },
    { type: "Microsoft.Web/sites/basicPublishingCredentialsPolicies", name: "app-test/scm", properties: { allow: false } },
    {
      type: "Microsoft.Authorization/roleAssignments",
      name: `[guid('${KV_ID}', reference('${SCOPE_PREFIX}/Microsoft.Web/sites/app-test', '2024-11-01', 'full').identity.principalId, '${ROLE}')]`,
      id: `[extensionResourceId('${KV_ID}', 'Microsoft.Authorization/roleAssignments', guid('${KV_ID}', reference('${SCOPE_PREFIX}/Microsoft.Web/sites/app-test', '2024-11-01', 'full').identity.principalId, '${ROLE}'))]`,
      properties: {
        roleDefinitionId: ROLE,
        principalId: `[reference('${SCOPE_PREFIX}/Microsoft.Web/sites/app-test', '2024-11-01', 'full').identity.principalId]`,
      },
    },
  ];

  const live = {
    apps: {
      "app-test": {
        show: { httpsOnly: true, publicNetworkAccess: "Enabled", kind: "app,linux", tags: { env: "test" }, identity: { type: "SystemAssigned", principalId: PRINCIPAL } },
        config: { alwaysOn: true, ftpsState: "Disabled" },
        appsettings: [
          { name: "A", kind: "plain", value: "1", slotSetting: false },
          { name: "FLAG", kind: "plain", value: "false", slotSetting: false },
          { name: "SECRET_KEY", kind: "secret-literal", slotSetting: false },
          { name: "VAULTED", kind: "keyvault-reference", value: "@Microsoft.KeyVault(VaultName=kv-test;SecretName=s)", slotSetting: false },
          { name: "COMPUTED", kind: "plain", value: "x.example.net", slotSetting: false },
        ],
        kvrefs: { value: [] },
        slots: [],
        slotconfignames: { properties: { appSettingNames: [] } },
        accessrestrictions: { ipSecurityRestrictions: [], scmIpSecurityRestrictions: [] },
        publishpolicy_ftp: { properties: { allow: false } },
        publishpolicy_scm: { properties: { allow: false } },
        hostnamebindings: { value: [] },
        networkconfig: {},
        diag: [],
        authsettingsv2: { properties: { platform: { enabled: false } } },
      },
    },
    resources: [
      { type: "Microsoft.Web/sites", name: "app-test" },
      { type: "Microsoft.Network/virtualNetworks", name: "vnet-test" },
    ],
    vnet: { name: "vnet-test", addressSpace: { addressPrefixes: ["10.0.0.0/16"] } },
    subnets: [
      { name: "snet-a", addressPrefix: "10.0.1.0/24", networkSecurityGroup: { id: `${SCOPE_PREFIX}/Microsoft.Network/networkSecurityGroups/nsg-test` }, delegations: [{ name: "d", serviceName: "Microsoft.Web/serverFarms" }], privateEndpointNetworkPolicies: "Disabled", privateLinkServiceNetworkPolicies: "Enabled" },
      { name: "snet-b", addressPrefix: "10.0.2.0/24", privateEndpointNetworkPolicies: "Disabled", privateLinkServiceNetworkPolicies: "Enabled" },
    ],
    nsgs: [
      {
        name: "nsg-test",
        securityRules: [
          { name: "Allow-A", priority: 100, direction: "Inbound", access: "Allow", protocol: "Tcp", sourcePortRange: "*", destinationPortRange: "443", sourceAddressPrefix: "10.0.1.0/24", destinationAddressPrefix: "10.0.2.0/24" },
          { name: "Deny-B", priority: 4000, direction: "Inbound", access: "Deny", protocol: "*", sourcePortRange: "*", destinationPortRange: "*", sourceAddressPrefix: "*", destinationAddressPrefix: "*" },
        ],
      },
    ],
    privateEndpoints: [],
    privateDnsZones: [],
    mysql: null,
    keyvault: null,
    roleAssignments: [
      { name: roleName, principalId: PRINCIPAL, principalName: "app-test", roleDefinitionId: ROLE, roleDefinitionName: "Key Vault Secrets User", scope: KV_ID },
      { name: "99999999-9999-9999-9999-999999999999", principalId: "22222222-2222-2222-2222-222222222222", principalName: "owner", roleDefinitionId: "/x/owner", roleDefinitionName: "Owner", scope: `/subscriptions/${SUB}` },
    ],
    identities: [{ name: "id-test" }],
    fic: { "id-test": [{ name: "fic-main", subject: "repo:o/r:ref:refs/heads/main" }] },
    staticSites: [],
    certs: [],
  };

  const whatif = {
    schema: "whatif-summary/1",
    status: "Succeeded",
    error: null,
    counts: { NoChange: 7 },
    changes: desiredResources
      .filter((r) => !r.name.startsWith("["))
      .map((r) => ({ resourceId: "x", type: r.type, name: r.name, changeType: "NoChange" }))
      .concat([{ resourceId: "y", type: "Microsoft.Authorization/roleDefinitions", name: "x", changeType: "Unsupported", unsupportedReason: "declared at 'properties.template.resources.rbac.properties.template.resources[0]'", deltas: [] }]),
  };
  manifest.deployments.main.allowedUnsupported = [{ module: "rbac", why: "guid() names verified by RBAC checks" }];

  const context = {
    schema: "gate-context/1",
    deployment: "main",
    mode: "Incremental",
    account: { subscriptionId: SUB, tenantId: TENANT },
    target: { resourceGroup: RG, resourceGroupExists: true },
    files: {
      template: { path: "Infrastructure/main.bicep", resolvedUsing: "Infrastructure/main.bicep" },
      parameters: { path: "Infrastructure/environments/prod.bicepparam", using: "../main.bicep", resolvedUsing: "Infrastructure/main.bicep" },
    },
    envReads: ["TEST_SECRET"],
    git: { dirty: false, requireClean: true },
    steps: { compile: 0, lint: 0, params: 0, snapshot: 0, whatif: 0, live: 0 },
    secureEnvironment: { mode: "placeholders", placeholders: ["TEST_SECRET"], presence: { TEST_SECRET: true } },
    liveCollectedAt: "2026-01-01T11:55:00.000Z",
    liveCalls: [{ name: "resources", rc: 0, required: true }],
  };

  return { manifest, desiredResources, live, whatif, context };
}

/** Writes a world to a temp work directory in the layout preflight.sh produces, runs the engine, returns the report. */
export function run(world) {
  const root = mkdtempSync(join(tmpdir(), "gate-test-"));
  try {
    const write = (rel, value) => {
      const p = join(root, rel);
      mkdirSync(join(p, ".."), { recursive: true });
      writeFileSync(p, typeof value === "string" ? value : JSON.stringify(value));
    };
    write("manifest.json", world.manifest);
    write("context.json", world.context);
    write("snapshot.json", { predictedResources: world.desiredResources });
    if (world.whatif !== undefined) write("whatif.json", world.whatif);
    const L = world.live;
    for (const [name, a] of Object.entries(L.apps)) {
      write(`live/apps/${name}.show.json`, a.show);
      write(`live/apps/${name}.config.json`, a.config);
      write(`live/apps/${name}.appsettings.json`, a.appsettings);
      write(`live/apps/${name}.kvrefs.json`, a.kvrefs);
      write(`live/apps/${name}.slots.json`, a.slots);
      write(`live/apps/${name}.slotconfignames.json`, a.slotconfignames);
      write(`live/apps/${name}.accessrestrictions.json`, a.accessrestrictions);
      write(`live/apps/${name}.publishpolicy.ftp.json`, a.publishpolicy_ftp);
      write(`live/apps/${name}.publishpolicy.scm.json`, a.publishpolicy_scm);
      write(`live/apps/${name}.hostnamebindings.json`, a.hostnamebindings);
      write(`live/apps/${name}.networkconfig.json`, a.networkconfig);
      write(`live/apps/${name}.diag.json`, a.diag);
      write(`live/apps/${name}.authsettingsv2.json`, a.authsettingsv2);
    }
    write("live/account.json", { id: SUB });
    write("live/resources.json", L.resources);
    write("live/plan.json", L.plan ?? {});
    write("live/vnet.json", L.vnet);
    write("live/subnets.json", L.subnets);
    write("live/nsgs.json", L.nsgs);
    write("live/private-endpoints.json", L.privateEndpoints);
    write("live/private-dns-zones.json", L.privateDnsZones);
    write("live/mysql.json", L.mysql ?? {});
    write("live/keyvault.json", L.keyvault ?? {});
    write("live/roleassignments.json", L.roleAssignments);
    write("live/identities.json", L.identities);
    for (const [name, list] of Object.entries(L.fic)) write(`live/fic.${name}.json`, list);
    write("live/swa.list.json", L.staticSites);
    for (const f of world.dropFiles ?? []) rmSync(join(root, f), { force: true });
    const result = analyze({ work: root, manifestPath: join(root, "manifest.json"), deploymentKey: "main", now: new Date(NOW) });
    return result.fatal ? { fatal: result.fatal } : result.report;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

export const copy = clone;
export const ids = (report, severity = "fail") => report.findings.filter((f) => f.severity === severity).map((f) => f.id);
