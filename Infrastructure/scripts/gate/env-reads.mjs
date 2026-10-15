// Prints the names of the environment variables a Bicep parameter file reads (readEnvironmentVariable('NAME', ...)), one per
// line. preflight.sh overrides every one of them with a placeholder, so a variable the manifest does not know about can never
// reach the evaluation with its real value.
//   node env-reads.mjs <parameter file>
import { readFileSync } from "node:fs";
import { environmentReads } from "./lib/util.mjs";

const file = process.argv[2];
if (!file) {
  console.error("usage: env-reads.mjs <parameter file>");
  process.exit(2);
}
for (const name of environmentReads(readFileSync(file, "utf8"))) console.log(name);
