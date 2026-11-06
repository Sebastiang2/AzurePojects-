// The SSL state of a bound hostname as production reports it, and what the gate may conclude from it.
//
// Found on 2026-11-06, after studio-web-c-domain: ARM leaves `sslState` out of a hostNameBindings resource that has no certificate bound (the same on
// api-version 2022-09-01, 2023-12-01 and 2024-04-01), while the site's own `hostNameSslStates` reports `sslState: Disabled` for the host. The earlier
// fixtures gave the live binding `sslState: "Disabled"`, a value production never returns, so the gate passed its tests and then failed on the real
// state: the post-deploy gate of C reported `sslState undefined -> Disabled` and the pre-deploy gate of D could not match `before: Disabled`.
//
// These worlds are shaped like production: the binding WITHOUT sslState, the state in `show.hostNameSslStates`. The manifest entries under test are the
// REAL ones, with the names of the synthetic world substituted. Nothing here may turn "not reported" into "Disabled": unknown evidence, contradicting
// evidence, another value, another host, an unknown thumbprint and a public ingress must all still be refused.
// Run: node --test Infrastructure/scripts/gate/tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { baseWorld, run, copy, ids } from "./fixtures.mjs";
import { liveBindingSslState } from "../lib/checks-sites.mjs";

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
const CERT_REFERENCE = `[reference('/subscriptions/x/resourceGroups/rg-test/providers/Microsoft.Web/certificates/${CERT}', '2024-11-01').thumbprint]`;

const realEntries = (key) =>
  JSON.parse(
    JSON.stringify(manifest.deployments[key].allowedChanges)
      .replaceAll("app-invi-studio-prod-001/studio.invi.lol", BINDING)
      .replaceAll("app-invi-studio-prod-001", SITE),
  );

/** What `az webapp show` reports for the site's host names (production, 2026-11-06: all three Disabled, thumbprint null). */
const sslStates = (hosts) => hosts.map(([name, sslState, thumbprint = null]) => ({ name, hostType: "Standard", sslState, thumbprint, toUpdate: null }));
const DEFAULT_HOSTS = (state = "Disabled") => [[`${SITE}.azurewebsites.net`, "Disabled"], [`${SITE}.scm.azurewebsites.net`, "Disabled"], [HOST, state]];

/**
 * A bound hostname, as production shows it. `own` is the sslState inside the hostNameBindings resource (production: absent), `listed` is the site's
 * hostNameSslStates (production: Disabled for the host), `desired` is what the template sets.
 */
function bindingWorld(w, { own, listed = DEFAULT_HOSTS(), desired = "Disabled", entries = [], thumbprint, extraWhatIf = [] } = {}) {
  const properties = { siteName: SITE, hostNameType: "Verified", customHostNameDnsRecordType: "CName", sslState: desired };
  if (thumbprint !== undefined) properties.thumbprint = thumbprint;
  w.desiredResources.push({ type: "Microsoft.Web/sites/hostNameBindings", name: BINDING, properties });
  const liveProperties = { siteName: SITE, hostNameType: "Verified", customHostNameDnsRecordType: "CName", domainId: null };
  if (own !== undefined) liveProperties.sslState = own;
  w.live.apps[SITE].hostnamebindings = { value: [{ name: BINDING, properties: liveProperties }] };
  w.live.apps[SITE].show.hostNameSslStates = sslStates(listed);
  // what-if of a binding whose live state ARM leaves out: the template's value shows as a Create on the property. A binding that does report its
  // state has no such delta (the value is compared and equal), so the delta exists only when `own` is absent.
  const deltas = own === undefined ? [{ path: "properties.sslState", op: "Create", after: desired }] : [];
  w.whatif.changes.push({ resourceId: "b", type: "Microsoft.Web/sites/hostNameBindings", name: BINDING, changeType: "Modify", deltas }, ...extraWhatIf);
  const deployment = w.manifest.deployments.main;
  deployment.touches = [{ type: "Microsoft.Web/sites/hostNameBindings", name: BINDING }];
  deployment.allowedChanges = entries;
}

// ---- the evidence reader ---------------------------------------------------------------------------------------------------------
test("liveBindingSslState: the binding's own value wins, the site's list is the fallback, and silence or disagreement is never a state", () => {
  const app = (own, listed) => ({
    hostnamebindings: { value: [{ name: BINDING, properties: own === undefined ? {} : { sslState: own } }] },
    show: { hostNameSslStates: listed === undefined ? [] : [{ name: HOST.toUpperCase(), sslState: listed }] },
  });
  assert.deepEqual(liveBindingSslState(app("SniEnabled", undefined), HOST), { state: "SniEnabled", source: "the binding" });
  assert.deepEqual(liveBindingSslState(app(undefined, "Disabled"), HOST), { state: "Disabled", source: "the site's hostNameSslStates" });
  assert.deepEqual(liveBindingSslState(app("Disabled", "disabled"), HOST), { state: "Disabled", source: "the binding" }, "case is not a disagreement");
  assert.deepEqual(liveBindingSslState(app(undefined, undefined), HOST), { state: undefined }, "silent evidence is not Disabled");
  assert.deepEqual(liveBindingSslState(app("SniEnabled", "Disabled"), HOST), { state: undefined, conflict: { binding: "SniEnabled", site: "Disabled" } });
  assert.deepEqual(liveBindingSslState(undefined, HOST), { state: undefined });
  assert.deepEqual(liveBindingSslState({ show: { hostNameSslStates: [{ name: "other.test", sslState: "Disabled" }] } }, HOST), { state: undefined }, "another host's state says nothing about this one");
});

// ---- C, after it was deployed: the post-deploy gate on production's real shape -------------------------------------------------------
test("C after deployment, as production reports it (binding without sslState, site says Disabled): no change, gate passes", () => {
  const report = run(mutate((w) => bindingWorld(w, { entries: realEntries("studio-web-c-domain") })));
  assert.equal(report.verdict, "PASS", JSON.stringify(report.findings.filter((f) => f.severity === "fail")));
  assert.ok(!ids(report).includes("BINDING-SSL-CHANGE"));
  assert.ok(ids(report, "allowed").includes("WHATIF-BINDING-SSL-OMITTED"), "the omission is reported as allowed, visibly, not as silent noise");
});

test("C: a binding that does report sslState (the older fixture shape) still passes", () => {
  const report = run(mutate((w) => bindingWorld(w, { own: "Disabled", entries: realEntries("studio-web-c-domain") })));
  assert.equal(report.verdict, "PASS", JSON.stringify(ids(report)));
});

test("C: when neither the binding nor hostNameSslStates reports the state, it is NOT taken as Disabled", () => {
  const report = run(mutate((w) => bindingWorld(w, { listed: [], entries: realEntries("studio-web-c-domain") })));
  failsWith(report, "BINDING-SSL-CHANGE");
  failsWith(report, "WHATIF-UNEXPECTED-CHANGE");
  assert.match(report.findings.find((f) => f.id === "BINDING-SSL-CHANGE").message, /unknown/);
});

test("C: the Disabled of another host name is no evidence for this one", () => {
  const listed = [[`${SITE}.azurewebsites.net`, "Disabled"], ["other.test", "Disabled"]];
  const report = run(mutate((w) => bindingWorld(w, { listed })));
  failsWith(report, "BINDING-SSL-CHANGE");
  failsWith(report, "WHATIF-UNEXPECTED-CHANGE");
});

test("C: contradicting evidence (binding says SniEnabled, the site says Disabled) is refused, whatever the template wants", () => {
  for (const desired of ["Disabled", "SniEnabled"]) {
    const report = run(mutate((w) => bindingWorld(w, { own: "SniEnabled", desired })));
    failsWith(report, "BINDING-SSL-EVIDENCE");
  }
});

test("C: an unexpected SSL change is refused (template wants SniEnabled while live is Disabled and no entry approves it)", () => {
  const report = run(mutate((w) => bindingWorld(w, { desired: "SniEnabled", entries: realEntries("studio-web-c-domain") })));
  failsWith(report, "BINDING-SSL-CHANGE");
  failsWith(report, "WHATIF-UNEXPECTED-CHANGE");
  assert.ok(!ids(report, "allowed").includes("WHATIF-BINDING-SSL-OMITTED"), "the omission rule only covers a value equal to what the site reports");
});

test("C: turning SNI off on a hostname that has it (a downgrade) is refused", () => {
  const listed = DEFAULT_HOSTS("SniEnabled");
  const report = run(mutate((w) => bindingWorld(w, { listed, desired: "Disabled", entries: realEntries("studio-web-c-domain") })));
  failsWith(report, "BINDING-SSL-CHANGE");
  failsWith(report, "WHATIF-UNEXPECTED-CHANGE");
});

// ---- D: before it is deployed -----------------------------------------------------------------------------------------------------
const certificateChanges = [{ resourceId: "c", type: "Microsoft.Web/certificates", name: CERT, changeType: "Create" }];
const tlsWorld = (w, options = {}) => {
  w.desiredResources.push({ type: "Microsoft.Web/certificates", name: CERT, properties: { canonicalName: HOST, serverFarmId: "/subscriptions/x/resourceGroups/rg-test/providers/Microsoft.Web/serverfarms/asp-test" } });
  w.whatif.changes.push(...certificateChanges);
  bindingWorld(w, { desired: "SniEnabled", thumbprint: CERT_REFERENCE, entries: realEntries("studio-web-d-domain-tls"), ...options });
  const deployment = w.manifest.deployments.main;
  deployment.allowedCreates = [{ type: "Microsoft.Web/certificates", name: CERT, why: "managed certificate" }];
  deployment.touches.push({ type: "Microsoft.Web/certificates", name: CERT });
  // the thumbprint of the new certificate shows as a Create on the binding
  w.whatif.changes.find((c) => c.name === BINDING).deltas.push({ path: "properties.thumbprint", op: "Create", after: "<certificate thumbprint>" });
};

test("D on production's real shape (binding without sslState, site says Disabled): the manifest's `before: Disabled` is met and the gate passes", () => {
  const report = run(mutate((w) => tlsWorld(w)));
  assert.equal(report.verdict, "PASS", JSON.stringify(report.findings.filter((f) => f.severity === "fail")));
  assert.ok(ids(report, "allowed").includes("BINDING-SSL-CHANGE"));
  assert.match(report.findings.find((f) => f.id === "BINDING-SSL-CHANGE").message, /Disabled -> SniEnabled/);
  assert.ok(ids(report, "allowed").includes("WHATIF-CHANGE"));
});

test("D: with unknown live evidence the approved `before: Disabled` does not match, and nothing is assumed", () => {
  const report = run(mutate((w) => tlsWorld(w, { listed: [] })));
  failsWith(report, "BINDING-SSL-CHANGE");
});

test("D: an approval for another binding, or without the exact transition, approves nothing", () => {
  const other = realEntries("studio-web-d-domain-tls").map((entry) => ({ ...entry, resource: entry.resource.replace(HOST, "other.test") }));
  failsWith(run(mutate((w) => tlsWorld(w, { entries: other }))), "BINDING-SSL-CHANGE");
  failsWith(run(mutate((w) => tlsWorld(w, { listed: DEFAULT_HOSTS("SniEnabled"), desired: "Disabled", thumbprint: undefined }))), "BINDING-SSL-CHANGE");
  failsWith(run(mutate((w) => tlsWorld(w, { entries: [] }))), "BINDING-SSL-CHANGE");
});

test("D: a second hostname in the same deployment is refused (the approval names one binding)", () => {
  const report = run(mutate((w) => {
    tlsWorld(w);
    w.desiredResources.push({
      type: "Microsoft.Web/sites/hostNameBindings",
      name: `${SITE}/other.test`,
      properties: { siteName: SITE, hostNameType: "Verified", customHostNameDnsRecordType: "CName", sslState: "SniEnabled" },
    });
    w.live.apps[SITE].hostnamebindings.value.push({ name: `${SITE}/other.test`, properties: { hostNameType: "Verified" } });
    w.live.apps[SITE].show.hostNameSslStates.push(...sslStates([["other.test", "Disabled"]]));
    w.whatif.changes.push({ resourceId: "o", type: "Microsoft.Web/sites/hostNameBindings", name: `${SITE}/other.test`, changeType: "Modify", deltas: [{ path: "properties.sslState", op: "Create", after: "SniEnabled" }] });
  }));
  failsWith(report, "BINDING-SSL-CHANGE");
  failsWith(report, "WHATIF-RESOURCE-NOT-APPROVED");
  failsWith(report, "WHATIF-UNEXPECTED-CHANGE");
});

test("a thumbprint nobody approved is refused: a literal one on an unbound hostname, and a certificate that exists nowhere", () => {
  const literal = run(mutate((w) => bindingWorld(w, { desired: "SniEnabled", thumbprint: "0123456789ABCDEF0123456789ABCDEF01234567", entries: realEntries("studio-web-d-domain-tls") })));
  failsWith(literal, "BINDING-THUMBPRINT-CHANGE");
  const unknownCert = "[reference('/subscriptions/x/resourceGroups/rg-test/providers/Microsoft.Web/certificates/not-this-one-0', '2024-11-01').thumbprint]";
  failsWith(run(mutate((w) => bindingWorld(w, { desired: "SniEnabled", thumbprint: unknownCert, entries: realEntries("studio-web-d-domain-tls") }))), "BINDING-CERT-MISSING");
});

test("a public ingress change cannot ride along with C or D: the site is not an approved resource, and its default action stays Deny", () => {
  const opening = {
    resourceId: "s",
    type: "Microsoft.Web/sites",
    name: SITE,
    changeType: "Modify",
    deltas: [{ path: "properties.siteConfig.ipSecurityRestrictionsDefaultAction", op: "Modify", before: "Deny", after: "Allow" }],
  };
  for (const build of [(w) => bindingWorld(w, { entries: realEntries("studio-web-c-domain"), extraWhatIf: [opening] }), (w) => tlsWorld(w, { extraWhatIf: [opening] })]) {
    const report = run(mutate((w) => { w.live.apps[SITE].config.ipSecurityRestrictionsDefaultAction = "Deny"; build(w); }));
    failsWith(report, "WHATIF-RESOURCE-NOT-APPROVED");
    assert.notEqual(report.verdict, "PASS");
  }
});

// ---- the real manifest -------------------------------------------------------------------------------------------------------------
test("the real C entry approves no change at all, and the real D entries still name the exact Disabled to SniEnabled transition of one binding", () => {
  assert.deepEqual(manifest.deployments["studio-web-c-domain"].allowedChanges, []);
  const sslEntries = manifest.deployments["studio-web-d-domain-tls"].allowedChanges.filter((e) => e.property === "sslState");
  assert.equal(sslEntries.length, 1);
  assert.deepEqual([sslEntries[0].resource, sslEntries[0].before, sslEntries[0].after], ["app-invi-studio-prod-001/studio.invi.lol", "Disabled", "SniEnabled"]);
});
