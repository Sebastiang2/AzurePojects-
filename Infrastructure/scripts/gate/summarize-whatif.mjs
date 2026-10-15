// Reduces `az deployment group what-if --no-pretty-print -o json` (stdin) to a secret-free change list (stdout JSON).
//
// The raw what-if payload can carry secret values (literal app settings, secure parameters), so this is the first and
// only stage after `az`: it is used in a pipe and its input is never written to disk. What it emits:
//   - per resource: id, type, name, changeType
//   - per changed property: path, operation, and before/after ONLY for scalar values at non-sensitive paths;
//     objects and arrays are reduced to {kind, name?} so an added/removed array element (subnet, rule, binding)
//     is identified by name without its body
//   - for config resources that carry secrets (app settings, connection strings, auth settings, storage mounts ...): the
//     property NAMES only, never a value, whatever the value looks like
// Exit codes: 0 = parsed; 2 = not JSON / not a what-if result.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { looksSecret } from "./lib/secrets.mjs";

const MAX_STRING = 160;

/** Site and slot configuration resources that can hold secrets: always opaque (names only). */
const OPAQUE_CONFIG = /\/config\/(appsettings|connectionstrings|authsettings|authsettingsv2|azurestorageaccounts|metadata|pushsettings|backup|publishingcredentials)$/i;

function scalar(path, value) {
  if (value === null || typeof value === "boolean" || typeof value === "number") return { v: value };
  if (typeof value !== "string") return undefined;
  if (looksSecret(path, value)) return { withheld: true };
  return { v: value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value };
}

function reduce(path, value) {
  if (Array.isArray(value)) {
    return { kind: "array", length: value.length, names: value.map((e) => (e && typeof e === "object" ? e.name ?? e.id ?? null : null)).filter(Boolean).slice(0, 40) };
  }
  if (value && typeof value === "object") {
    const keys = Object.keys(value);
    return { kind: "object", name: value.name ?? value.id ?? undefined, keys: keys.length <= 12 ? keys : undefined };
  }
  const s = scalar(path, value);
  if (s?.withheld) return { withheld: true };
  return s ? s.v : undefined;
}

// Child nodes carry paths relative to their parent (an array element is just its index): rebuild the full path.
function* walk(nodes, parent = "") {
  for (const node of nodes ?? []) {
    const raw = String(node.path ?? "");
    const full = parent === "" ? raw : /^\d+$/.test(raw) ? `${parent}[${raw}]` : `${parent}.${raw}`;
    yield { ...node, path: full };
    if (node.children?.length) yield* walk(node.children, full);
  }
}

function bagNames(resource) {
  const props = resource?.properties;
  if (!props || typeof props !== "object" || Array.isArray(props)) return null;
  return Object.keys(props).sort();
}

export function summarize(parsed) {
  const result = parsed?.properties ?? parsed;
  if (!result || typeof result !== "object" || !("status" in result)) return null;
  const counts = {};
  const changes = [];
  for (const c of result.changes ?? []) {
    counts[c.changeType] = (counts[c.changeType] ?? 0) + 1;
    const id = c.resourceId ?? "";
    const parts = id.split("/providers/");
    const tail = parts[parts.length - 1] ?? id;
    const segs = tail.split("/");
    const type = [segs[0], ...segs.filter((_, i) => i > 0 && i % 2 === 1)].join("/");
    const name = segs.filter((_, i) => i > 0 && i % 2 === 0).join("/");
    const entry = { resourceId: id, type, name, changeType: c.changeType };
    if (c.changeType === "NoChange" || c.changeType === "Ignore") {
      changes.push(entry);
      continue;
    }
    if (OPAQUE_CONFIG.test(id)) {
      entry.bag = { before: bagNames(c.before), after: bagNames(c.after) };
    }
    entry.unsupportedReason = c.unsupportedReason ?? undefined;
    const deltas = [];
    for (const node of walk(c.delta)) {
      if (!node.path) continue;
      const leaf = !node.children || node.children.length === 0;
      if (!leaf && node.propertyChangeType === "Array") continue;
      const d = { path: node.path, op: node.propertyChangeType };
      if (entry.bag) {
        deltas.push(d); // bag content is never itemised
        continue;
      }
      if (node.before !== undefined) d.before = reduce(node.path, node.before);
      if (node.after !== undefined) d.after = reduce(node.path, node.after);
      deltas.push(d);
    }
    entry.deltas = deltas;
    changes.push(entry);
  }
  return {
    schema: "whatif-summary/1",
    status: result.status,
    error: result.error ? { code: result.error.code, message: String(result.error.message ?? "").slice(0, 400) } : null,
    counts,
    changes,
  };
}

// CLI: node summarize-whatif.mjs [outfile]   (stdin = raw what-if JSON; stdout = summary unless outfile is given)
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    console.error("summarize-whatif: stdin was not JSON");
    process.exit(2);
  }
  const out = summarize(parsed);
  if (!out) {
    console.error("summarize-whatif: not a what-if result");
    process.exit(2);
  }
  const text = JSON.stringify(out, null, 2);
  if (process.argv[2]) writeFileSync(process.argv[2], text);
  else process.stdout.write(text);
}
