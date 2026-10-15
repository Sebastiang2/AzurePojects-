// stdin: any JSON. stdout: the same JSON with every sensitive property removed (recursively), so a read-only listing can be
// stored without ever holding a key, password or blob. Properties are dropped by name (see lib/secrets.mjs): known secret
// containers entirely, and any string/number whose key names a secret, unless the key only names or describes one
// (clientSecretSettingName, keyVaultSecretId, tokenStore.enabled are kept).
import { readFileSync } from "node:fs";
import { SENSITIVE_KEY, KEPT_KEY, SECRET_CONTAINERS } from "./lib/secrets.mjs";

function sensitive(key, value) {
  if (SECRET_CONTAINERS.test(key)) return true;
  if (typeof value === "string" || typeof value === "number") return SENSITIVE_KEY.test(key) && !KEPT_KEY.test(key);
  return false;
}

function clean(value) {
  if (Array.isArray(value)) return value.map(clean);
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (sensitive(k, v)) continue;
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
