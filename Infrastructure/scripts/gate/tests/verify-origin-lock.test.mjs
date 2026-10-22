import assert from "node:assert/strict";
import test from "node:test";
import { hosts, verifyOriginLock } from "../../verify-origin-lock.mjs";

const run = async (mode, answer, attempts = 3) => {
  const calls = [];
  const passed = await verifyOriginLock({
    mode, attempts, consecutive: 3, pauseMs: 0, sleeper: async () => {}, log: () => {},
    fetcher: async (url, options) => {
      calls.push({ url, options });
      const key = url.startsWith(hosts.scm) ? "scm" : url.startsWith("https://api.cetchapp.com/") ? "public" : "direct";
      const result = answer(key, calls.length);
      if (result === "error") throw new Error("network");
      return { status: result, body: { cancel: async () => {} } };
    },
  });
  return { passed, calls };
};

test("locked: public 200, direct 403 and reachable SCM pass", async () => {
  const { passed, calls } = await run("locked", (k) => ({ public: 200, direct: 403, scm: 401 })[k]);
  assert.equal(passed, true);
  assert.ok(calls.every((c) => c.options.method === undefined && c.options.redirect === "manual" && c.options.cache === "no-store"));
});

test("locked: a direct host that still answers 200 fails", async () => {
  assert.equal((await run("locked", (k) => ({ public: 200, direct: 200, scm: 401 })[k])).passed, false);
});

test("locked: direct 'denied' by a timeout or error is not proof of an IP denial", async () => {
  assert.equal((await run("locked", (k) => ({ public: 200, direct: "error", scm: 401 })[k])).passed, false);
  assert.equal((await run("locked", (k) => ({ public: 200, direct: 502, scm: 401 })[k])).passed, false);
});

test("locked: public outage fails even if the direct host is refused", async () => {
  assert.equal((await run("locked", (k) => ({ public: 502, direct: 403, scm: 401 })[k])).passed, false);
});

test("locked: SCM must not inherit the lock or be down", async () => {
  assert.equal((await run("locked", (k) => ({ public: 200, direct: 403, scm: 403 })[k])).passed, false);
  assert.equal((await run("locked", (k) => ({ public: 200, direct: 403, scm: "error" })[k])).passed, false);
  assert.equal((await run("locked", (k) => ({ public: 200, direct: 403, scm: 200 })[k])).passed, true);
});

test("a single bad round resets the streak", async () => {
  let directCalls = 0;
  const answer = (k) => (k === "direct" && ++directCalls === 2 ? 200 : ({ public: 200, direct: 403, scm: 401 })[k]);
  assert.equal((await run("locked", answer, 3)).passed, false);
  directCalls = 0;
  assert.equal((await run("locked", answer, 5)).passed, true);
});

test("baseline: the pre-lock diagnostic needs the direct host to answer 200", async () => {
  assert.equal((await run("baseline", (k) => ({ public: 200, direct: 200, scm: 401 })[k])).passed, true);
  assert.equal((await run("baseline", (k) => ({ public: 200, direct: 403, scm: 401 })[k])).passed, false);
});

test("an unknown mode is rejected", async () => {
  await assert.rejects(verifyOriginLock({ mode: "off", fetcher: async () => ({ status: 200 }) }), /baseline or locked/);
});
