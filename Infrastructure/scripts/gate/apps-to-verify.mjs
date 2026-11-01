#!/usr/bin/env node
// Select the manifest apps that deploy.sh must verify after a deployment. A newly declared app does not block an
// unrelated production deployment before its introducing deployment has created it. Failure to list live sites is
// represented by "*" and verifies every app, so collection errors fail closed.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function appsToVerify(manifest, deploymentKey, existingSites) {
  const unknown = existingSites.includes("*");
  const existing = new Set(existingSites.map((name) => name.toLowerCase()));
  return Object.entries(manifest.apps ?? {})
    .filter(([name, app]) => unknown || !app.introducedBy || app.introducedBy === deploymentKey || existing.has(name.toLowerCase()))
    .map(([name]) => name);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [manifestPath, deploymentKey, ...existing] = process.argv.slice(2);
  if (!manifestPath || !deploymentKey) {
    console.error("usage: apps-to-verify.mjs <manifest.json> <deployment key> <existing site name>... | *");
    process.exit(2);
  }
  console.log(appsToVerify(JSON.parse(readFileSync(manifestPath, "utf8")), deploymentKey, existing).join(" "));
}
