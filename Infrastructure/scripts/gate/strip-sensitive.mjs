// stdin: any JSON. stdout: the same JSON with every property whose NAME looks sensitive removed (recursively), so a
// read-only listing can be stored without ever holding a key, password or blob. Names only; never touches arrays' order.
import { readFileSync } from "node:fs";

const DROP = /^(machineKey|publishingPassword|publishingUserName|scmUri|password|administratorLoginPassword|pfxBlob|pfxPassword|clientSecret|primaryKey|secondaryKey|keys|apiKey|sasToken|connectionStrings?|decryptionKey|validationKey|repositoryToken|accessToken)$/i;

function clean(value) {
  if (Array.isArray(value)) return value.map(clean);
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (DROP.test(k)) continue;
      out[k] = clean(v);
    }
    return out;
  }
  return value;
}

let parsed;
try {
  parsed = JSON.parse(readFileSync(0, "utf8"));
} catch {
  console.error("strip-sensitive: stdin was not JSON");
  process.exit(2);
}
process.stdout.write(JSON.stringify(clean(parsed), null, 2));
