// Removes the @secure() decorator from every .bicep file under a directory (in place). Used ONLY on the throw-away
// evaluation copy that preflight.sh makes: without the decorator the placeholders flow through union()/if() so the whole
// app-settings bag can be evaluated offline. The copy is never deployed. (Portable replacement for GNU `sed -i`.)
//   node strip-secure.mjs <directory>
import { readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";

const root = process.argv[2];
if (!root) {
  console.error("usage: strip-secure.mjs <directory>");
  process.exit(2);
}
let changed = 0;
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (name.endsWith(".bicep")) {
      const before = readFileSync(p, "utf8");
      const after = before.replace(/@secure\(\)/g, "");
      if (after !== before) {
        writeFileSync(p, after);
        changed++;
      }
    }
  }
};
walk(root);
console.log(`strip-secure: ${changed} file(s) changed`);
