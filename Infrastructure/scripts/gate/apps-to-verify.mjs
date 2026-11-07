#!/usr/bin/env node
// Select the manifest apps that deploy.sh must verify after a deployment. A newly declared app does not block an
// unrelated production deployment before its introducing deployment has created it. Failure to list live sites is
// represented by "*" and verifies every app, so collection errors fail closed.
import { readFileSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function appsToVerify(manifest, deploymentKey, existingSites) {
  const unknown = existingSites.includes("*");
  const existing = new Set(existingSites.map((name) => name.toLowerCase()));
  return Object.entries(manifest.apps ?? {})
    .filter(([name, app]) => unknown || !app.introducedBy || app.introducedBy === deploymentKey || existing.has(name.toLowerCase()))
    .map(([name]) => name);
}

// Real paths on both sides: where the script is reached through a symlink (macOS: /var -> /private/var), import.meta.url is the resolved path and
// process.argv[1] is not, and the script would silently do nothing (a post-deployment check that verifies no app at all).
function runAsScript() {
  try { return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; }
}
if (runAsScript()) {
  const [manifestPath, deploymentKey, ...existing] = process.argv.slice(2);
  if (!manifestPath || !deploymentKey) {
    console.error("usage: apps-to-verify.mjs <manifest.json> <deployment key> <existing site name>... | *");
    process.exit(2);
  }
  console.log(appsToVerify(JSON.parse(readFileSync(manifestPath, "utf8")), deploymentKey, existing).join(" "));
}
