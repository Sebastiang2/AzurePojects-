#!/usr/bin/env node
// Read-only pre/post activation guard. A package upload or App Service "Running" state is not runtime readiness.
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

const origin = "https://app-invi-data-api-prod-001.azurewebsites.net/v1/extras";

export async function verifyReady({ revision, liveness = false, attempts = 30, consecutive = 3, timeoutMs = 10000, pauseMs = 3000,
  fetcher = globalThis.fetch, sleeper = sleep, log = console.log }) {
  if (!liveness && !/^[0-9a-f]{40}$/i.test(revision)) throw new Error("expected backend revision must be a full SHA");
  let successes = 0;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let outcome = "request failed";
    try {
      const url = `${origin}/${liveness ? "is-up" : "ready"}?readiness_probe=${randomUUID()}`;
      const response = await fetcher(url, {
        redirect: "manual",
        cache: "no-store",
        headers: { "Cache-Control": "no-cache", Pragma: "no-cache" },
        signal: AbortSignal.timeout(timeoutMs),
      });
      const revisionMatches = liveness || response.headers.get("x-invi-revision") === revision;
      if (response.status === 200 && revisionMatches) {
        successes++;
        outcome = `HTTP 200${liveness ? "" : ", expected revision"}, streak ${successes}/${consecutive}`;
      } else {
        successes = 0;
        outcome = `HTTP ${response.status}${liveness ? "" : `, ${revisionMatches ? "expected revision" : "revision mismatch"}`}`;
      }
      await response.body?.cancel();
    } catch {
      successes = 0;
    }
    log(`readiness ${attempt}/${attempts}: ${outcome}`);
    if (successes >= consecutive) return true;
    if (attempt < attempts) await sleeper(pauseMs);
  }
  return false;
}

if (process.argv[1]?.endsWith("verify-data-api-ready.mjs")) {
  const revision = process.argv[2] ?? "";
  const liveness = revision === "--liveness";
  const attempts = Number(process.argv[3] ?? 30);
  const consecutive = Number(process.argv[4] ?? 3);
  if ((!liveness && !/^[0-9a-f]{40}$/i.test(revision)) || !Number.isInteger(attempts) || attempts < 1 || !Number.isInteger(consecutive) || consecutive < 1 || consecutive > attempts) {
    console.error("usage: verify-data-api-ready.mjs <full-SHA|--liveness> [attempts] [consecutive]");
    process.exit(2);
  }
  const passed = await verifyReady({ revision, liveness, attempts, consecutive });
  if (!passed) console.error(liveness ? "Data API did not recover at /v1/extras/is-up" : "Data API did not return consecutive readiness 200 responses at the expected revision");
  process.exit(passed ? 0 : 1);
}
