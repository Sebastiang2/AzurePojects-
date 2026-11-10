// Production that already matches the code must not read as a change. Three readings made the gate fail on a deployment that
// would write nothing (dry run of `main`, 2026-11-10):
//   - the plan of a site: Azure CLI 2.82 returns it as appServicePlanId, not serverFarmId
//   - an access rule declared without a tag: Azure returns the same rule with tag "Default"
//   - the origin lock already live: what-if cannot read siteConfig and reports the declared list as Create every time
// Each test below pairs the accepted steady state with the real change it must keep refusing. Synthetic worlds from
// fixtures.mjs, no Azure call.
// Run: node --test Infrastructure/scripts/gate/tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { baseWorld, run, copy, ids } from "./fixtures.mjs";

const mutate = (fn) => {
  const world = copy(baseWorld());
  fn(world);
  return world;
};
const failsWith = (report, id) => assert.ok(ids(report).includes(id), `expected ${id} among ${JSON.stringify(ids(report))}`);
const SITE = "app-test";
const PLAN = "/subscriptions/x/resourceGroups/rg-test/providers/Microsoft.Web/serverfarms/asp-test";
const site = (w) => w.desiredResources.find((r) => r.name === SITE);

// ---- the plan of a site ------------------------------------------------------------------------------------------------
test("the plan is read from appServicePlanId when the Azure CLI omits serverFarmId", () => {
  const r = run(mutate((w) => {
    site(w).properties.serverFarmId = PLAN;
    w.live.apps[SITE].show.appServicePlanId = PLAN;
  }));
  assert.ok(!ids(r).includes("SITE-PROP-CHANGE"), JSON.stringify(ids(r)));
});

test("a site that would move to another plan still fails, whichever field names the live plan", () => {
  for (const field of ["serverFarmId", "appServicePlanId"]) {
    failsWith(run(mutate((w) => {
      site(w).properties.serverFarmId = PLAN;
      w.live.apps[SITE].show[field] = "/subscriptions/x/resourceGroups/rg-test/providers/Microsoft.Web/serverfarms/asp-other";
    })), "SITE-PROP-CHANGE");
  }
});

test("a declared plan with no live plan at all still fails", () => {
  failsWith(run(mutate((w) => (site(w).properties.serverFarmId = PLAN))), "SITE-PROP-CHANGE");
});

// ---- the tag of an access rule -----------------------------------------------------------------------------------------
const ipRule = { name: "Allow-Range-01", priority: 100, action: "Allow", ipAddress: "173.245.48.0/20" };
const ruleWorld = (w, live) => {
  site(w).properties.siteConfig.ipSecurityRestrictions = [structuredClone(ipRule)];
  site(w).properties.siteConfig.ipSecurityRestrictionsDefaultAction = "Deny";
  w.live.apps[SITE].config.ipSecurityRestrictionsDefaultAction = "Deny";
  w.live.apps[SITE].accessrestrictions = { ipSecurityRestrictions: [{ ...structuredClone(ipRule), ...live }] };
};

test("an IP rule declared without a tag matches the live rule Azure tags Default", () => {
  const r = run(mutate((w) => ruleWorld(w, { tag: "Default" })));
  assert.ok(!ids(r).includes("ACCESS-RULE-CHANGE"), JSON.stringify(ids(r)));
});

test("an address, priority, action or service tag that really differs still fails", () => {
  for (const live of [{ tag: "Default", ipAddress: "0.0.0.0/0" }, { tag: "Default", priority: 101 },
    { tag: "Default", action: "Deny" }, { tag: "ServiceTag", ipAddress: "AzureFrontDoor.Backend" }]) {
    failsWith(run(mutate((w) => ruleWorld(w, live))), "ACCESS-RULE-CHANGE");
  }
});

// ---- the origin lock already live --------------------------------------------------------------------------------------
/** The lock live and declared the same: what-if still reports the whole list and the default as Create. */
const steadyWorld = (w) => {
  const sc = site(w).properties.siteConfig;
  sc.ipSecurityRestrictions = [structuredClone(ipRule)];
  sc.ipSecurityRestrictionsDefaultAction = "Deny";
  sc.scmIpSecurityRestrictions = [];
  sc.scmIpSecurityRestrictionsUseMain = false;
  const app = w.live.apps[SITE];
  app.config.ipSecurityRestrictionsDefaultAction = "Deny";
  app.config.scmIpSecurityRestrictionsUseMain = false;
  app.accessrestrictions = { ipSecurityRestrictions: [{ ...structuredClone(ipRule), tag: "Default" }] };
  const deployment = w.manifest.deployments.main;
  deployment.originLock = { resource: SITE, why: "Only the reviewed range may change", rules: [structuredClone(ipRule)] };
  deployment.touches = [{ type: "Microsoft.Web/sites", name: SITE }];
  const change = w.whatif.changes.find((c) => c.name === SITE && c.type === "Microsoft.Web/sites");
  change.changeType = "Modify";
  change.deltas = [
    { path: "properties.siteConfig.ipSecurityRestrictions", op: "Create", before: null, after: { kind: "array", length: 1, names: [ipRule.name] } },
    { path: "properties.siteConfig.ipSecurityRestrictionsDefaultAction", op: "Create", before: null, after: "Deny" },
  ];
};

test("the origin lock already live and declared unchanged is not a change", () => {
  const r = run(mutate(steadyWorld));
  assert.ok(ids(r, "allowed").includes("WHATIF-ORIGIN-STEADY"), JSON.stringify(ids(r, "allowed")));
  for (const id of ["WHATIF-ORIGIN-LOCK", "ORIGIN-MAIN-TRANSITION", "ACCESS-RULE-CHANGE", "ACCESS-ORIGIN-SET"]) {
    assert.ok(!ids(r).includes(id), `${id} among ${JSON.stringify(ids(r))}`);
  }
});

test("a steady lock does not excuse a rule, a default or a name the manifest does not have", () => {
  // an extra live rule outside the lock
  failsWith(run(mutate((w) => {
    steadyWorld(w);
    w.live.apps[SITE].accessrestrictions.ipSecurityRestrictions.push({ name: "Unknown", priority: 101, action: "Allow", ipAddress: "10.0.0.0/8", tag: "Default" });
  })), "ACCESS-RULE-REMOVED");
  // a declared range the manifest's lock does not have
  failsWith(run(mutate((w) => {
    steadyWorld(w);
    site(w).properties.siteConfig.ipSecurityRestrictions[0].ipAddress = "0.0.0.0/0";
  })), "ACCESS-ORIGIN-SET");
  // what-if would write Allow as the default
  failsWith(run(mutate((w) => {
    steadyWorld(w);
    w.whatif.changes.find((c) => c.name === SITE && c.type === "Microsoft.Web/sites").deltas[1].after = "Allow";
  })), "WHATIF-ORIGIN-LOCK");
  // what-if names a rule nobody reviewed
  failsWith(run(mutate((w) => {
    steadyWorld(w);
    w.whatif.changes.find((c) => c.name === SITE && c.type === "Microsoft.Web/sites").deltas[0].after.names = ["Unknown"];
  })), "WHATIF-ORIGIN-LOCK");
  // what-if would write more rules than the lock has
  failsWith(run(mutate((w) => {
    steadyWorld(w);
    const after = w.whatif.changes.find((c) => c.name === SITE && c.type === "Microsoft.Web/sites").deltas[0].after;
    after.length = 2;
    after.names = [ipRule.name, ipRule.name];
  })), "WHATIF-ORIGIN-LOCK");
});

test("enabling or rolling back the lock through a full main deployment is still refused", () => {
  // live without the lock, declared with it: the enable transition, not a steady state
  failsWith(run(mutate((w) => {
    steadyWorld(w);
    w.live.apps[SITE].accessrestrictions.ipSecurityRestrictions = [];
    w.live.apps[SITE].config.ipSecurityRestrictionsDefaultAction = "Allow";
  })), "ORIGIN-MAIN-TRANSITION");
  // live with the lock, declared empty and open: the rollback
  failsWith(run(mutate((w) => {
    steadyWorld(w);
    site(w).properties.siteConfig.ipSecurityRestrictions = [];
    site(w).properties.siteConfig.ipSecurityRestrictionsDefaultAction = "Allow";
  })), "ORIGIN-MAIN-TRANSITION");
});
