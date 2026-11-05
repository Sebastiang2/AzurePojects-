// The reviewed ingress step of Studio web (studio-web-e-ingress-public) and its rollback (studio-web-e-ingress-close) as the gate judges them.
// Synthetic worlds from fixtures.mjs, no Azure call. The entries under test are the REAL ones from the manifest, with the name of the synthetic
// site substituted, so a manifest entry the gate cannot read is caught here and not at deploy time.
// Run: node --test Infrastructure/scripts/gate/tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { baseWorld, run, copy, ids } from "./fixtures.mjs";

const manifest = JSON.parse(readFileSync(new URL("../../../safety/manifest.json", import.meta.url), "utf8"));
const mutate = (fn) => {
  const world = copy(baseWorld());
  fn(world);
  return world;
};
const failsWith = (report, id) => assert.ok(ids(report).includes(id), `expected ${id} among ${JSON.stringify(ids(report))}`);

const SITE = "app-test";

/** The real allowedChanges of a deployment key, with the production site name replaced by the name of the synthetic site. */
const realEntries = (key) =>
  JSON.parse(
    JSON.stringify(manifest.deployments[key].allowedChanges)
      .replaceAll("app-invi-studio-prod-001", SITE),
  );

// ---- E: the reviewed ingress step, and its rollback ------------------------------------------------------------------------------
const ingressWorld = (w, { open, entries }) => {
  const site = w.desiredResources.find((r) => r.name === SITE);
  site.properties.siteConfig.ipSecurityRestrictions = [];
  site.properties.siteConfig.ipSecurityRestrictionsDefaultAction = open ? "Allow" : "Deny";
  w.live.apps[SITE].config.ipSecurityRestrictionsDefaultAction = open ? "Deny" : "Allow";
  const change = w.whatif.changes.find((c) => c.name === SITE && c.type === "Microsoft.Web/sites");
  change.changeType = "Modify";
  change.deltas = [{ path: "properties.siteConfig.ipSecurityRestrictionsDefaultAction", op: "Modify", before: open ? "Deny" : "Allow", after: open ? "Allow" : "Deny" }];
  w.manifest.deployments.main.touches = [{ type: "Microsoft.Web/sites", name: SITE }];
  w.manifest.deployments.main.allowedChanges = entries;
};

test("E: opening the main site and closing it again each pass with their own manifest entries", () => {
  const open = run(mutate((w) => ingressWorld(w, { open: true, entries: realEntries("studio-web-e-ingress-public") })));
  assert.equal(open.verdict, "PASS", JSON.stringify(ids(open)));
  assert.ok(ids(open, "allowed").includes("SITE-PROP-CHANGE") && ids(open, "allowed").includes("WHATIF-CHANGE"));
  const close = run(mutate((w) => ingressWorld(w, { open: false, entries: realEntries("studio-web-e-ingress-close") })));
  assert.equal(close.verdict, "PASS", JSON.stringify(ids(close)));
});

test("E: the opening entries do not approve closing, and the closing entries do not approve opening", () => {
  failsWith(run(mutate((w) => ingressWorld(w, { open: false, entries: realEntries("studio-web-e-ingress-public") }))), "SITE-PROP-CHANGE");
  failsWith(run(mutate((w) => ingressWorld(w, { open: true, entries: realEntries("studio-web-e-ingress-close") }))), "SITE-PROP-CHANGE");
});

test("E: without the entries opening the main site is rejected, offline and in the what-if", () => {
  const report = run(mutate((w) => ingressWorld(w, { open: true, entries: [] })));
  failsWith(report, "SITE-PROP-CHANGE");
  failsWith(report, "WHATIF-UNEXPECTED-CHANGE");
});

test("E: the entries approve the default action and nothing else of the site", () => {
  const entries = realEntries("studio-web-e-ingress-public");
  // another site property that would change in the same deployment
  failsWith(run(mutate((w) => {
    ingressWorld(w, { open: true, entries });
    w.live.apps[SITE].config.alwaysOn = false;
  })), "SITE-PROP-CHANGE");
  // the what-if reports a second delta on the site: an access rule, or any other property
  for (const path of ["properties.siteConfig.ipSecurityRestrictions[0]", "properties.siteConfig.alwaysOn", "properties.publicNetworkAccess"]) {
    failsWith(run(mutate((w) => {
      ingressWorld(w, { open: true, entries });
      w.whatif.changes.find((c) => c.name === SITE && c.type === "Microsoft.Web/sites").deltas.push({ path, op: "Modify", before: "a", after: "b" });
    })), "WHATIF-UNEXPECTED-CHANGE");
  }
  // an entry names one resource: the same change on another site is not approved
  failsWith(run(mutate((w) => {
    ingressWorld(w, { open: true, entries: entries.map((entry) => ({ ...entry, resource: "app-other" })) });
  })), "SITE-PROP-CHANGE");
});
