#!/usr/bin/env node
// Which apps deploy.sh checks for state Running after a deployment.
//
//   node apps-to-verify.mjs <manifest.json> <deployment key> <existing site name>... | *
//
// Every app in the manifest, with one exception: an app that is introduced by another deployment (apps.<name>.introducedBy) and does not
// exist yet is not required to run, so an unrelated deployment (a hotfix to main) is not blocked between the merge that adds the app to
// the manifest and the deployment that creates it. The introducing deployment itself must find its app Running. "*" as the list of
// existing sites means the list could not be read: nothing is excused (fail-closed).
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
