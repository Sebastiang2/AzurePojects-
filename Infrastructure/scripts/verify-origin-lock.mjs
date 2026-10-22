#!/usr/bin/env node
// Read-only check of the Data API perimeter. Sends only unauthenticated GETs to health/liveness paths.
//   baseline  origin lock OFF (before activation, or after rollback): the direct Azure host still answers.
//   locked    origin lock ON: unauthorised direct public access to the main site is DENIED (403) while the
//             public host serves and Kudu/SCM stays reachable (it is a separate surface and must not inherit the lock).
// Post-lock verification never depends on direct origin access succeeding; the direct host is only probed to see it refused.
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

export const hosts = {
  public: "https://api.cetchapp.com/v1/extras/is-up",
  direct: "https://app-invi-data-api-prod-001.azurewebsites.net/v1/extras/is-up",
  scm: "https://app-invi-data-api-prod-001.scm.azurewebsites.net/",
};

async function status(fetcher, url, timeoutMs) {
  const target = url.includes("?") ? url : `${url}?origin_lock_probe=${randomUUID()}`;
  try {
    const response = await fetcher(target, { redirect: "manual", cache: "no-store", headers: { "Cache-Control": "no-cache" }, signal: AbortSignal.timeout(timeoutMs) });
    await response.body?.cancel();
    return response.status;
  } catch {
    return "error";
  }
}

export async function verifyOriginLock({ mode, attempts = 5, consecutive = 3, timeoutMs = 10000, pauseMs = 3000,
  fetcher = globalThis.fetch, sleeper = sleep, log = console.log }) {
  if (!["baseline", "locked"].includes(mode)) throw new Error("mode must be baseline or locked");
  // SCM: anything that is an HTTP answer except an IP denial (401/302/200/404 are all fine); a network error is not.
  const checks = {
    public: (s) => s === 200,
    direct: (s) => (mode === "locked" ? s === 403 : s === 200),
    scm: (s) => typeof s === "number" && s !== 403 && s < 500,
  };
  let streak = 0;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const [pub, direct, scm] = await Promise.all(["public", "direct", "scm"].map((k) => status(fetcher, hosts[k], timeoutMs)));
    const ok = checks.public(pub) && checks.direct(direct) && checks.scm(scm);
    streak = ok ? streak + 1 : 0;
    log(`origin-lock ${mode} ${attempt}/${attempts}: public=${pub} direct=${direct} scm=${scm}, streak ${streak}/${consecutive}`);
    if (streak >= consecutive) return true;
    if (attempt < attempts) await sleeper(pauseMs);
  }
  return false;
}

if (process.argv[1]?.endsWith("verify-origin-lock.mjs")) {
  const mode = process.argv[2];
  const attempts = Number(process.argv[3] ?? 5);
  const consecutive = Number(process.argv[4] ?? 3);
  if (!["baseline", "locked"].includes(mode) || !Number.isInteger(attempts) || attempts < 1 || !Number.isInteger(consecutive) || consecutive < 1 || consecutive > attempts) {
    console.error("usage: verify-origin-lock.mjs baseline|locked [attempts] [consecutive]");
    process.exit(2);
  }
  const passed = await verifyOriginLock({ mode, attempts, consecutive });
  if (!passed) console.error(`Data API perimeter does not match the expected '${mode}' state`);
  process.exit(passed ? 0 : 1);
}
