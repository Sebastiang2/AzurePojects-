// Offline evaluation of a parameter file with its template: what WOULD be sent, without a deployment and without an Azure
// call. The same fallback as `evaluate_snapshot` in Infrastructure/scripts/preflight.sh: some Azure CLI releases have no
// `az bicep snapshot` (2.82, the newest on Homebrew, does not), and the Bicep CLI that az installs (~/.azure/bin/bicep) has
// the same command with the same inputs and writes the same <name>.snapshot.json. Tests that use it skip when neither is
// available (`haveSnapshot`), so a machine without the tooling does not report failures that are not about the templates.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SHELL = process.platform === "win32";
const run = (cmd, args, env) => spawnSync(cmd, args, { shell: SHELL, encoding: "utf8", env: env ? { ...process.env, ...env } : process.env });

/** `az bicep snapshot` when az has the subcommand, otherwise the Bicep CLI binary, otherwise null. */
function snapshotCommand() {
  if (run("az", ["bicep", "version"]).status !== 0) return null;
  if (run("az", ["bicep", "snapshot", "--help"]).status === 0) return { cmd: "az", prefix: ["bicep", "snapshot"], az: true };
  for (const candidate of [join(homedir(), ".azure", "bin", "bicep"), join(homedir(), ".azure", "bin", "bicep.exe"), "bicep"]) {
    if (run(candidate, ["--version"]).status === 0) return { cmd: candidate, prefix: ["snapshot"], az: false };
  }
  return null;
}

const COMMAND = snapshotCommand();
export const haveSnapshot = COMMAND !== null;

/**
 * Evaluates `paramFile` and returns { ok, resources, error }. `resources` is predictedResources of the snapshot: the
 * resources the deployment would send, with every expression resolved.
 */
export function evaluateSnapshot(paramFile, { subscription = "00000000-0000-0000-0000-000000000000", resourceGroup = "rg-test", location = "swedencentral", env } = {}) {
  if (!COMMAND) return { ok: false, error: "neither az bicep snapshot nor the Bicep CLI is available" };
  // The az subcommand takes --file and --only-show-errors; the Bicep CLI takes the file as a positional argument.
  const args = COMMAND.az
    ? [...COMMAND.prefix, "--file", paramFile, "--subscription-id", subscription, "--resource-group", resourceGroup, "--location", location, "--only-show-errors"]
    : [...COMMAND.prefix, paramFile, "--subscription-id", subscription, "--resource-group", resourceGroup, "--location", location];
  const r = run(COMMAND.cmd, args, env);
  if (r.status !== 0) return { ok: false, error: `${r.stdout}${r.stderr}` };
  const out = paramFile.replace(/\.bicepparam$/, ".snapshot.json");
  return { ok: true, resources: JSON.parse(readFileSync(out, "utf8")).predictedResources ?? [] };
}
