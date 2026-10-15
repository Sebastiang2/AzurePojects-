#!/usr/bin/env node
// Writes <work>/context.json: the facts about a gate run that the analysis engine verifies (which files, which hashes, which
// steps ran and how they ended). preflight.sh supplies the facts it observed; this script adds what it can compute itself.
//
//   node context.mjs --repo-root <dir> --manifest <file> --deployment <key> --work <dir> --steps compile=0,lint=0,...
//        --subscription <id> --tenant <id> --resource-group <name> --resource-group-exists true|false
//        --live-collected-at <iso> [--allow-dirty]
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join, resolve, relative, posix } from "node:path";
import { execFileSync } from "node:child_process";
import { sha256 } from "./lib/util.mjs";

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) continue;
    const next = argv[i + 1];
    out[argv[i].slice(2)] = next === undefined || next.startsWith("--") ? true : (i++, next);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const root = resolve(args["repo-root"]);
const manifestPath = resolve(args.manifest);
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const deployment = manifest.deployments?.[args.deployment];
if (!deployment) {
  console.error(`context: deployment ${args.deployment} is not in the manifest`);
  process.exit(2);
}

const hashFile = (rel) => {
  const p = join(root, rel);
  return existsSync(p) ? sha256(readFileSync(p)) : null;
};
const git = (...a) => {
  try {
    return execFileSync("git", ["-C", root, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
};

const templatePath = deployment.template;
const parametersPath = deployment.parameters;
const parameterSource = existsSync(join(root, parametersPath)) ? readFileSync(join(root, parametersPath), "utf8") : "";
const using = /^\s*using\s+'([^']+)'/m.exec(parameterSource)?.[1] ?? null;
const resolvedUsing = using ? relative(root, resolve(root, posix.dirname(parametersPath), using)).replace(/\\/g, "/") : null;

const envReads = [...parameterSource.matchAll(/readEnvironmentVariable\(\s*'([^']+)'/g)].map((m) => m[1]);

const modules = {};
const modulesDir = join(root, "Infrastructure", "modules");
if (existsSync(modulesDir)) {
  for (const f of readdirSync(modulesDir).filter((n) => n.endsWith(".bicep")).sort()) modules[`Infrastructure/modules/${f}`] = sha256(readFileSync(join(modulesDir, f)));
}
const gateScripts = {};
for (const dir of ["Infrastructure/scripts/gate", "Infrastructure/scripts/gate/lib"]) {
  const abs = join(root, dir);
  if (!existsSync(abs)) continue;
  for (const f of readdirSync(abs).filter((n) => /\.(mjs|sh)$/.test(n)).sort()) gateScripts[`${dir}/${f}`] = sha256(readFileSync(join(abs, f)));
}

const steps = {};
for (const pair of String(args.steps ?? "").split(",").filter(Boolean)) {
  const [name, rc] = pair.split("=");
  steps[name] = Number(rc);
}

const callsFile = join(resolve(args.work), "live", "calls.json");
const liveCalls = existsSync(callsFile) ? JSON.parse(readFileSync(callsFile, "utf8")) : [];

const dirty = (git("status", "--porcelain") ?? "x") !== "";
const context = {
  schema: "gate-context/1",
  deployment: args.deployment,
  mode: "Incremental",
  startedAt: new Date().toISOString(),
  account: { subscriptionId: args.subscription, tenantId: args.tenant },
  target: { resourceGroup: args["resource-group"], resourceGroupExists: args["resource-group-exists"] === "true" },
  files: {
    template: { path: templatePath, sha256: hashFile(templatePath) },
    parameters: { path: parametersPath, sha256: hashFile(parametersPath), using, resolvedUsing },
    modules,
    bicepconfig: hashFile("Infrastructure/bicepconfig.json"),
    manifest: sha256(readFileSync(manifestPath)),
    gate: gateScripts,
  },
  envReads,
  git: {
    commit: git("rev-parse", "HEAD"),
    branch: git("rev-parse", "--abbrev-ref", "HEAD"),
    dirty,
    requireClean: args["allow-dirty"] === true ? false : true,
  },
  steps,
  secureEnvironment: { mode: args["secure-mode"] ?? "placeholders", names: deployment.secureEnvironment ?? [] },
  liveCollectedAt: args["live-collected-at"] ?? null,
  liveCalls,
};
// The template path the parameter file points at must be the template that is deployed.
context.files.template.resolvedUsing = templatePath;

writeFileSync(join(resolve(args.work), "context.json"), JSON.stringify(context, null, 2));
console.log(`context written (${Object.keys(modules).length} modules, ${envReads.length} environment read(s), git ${context.git.commit?.slice(0, 8) ?? "n/a"}${dirty ? " dirty" : ""})`);
