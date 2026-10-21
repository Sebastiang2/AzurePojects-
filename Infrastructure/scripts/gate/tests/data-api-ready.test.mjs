import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { verifyReady } from "../../verify-data-api-ready.mjs";

const revision = "cd4a49fe183a1714a0bd9f76ed2d53a73d082066";
const response = (status, sha = revision) => ({
  status,
  headers: new Headers({ "x-invi-revision": sha }),
  body: { cancel: async () => {} },
});

const scenario = async (steps, attempts = steps.length, liveness = false) => {
  const calls = [];
  const messages = [];
  let i = 0;
  const passed = await verifyReady({
    revision, liveness, attempts, consecutive: 3, pauseMs: 0,
    fetcher: async (url, options) => {
      calls.push({ url, options });
      const next = steps[i++];
      if (next instanceof Error) throw next;
      return next;
    },
    sleeper: async () => {},
    log: (message) => messages.push(message),
  });
  return { passed, calls, messages };
};

test("three consecutive 200 responses at the approved revision pass without cache reuse", async () => {
  const result = await scenario([response(200), response(200), response(200)]);
  assert.equal(result.passed, true);
  assert.equal(new Set(result.calls.map((call) => call.url)).size, 3);
  assert.ok(result.calls.every((call) => call.url.startsWith("https://api.cetchapp.com/v1/extras/ready?")));
  assert.ok(result.calls.every((call) => call.options.cache === "no-store" && call.options.redirect === "manual"));
});

test("direct-origin readiness remains an explicit pre-lock diagnostic", async () => {
  const urls = [];
  const passed = await verifyReady({ revision, origin: "https://app-invi-data-api-prod-001.azurewebsites.net/v1/extras",
    attempts: 3, consecutive: 3, pauseMs: 0, fetcher: async (url) => { urls.push(url); return response(200); },
    sleeper: async () => {}, log: () => {} });
  assert.equal(passed, true);
  assert.ok(urls.every((url) => url.startsWith("https://app-invi-data-api-prod-001.azurewebsites.net/v1/extras/ready?")));
});

test("initial 502, timeout and delayed recovery require a fresh three-response streak", async () => {
  const result = await scenario([response(502), new Error("timeout"), response(200), response(200), response(200)]);
  assert.equal(result.passed, true);
  assert.equal(result.calls.length, 5);
});

test("an endpoint that never becomes healthy fails after bounded attempts", async () => {
  const result = await scenario([response(502), new Error("timeout"), response(502), response(502)]);
  assert.equal(result.passed, false);
  assert.equal(result.calls.length, 4);
});

test("a stale or wrong revision resets the streak", async () => {
  const wrong = "528dcfc6add775e5a2d48b9c72ceb2bf880aca75";
  const result = await scenario([response(200), response(200, wrong), response(200), response(200)]);
  assert.equal(result.passed, false);
  assert.ok(result.messages.some((message) => message.includes("revision mismatch")));
  assert.ok(result.messages.every((message) => !message.includes(wrong)));
});

test("a short revision is rejected before any request", async () => {
  await assert.rejects(verifyReady({ revision: "cd4a49fe", fetcher: async () => response(200) }), /full SHA/);
});

test("rollback liveness can recover without /ready or a revision header", async () => {
  const result = await scenario([response(502, ""), response(200, ""), response(200, ""), response(200, "")], 4, true);
  assert.equal(result.passed, true);
  assert.ok(result.calls.every((call) => call.url.includes("/v1/extras/is-up?")));
});

test("scoped origin deployment checks canonical flag parity and public readiness before and after", () => {
  const script = readFileSync(new URL("../../deploy.sh", import.meta.url), "utf8");
  assert.match(script, /dedicated and canonical production origin-lock parameters must match explicitly/);
  assert.match(script, /Verifying public Data API readiness and the approved revision before changing origin access/);
  assert.match(script, /Verifying public Data API readiness after the scoped origin access change/);
  assert.doesNotMatch(script, /verify-data-api-ready\.mjs"[^\n]*--direct/);
});

test("deploy.sh checks the pinned revision both before and after its single deployment call", () => {
  const script = readFileSync(new URL("../../deploy.sh", import.meta.url), "utf8");
  const manifest = JSON.parse(readFileSync(new URL("../../../safety/manifest.json", import.meta.url), "utf8"));
  assert.equal(manifest.deployments["data-api-warmup"].requiredBackendRevision, revision);
  const first = script.indexOf('node "$HERE/verify-data-api-ready.mjs" "$REQUIRED_BACKEND_REVISION" 3 3');
  const secrets = script.indexOf('bash "$HERE/verify-secure-parameters.sh" --deployment "$DEPLOYMENT"');
  const deploy = script.indexOf('"${DEPLOY_CMD[@]}"');
  const last = script.indexOf('node "$HERE/verify-data-api-ready.mjs" "$REQUIRED_BACKEND_REVISION" 30 3');
  assert.ok(secrets >= 0 && secrets < first && first < deploy && deploy < last);
  assert.match(script, /if \[ "\$WARMUP_MODE" = "true" \]; then[\s\S]*?verify-data-api-ready\.mjs" "\$REQUIRED_BACKEND_REVISION" 3 3/);
  assert.match(script, /elif \[ "\$WARMUP_MODE" = "false" \]; then[\s\S]*?verify-data-api-ready\.mjs" --liveness 30 3/);
  assert.match(script, /read\(process\.argv\[2\]\) !== dedicated/);
});
