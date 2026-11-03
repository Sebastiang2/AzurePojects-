// The TLS deployment of Studio web (studio-web-d-domain-tls) as the gate judges it: the SNI switch of a bound hostname. Synthetic worlds from
// fixtures.mjs, no Azure call. The entries under test are the REAL ones from the manifest, with the names of the synthetic world substituted,
// so a manifest entry the gate cannot read is caught here and not at deploy time.
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
const HOST = "studio.test";
const BINDING = `${SITE}/${HOST}`;
const CERT = `${HOST}-${SITE}`;

/** The real allowedChanges of a deployment key, with the production names replaced by the names of the synthetic world. */
const realEntries = (key) =>
  JSON.parse(
    JSON.stringify(manifest.deployments[key].allowedChanges)
      .replaceAll("app-invi-studio-prod-001/studio.invi.lol", BINDING)
      .replaceAll("app-invi-studio-prod-001", SITE),
  );

// ---- the manifest as a whole --------------------------------------------------------------------------------------------------
test("every allowedChanges entry of every deployment in the real manifest has a shape the gate reads", () => {
  for (const [key, deployment] of Object.entries(manifest.deployments)) {
    const report = run(mutate((w) => (w.manifest.deployments.main.allowedChanges = copy(deployment.allowedChanges ?? []))));
    assert.ok(!ids(report).includes("MANIFEST-ENTRY-SHAPE"), `${key}: ${JSON.stringify(ids(report))}`);
  }
});

// ---- D: enabling SNI on a bound hostname -----------------------------------------------------------------------------------------
const tlsWorld = (w, { live = "Disabled", desired = "SniEnabled", entries = realEntries("studio-web-d-domain-tls") } = {}) => {
  w.desiredResources.push(
    { type: "Microsoft.Web/certificates", name: CERT, properties: { canonicalName: HOST, serverFarmId: "/subscriptions/x/resourceGroups/rg-test/providers/Microsoft.Web/serverfarms/asp-test" } },
    {
      type: "Microsoft.Web/sites/hostNameBindings",
      name: BINDING,
      properties: {
        siteName: SITE,
        hostNameType: "Verified",
        customHostNameDnsRecordType: "CName",
        sslState: desired,
        thumbprint: `[reference('/subscriptions/x/resourceGroups/rg-test/providers/Microsoft.Web/certificates/${CERT}', '2024-11-01').thumbprint]`,
      },
    },
  );
  w.live.apps[SITE].hostnamebindings = { value: [{ name: BINDING, properties: { sslState: live, hostNameType: "Verified" } }] };
  w.whatif.changes.push(
    { resourceId: "c", type: "Microsoft.Web/certificates", name: CERT, changeType: "Create" },
    {
      resourceId: "b",
      type: "Microsoft.Web/sites/hostNameBindings",
      name: BINDING,
      changeType: "Modify",
      deltas: [
        { path: "properties.sslState", op: "Modify", before: live, after: desired },
        { path: "properties.thumbprint", op: "Create", after: "<certificate thumbprint>" },
      ],
    },
  );
  const deployment = w.manifest.deployments.main;
  deployment.allowedCreates = [{ type: "Microsoft.Web/certificates", name: CERT, why: "managed certificate" }];
  deployment.touches = [{ type: "Microsoft.Web/certificates", name: CERT }, { type: "Microsoft.Web/sites/hostNameBindings", name: BINDING }];
  deployment.allowedChanges = entries;
};

test("D: the real manifest entries approve the SNI switch of the one binding and the gate passes", () => {
  const report = run(mutate((w) => tlsWorld(w)));
  assert.equal(report.verdict, "PASS", JSON.stringify(ids(report)));
  assert.ok(ids(report, "allowed").includes("BINDING-SSL-CHANGE"));
  assert.ok(ids(report, "allowed").includes("WHATIF-CHANGE"));
});

test("D: without the entries the SNI switch is rejected, offline and in the what-if", () => {
  const report = run(mutate((w) => tlsWorld(w, { entries: [] })));
  failsWith(report, "BINDING-SSL-CHANGE");
  failsWith(report, "WHATIF-UNEXPECTED-CHANGE");
});

test("D: the offline entry alone is not enough, the what-if paths have to be named too", () => {
  const entries = realEntries("studio-web-d-domain-tls").filter((entry) => entry.whatif !== true);
  const report = run(mutate((w) => tlsWorld(w, { entries })));
  failsWith(report, "WHATIF-UNEXPECTED-CHANGE");
  assert.ok(!ids(report).includes("BINDING-SSL-CHANGE"));
});

test("D: an entry for another binding, or for the opposite direction, approves nothing", () => {
  const other = realEntries("studio-web-d-domain-tls").map((entry) => ({ ...entry, resource: entry.resource.replace(HOST, "other.test") }));
  failsWith(run(mutate((w) => tlsWorld(w, { entries: other }))), "BINDING-SSL-CHANGE");
  failsWith(run(mutate((w) => tlsWorld(w, { live: "SniEnabled", desired: "Disabled" }))), "BINDING-SSL-CHANGE");
});
