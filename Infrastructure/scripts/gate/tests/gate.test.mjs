// Offline tests of the deployment safety gate. Run: node --test Infrastructure/scripts/gate/tests/
// Every dangerous scenario must be REJECTED; the baseline world and harmless changes must pass.
import { test } from "node:test";
import assert from "node:assert/strict";
import { baseWorld, run, copy, ids, NOW, PRINCIPAL } from "./fixtures.mjs";
import { armGuid } from "../lib/guid.mjs";
import { normalizePath, globToRegExp, isExpression } from "../lib/util.mjs";
import { summarize } from "../summarize-whatif.mjs";

const mutate = (fn) => {
  const w = copy(baseWorld());
  fn(w);
  return w;
};
const failsWith = (report, id) => assert.ok(ids(report).includes(id), `expected ${id} among ${JSON.stringify(ids(report))}`);

test("baseline: a consistent world passes with nothing blocking", () => {
  const r = run(baseWorld());
  assert.equal(r.verdict, "PASS", JSON.stringify(ids(r)));
  assert.equal(r.summary.fail, 0);
  assert.ok(r.verified.sites >= 1 && r.verified.nsgRulesDeclared === 2 && r.verified.subnetsDeclared === 2);
});

// ---- app settings -------------------------------------------------------------------------------------------------------
test("a setting that exists live and is missing from the desired bag is rejected (would be deleted)", () => {
  const r = run(mutate((w) => w.desiredResources.find((x) => x.name === "app-test/appsettings").properties && delete w.desiredResources.find((x) => x.name === "app-test/appsettings").properties.A));
  failsWith(r, "BAG-LIVE-ONLY");
  failsWith(r, "BAG-REQUIRED-MISSING");
});

test("a live-only setting such as a WebDrafts flag is rejected", () => {
  const r = run(mutate((w) => w.live.apps["app-test"].appsettings.push({ name: "WebDrafts__RequireCaptcha", kind: "plain", value: "true", slotSetting: false })));
  failsWith(r, "BAG-LIVE-ONLY");
});

test("an invariant that is violated is rejected (WebDrafts must stay off)", () => {
  const r = run(mutate((w) => (w.desiredResources.find((x) => x.name === "app-test/appsettings").properties.FLAG = "true")));
  failsWith(r, "BAG-INVARIANT");
});

test("a new setting not listed in the manifest is rejected, and accepted when listed", () => {
  const withNew = (w) => (w.desiredResources.find((x) => x.name === "app-test/appsettings").properties.EXTRA = "x");
  failsWith(run(mutate(withNew)), "BAG-NEW");
  const allowed = run(mutate((w) => { withNew(w); w.manifest.deployments.main.allowedNewSettings = { "app-test": ["EXTRA"] }; }));
  assert.equal(allowed.verdict, "PASS");
  assert.ok(ids(allowed, "allowed").includes("BAG-NEW"));
});

test("a changed non-secret value is rejected unless the manifest names it with before and after", () => {
  const change = (w) => (w.desiredResources.find((x) => x.name === "app-test/appsettings").properties.A = "2");
  failsWith(run(mutate(change)), "BAG-VALUE-CHANGE");
  const ok = run(mutate((w) => { change(w); w.manifest.deployments.main.allowedChanges = [{ resource: "app-test", property: "setting:A", before: "1", after: "2", why: "test: approved change of a plain setting" }]; }));
  assert.equal(ok.verdict, "PASS");
});

test("a secret that production holds as a literal cannot become a plain literal in code", () => {
  const r = run(mutate((w) => (w.desiredResources.find((x) => x.name === "app-test/appsettings").properties.SECRET_KEY = "hunter2")));
  failsWith(r, "BAG-SECRET-LITERAL");
  failsWith(r, "BAG-SECURE-FEED-MISSING");
});

test("a secure parameter wired to the wrong environment variable is rejected", () => {
  const r = run(mutate((w) => (w.desiredResources.find((x) => x.name === "app-test/appsettings").properties.SECRET_KEY = "__GATE:OTHER__")));
  failsWith(r, "BAG-SECURE-FEED-MISMATCH");
});

test("a desired bag that cannot be evaluated is rejected, not skipped", () => {
  const r = run(mutate((w) => (w.desiredResources.find((x) => x.name === "app-test/appsettings").properties = "[union(createObject('a','b'), if(true(), createObject(), createObject()))]")));
  failsWith(r, "BAG-UNEVALUATED");
});

// ---- network ------------------------------------------------------------------------------------------------------------
test("a subnet that would be removed is rejected", () => {
  const r = run(mutate((w) => w.live.subnets.push({ name: "snet-migration-temp", addressPrefix: "10.0.4.0/24", ipConfigurations: [{ id: "nic" }], privateEndpointNetworkPolicies: "Disabled", privateLinkServiceNetworkPolicies: "Enabled" })));
  failsWith(r, "NET-SUBNET-REMOVED");
});

test("an NSG rule that would be removed is rejected", () => {
  const r = run(mutate((w) => w.live.nsgs[0].securityRules.push({ name: "Allow-Migration", priority: 120, direction: "Inbound", access: "Allow", protocol: "Tcp", sourcePortRange: "*", destinationPortRange: "3306", sourceAddressPrefix: "10.0.4.0/24", destinationAddressPrefix: "10.0.2.0/24" })));
  failsWith(r, "NET-RULE-REMOVED");
});

test("an NSG rule that would change is rejected", () => {
  const r = run(mutate((w) => (w.desiredResources.find((x) => x.name === "nsg-test").properties.securityRules[0].properties.sourceAddressPrefix = "0.0.0.0/0")));
  failsWith(r, "NET-RULE-CHANGE");
});

test("a changed subnet delegation is rejected", () => {
  const r = run(mutate((w) => (w.desiredResources.find((x) => x.name === "vnet-test").properties.subnets[0].properties.delegations = [])));
  failsWith(r, "NET-SUBNET-DELEGATION");
});

// ---- what-if ------------------------------------------------------------------------------------------------------------
test("a what-if that did not succeed is rejected", () => {
  failsWith(run(mutate((w) => (w.whatif.status = "Failed"))), "WHATIF-STATUS");
});

test("a what-if with an error is rejected", () => {
  failsWith(run(mutate((w) => (w.whatif.error = { code: "AuthorizationFailed", message: "no" }))), "WHATIF-ERROR");
});

test("an empty what-if result is rejected as incomplete", () => {
  failsWith(run(mutate((w) => (w.whatif.changes = []))), "WHATIF-EMPTY");
});

test("a missing what-if file is rejected", () => {
  const w = copy(baseWorld());
  w.whatif = undefined;
  const r = run(w);
  failsWith(r, "EVIDENCE-UNREADABLE");
  failsWith(r, "WHATIF-MISSING");
});

test("a declared resource that what-if did not report is rejected (incomplete result)", () => {
  failsWith(run(mutate((w) => (w.whatif.changes = w.whatif.changes.filter((c) => c.name !== "vnet-test")))), "WHATIF-COVERAGE");
});

test("a resource delete is rejected", () => {
  failsWith(run(mutate((w) => (w.whatif.changes[0].changeType = "Delete"))), "WHATIF-DELETE");
});

test("a created resource that the manifest does not list is rejected (duplicate or surprise)", () => {
  const r = run(mutate((w) => w.whatif.changes.push({ resourceId: "z", type: "Microsoft.Web/sites", name: "app-test-copy", changeType: "Create", deltas: [] })));
  failsWith(r, "WHATIF-CREATE");
});

test("what-if entries it cannot analyse are rejected unless the manifest covers that module", () => {
  const r = run(mutate((w) => (w.manifest.deployments.main.allowedUnsupported = [])));
  failsWith(r, "WHATIF-UNSUPPORTED");
});

test("an array element removed according to what-if is rejected even without live evidence of it", () => {
  const r = run(mutate((w) => {
    const c = w.whatif.changes.find((x) => x.name === "vnet-test");
    c.changeType = "Modify";
    c.deltas = [{ path: "properties.subnets[1]", op: "Delete", before: { kind: "object", name: "snet-migration-temp" } }];
  }));
  failsWith(r, "WHATIF-DELETE-ELEMENT");
});

test("platform noise listed in the manifest is accepted; an unlisted change is not", () => {
  const noisy = (path) => (w) => {
    w.whatif.changes.push({ resourceId: "n", type: "Microsoft.Insights/components", name: "ai", changeType: "Modify", deltas: [{ path, op: "Create" }] });
    w.desiredResources.push({ type: "Microsoft.Insights/components", name: "ai", properties: {} });
    w.manifest.deployments.main.touches.push({ type: "Microsoft.Insights/components", name: "ai" });
  };
  assert.equal(run(mutate(noisy("properties.Flow_Type"))).verdict, "PASS");
  failsWith(run(mutate(noisy("properties.RetentionInDays"))), "WHATIF-UNEXPECTED-CHANGE");
});

test("a change to an immutable property is rejected as a replacement risk", () => {
  const r = run(mutate((w) => {
    const c = w.whatif.changes.find((x) => x.name === "app-test");
    c.changeType = "Modify";
    c.deltas = [{ path: "kind", op: "Modify", before: "app,linux", after: "app" }];
  }));
  failsWith(r, "WHATIF-REPLACEMENT-RISK");
});

// ---- scope and evidence -------------------------------------------------------------------------------------------------
test("the wrong subscription is rejected", () => {
  failsWith(run(mutate((w) => (w.context.account.subscriptionId = "99999999-0000-0000-0000-000000000000"))), "SCOPE-SUBSCRIPTION");
});

test("the wrong resource group is rejected", () => {
  failsWith(run(mutate((w) => (w.context.target.resourceGroup = "rg-other"))), "SCOPE-RESOURCE-GROUP");
});

test("a parameter file that is not the manifest's is rejected", () => {
  failsWith(run(mutate((w) => (w.context.files.parameters.path = "Infrastructure/environments/other.bicepparam"))), "SCOPE-PARAMETERS");
});

test("a parameter file whose using points at another template is rejected", () => {
  failsWith(run(mutate((w) => (w.context.files.parameters.resolvedUsing = "Infrastructure/modules/adminapp.bicep"))), "SCOPE-USING");
});

test("any mode other than Incremental is rejected", () => {
  failsWith(run(mutate((w) => (w.context.mode = "Complete"))), "SCOPE-MODE");
});

test("a step that did not complete is rejected", () => {
  failsWith(run(mutate((w) => (w.context.steps.whatif = 1))), "STEP-FAILED");
});

test("a read-only call that failed (for example missing permission) is rejected", () => {
  failsWith(run(mutate((w) => w.context.liveCalls.push({ name: "roleassignments", rc: 1, required: true }))), "EVIDENCE-CALL");
});

test("stale evidence is rejected", () => {
  failsWith(run(mutate((w) => (w.context.liveCollectedAt = "2026-01-01T10:00:00.000Z"))), "EVIDENCE-STALE");
});

test("missing live evidence is rejected, never read as nothing there", () => {
  const w = copy(baseWorld());
  w.dropFiles = ["live/nsgs.json"];
  failsWith(run(w), "EVIDENCE-UNREADABLE");
});

test("an environment variable that the parameter file reads and the manifest does not declare is rejected", () => {
  failsWith(run(mutate((w) => w.context.envReads.push("SOMETHING_ELSE"))), "ENV-READ-UNDECLARED");
});

test("real secret values in the gate run are rejected", () => {
  failsWith(run(mutate((w) => (w.context.secureEnvironment.mode = "real"))), "SECURE-ENV");
});

test("uncommitted changes are rejected unless the run was explicitly local", () => {
  failsWith(run(mutate((w) => (w.context.git.dirty = true))), "GIT-DIRTY");
  assert.equal(run(mutate((w) => { w.context.git.dirty = true; w.context.git.requireClean = false; })).verdict, "PASS");
});

// ---- RBAC and identities ------------------------------------------------------------------------------------------------
test("an unreviewed role assignment is rejected", () => {
  const r = run(mutate((w) => w.live.roleAssignments.push({ name: "88888888-8888-8888-8888-888888888888", principalId: "p", principalName: "someone", roleDefinitionId: "/x/contributor", roleDefinitionName: "Contributor", scope: "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/rg-test" })));
  failsWith(r, "RBAC-UNREVIEWED");
});

test("the same principal, role and scope under another name is rejected (the deployment would collide)", () => {
  const r = run(mutate((w) => {
    w.live.roleAssignments[0].name = "77777777-7777-7777-7777-777777777777";
    w.manifest.rbac.knownAssignments[0].name = "77777777-7777-7777-7777-777777777777";
  }));
  failsWith(r, "RBAC-NAME-COLLISION");
});

test("a role assignment that does not exist yet is rejected unless the manifest lists it", () => {
  const r = run(mutate((w) => { w.live.roleAssignments.shift(); }));
  failsWith(r, "RBAC-NEW");
});

test("an unreviewed federated credential, or a changed subject, is rejected", () => {
  failsWith(run(mutate((w) => w.live.fic["id-test"].push({ name: "fic-new", subject: "repo:evil/x:ref:refs/heads/main" }))), "FIC-UNREVIEWED");
  failsWith(run(mutate((w) => (w.live.fic["id-test"][0].subject = "repo:o/other:ref:refs/heads/main"))), "FIC-SUBJECT-CHANGED");
  failsWith(run(mutate((w) => w.live.identities.push({ name: "id-extra" }))), "IDENTITY-UNREVIEWED");
});

// ---- sites --------------------------------------------------------------------------------------------------------------
test("a site property that would change is rejected", () => {
  failsWith(run(mutate((w) => (w.desiredResources.find((x) => x.name === "app-test").properties.siteConfig.alwaysOn = false))), "SITE-PROP-CHANGE");
});

test("re-enabling basic publishing credentials is rejected", () => {
  failsWith(run(mutate((w) => (w.desiredResources.find((x) => x.name === "app-test/scm").properties.allow = true))), "PUBLISH-POLICY-CHANGE");
});

test("a deployment slot that would be created is rejected", () => {
  const r = run(mutate((w) => {
    w.desiredResources.push({ type: "Microsoft.Web/sites/slots", name: "app-test/staging", properties: {} });
    w.whatif.changes.push({ resourceId: "s", type: "Microsoft.Web/sites/slots", name: "app-test/staging", changeType: "NoChange" });
  }));
  failsWith(r, "SLOT-NEW");
});

test("a tag that exists live and is not declared is rejected (tags are replaced as a whole)", () => {
  failsWith(run(mutate((w) => (w.live.apps["app-test"].show.tags.owner = "someone"))), "TAG-REMOVED");
});

test("user-assigned identities that the template does not declare are rejected", () => {
  failsWith(run(mutate((w) => (w.live.apps["app-test"].show.identity.userAssignedIdentities = { "/x/id": {} }))), "IDENTITY-DROPPED");
});

// ---- helpers ------------------------------------------------------------------------------------------------------------
test("ARM guid(): name-based UUID with the ARM namespace, deterministic", () => {
  const a = armGuid("/subscriptions/s/resourceGroups/g/providers/Microsoft.KeyVault/vaults/v", PRINCIPAL, "/subscriptions/s/providers/Microsoft.Authorization/roleDefinitions/r");
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(a, armGuid("/subscriptions/s/resourceGroups/g/providers/Microsoft.KeyVault/vaults/v", PRINCIPAL, "/subscriptions/s/providers/Microsoft.Authorization/roleDefinitions/r"));
});

test("path helpers", () => {
  assert.equal(normalizePath("properties.subnets[3].name"), "properties.subnets[*].name");
  assert.ok(globToRegExp("properties.privateDnsZoneConfigs[*].etag").test("properties.privateDnsZoneConfigs[*].etag"));
  assert.ok(isExpression("[parameters('x')]"));
  assert.ok(!isExpression("[[escaped]"));
  assert.ok(!isExpression("plain"));
});

test("the what-if reducer never emits secret values and identifies removed elements by name", () => {
  const secret = "S3cr3t-V4lue-that-must-not-leak-0123456789";
  const raw = {
    status: "Succeeded",
    changes: [
      {
        resourceId: "/subscriptions/s/resourceGroups/g/providers/Microsoft.Web/sites/app/config/appsettings",
        changeType: "Modify",
        before: { properties: { OLD: secret } },
        after: { properties: { RevenueCat__SecretApiKey: secret, Plain: "x" } },
        delta: [{ path: "properties", propertyChangeType: "Create", before: null, after: { RevenueCat__SecretApiKey: secret } }],
      },
      {
        resourceId: "/subscriptions/s/resourceGroups/g/providers/Microsoft.Network/virtualNetworks/vnet",
        changeType: "Modify",
        delta: [{ path: "properties.subnets", propertyChangeType: "Array", children: [{ path: "1", propertyChangeType: "Delete", before: { name: "snet-migration-temp", properties: { addressPrefix: "10.0.4.0/24", secretLooking: secret } }, after: null }] }],
      },
      {
        resourceId: "/subscriptions/s/resourceGroups/g/providers/Microsoft.Web/sites/app",
        changeType: "Modify",
        delta: [{ path: "properties.administratorLoginPassword", propertyChangeType: "Modify", before: secret, after: "[parameters('p')]" }],
      },
    ],
  };
  const out = summarize(raw);
  const text = JSON.stringify(out);
  assert.ok(!text.includes(secret), "secret leaked into the summary");
  const vnet = out.changes.find((c) => c.type === "Microsoft.Network/virtualNetworks");
  assert.deepEqual(vnet.deltas.map((d) => [d.path, d.op, d.before?.name]), [["properties.subnets[1]", "Delete", "snet-migration-temp"]]);
  const bag = out.changes.find((c) => /appsettings/.test(c.name));
  assert.deepEqual(bag.bag.after, ["Plain", "RevenueCat__SecretApiKey"]);
});

test("NOW constant is valid", () => assert.ok(!Number.isNaN(new Date(NOW).getTime())));

// ---- later additions ----------------------------------------------------------------------------------------------------
test("a property the platform reports as null equals its documented default (no change)", () => {
  const w = mutate((x) => {
    x.manifest.defaults = { ...(x.manifest.defaults ?? {}), siteConfig: { scmIpSecurityRestrictionsDefaultAction: "Allow" } };
    x.desiredResources.find((r) => r.name === "app-test").properties.siteConfig.scmIpSecurityRestrictionsDefaultAction = "Allow";
    x.live.apps["app-test"].config.scmIpSecurityRestrictionsDefaultAction = null;
  });
  assert.equal(run(w).verdict, "PASS");
  // ... and without the documented default it is a difference
  const w2 = mutate((x) => {
    x.desiredResources.find((r) => r.name === "app-test").properties.siteConfig.scmIpSecurityRestrictionsDefaultAction = "Allow";
    x.live.apps["app-test"].config.scmIpSecurityRestrictionsDefaultAction = null;
  });
  failsWith(run(w2), "SITE-PROP-CHANGE");
});

test("a role assignment for the identity of a new slot is accepted only together with the approved slot", () => {
  const add = (x) => {
    x.desiredResources.push({
      type: "Microsoft.Authorization/roleAssignments",
      name: "[guid('/s', reference('/subscriptions/x/resourceGroups/rg/providers/Microsoft.Web/sites/app-test/slots/staging', '2024-11-01', 'full').identity.principalId, '/r')]",
      id: "[extensionResourceId('/s', 'Microsoft.Authorization/roleAssignments', 'n')]",
      properties: { roleDefinitionId: "/r", principalId: "[reference('/subscriptions/x/resourceGroups/rg/providers/Microsoft.Web/sites/app-test/slots/staging', '2024-11-01', 'full').identity.principalId]" },
    });
  };
  failsWith(run(mutate(add)), "RBAC-NEW-SLOT-IDENTITY");
  const ok = run(mutate((x) => {
    add(x);
    x.manifest.deployments.main.allowedCreates = [{ type: "Microsoft.Web/sites/slots", name: "app-test/staging", why: "approved" }];
  }));
  assert.ok(ids(ok, "allowed").includes("RBAC-NEW-SLOT-IDENTITY"));
});

test("a siteConfig value what-if would write is accepted only when the manifest names it", () => {
  const dubious = (x) => {
    const c = x.whatif.changes.find((y) => y.name === "app-test");
    c.changeType = "Modify";
    c.deltas = [{ path: "properties.siteConfig.ipSecurityRestrictionsDefaultAction", op: "Create", before: null, after: "Deny" }];
  };
  failsWith(run(mutate(dubious)), "WHATIF-SITECONFIG");
  const ok = run(mutate((x) => {
    dubious(x);
    x.manifest.deployments.main.allowedChanges = [{ resource: "app-test", property: "siteConfig.ipSecurityRestrictionsDefaultAction", before: "Allow", after: "Deny", why: "containment" }];
  }));
  assert.ok(ids(ok, "allowed").includes("WHATIF-SITECONFIG"));
});

test("values of secret-looking settings never appear in report messages", () => {
  const w = mutate((x) => {
    x.desiredResources.find((r) => r.name === "app-test/appsettings").properties.WEBHOOK_TOKEN = "plain-desired-value-that-should-be-hidden-1234567890";
    x.live.apps["app-test"].appsettings.push({ name: "WEBHOOK_TOKEN", kind: "plain", value: "plain-live-value-that-should-be-hidden-0987654321", slotSetting: false });
  });
  const r = run(w);
  failsWith(r, "BAG-VALUE-CHANGE");
  assert.ok(!JSON.stringify(r).includes("should-be-hidden"), "a value leaked into the report");
});

test("missing evidence is reported once, with the file names", () => {
  const w = copy(baseWorld());
  w.dropFiles = ["live/nsgs.json", "live/subnets.json"];
  const r = run(w);
  const f = r.findings.filter((x) => x.id === "EVIDENCE-UNREADABLE");
  assert.equal(f.length, 1);
  assert.match(f[0].message, /nsgs\.json/);
});
