#!/usr/bin/env node
// Offline before/after comparison of two saved `config/web` GET responses (az rest --method get ...).
// Prints only the PATHS of differing properties, never values. Exit 0 only when every difference is in the allowed set.
//   node compare-web-config.mjs before.json after.json [--allow a,b]   (default: the two main-site perimeter fields)
import { readFileSync } from "node:fs";

export const perimeterFields = ["ipSecurityRestrictions", "ipSecurityRestrictionsDefaultAction"];

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

export function diffPaths(before, after, prefix = "") {
  if (isObject(before) && isObject(after)) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    return [...keys].flatMap((key) => diffPaths(before[key], after[key], prefix ? `${prefix}.${key}` : key));
  }
  return JSON.stringify(before) === JSON.stringify(after) ? [] : [prefix];
}

export function compareWebConfig(before, after, allowed = perimeterFields) {
  const props = (doc) => doc?.properties ?? doc;
  // A property that is missing after a write counts as a difference: an omitted field means it was reset.
  const changed = diffPaths(props(before), props(after));
  return { changed, unexpected: changed.filter((path) => !allowed.includes(path)) };
}

if (process.argv[1]?.endsWith("compare-web-config.mjs")) {
  const [beforeFile, afterFile, flag, list] = process.argv.slice(2);
  if (!beforeFile || !afterFile || (flag && (flag !== "--allow" || !list))) {
    console.error("usage: compare-web-config.mjs before.json after.json [--allow path,path]");
    process.exit(2);
  }
  const { changed, unexpected } = compareWebConfig(
    JSON.parse(readFileSync(beforeFile, "utf8")), JSON.parse(readFileSync(afterFile, "utf8")), list ? list.split(",") : perimeterFields);
  console.log(`changed: ${changed.join(", ") || "(none)"}`);
  if (unexpected.length) {
    console.error(`UNEXPECTED differences: ${unexpected.join(", ")}`);
    process.exit(1);
  }
}
