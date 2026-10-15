// stdin: raw JSON of `az webapp config appsettings list` (app or slot). stdout: sanitized JSON.
// Keeps NAME, slotSetting and KIND for every entry. A VALUE is kept only for entries classified as non-secret
// ("plain") or as a Key Vault reference (a reference string is not a secret). Secret-like literals keep no value,
// no length and no fingerprint: presence is all that is needed to tell whether a deployment would delete them.
import { readFileSync } from "node:fs";

const NAME_SECRET = /(secret|password|passwd|pwd|apikey|api_key|key$|token|authorization|connectionstring|salt|signing|private_key|credential|\bsas\b|pat$)/i;
const VALUE_SECRET = /(password=|pwd=|accountkey=|sharedaccesssignature|[?&]sig=|bearer\s|-----BEGIN|:\/\/[^\/\s:@]+:[^\/\s@]+@)/i;
const OPAQUE = /^[A-Za-z0-9+\/=_-]{24,}$/;
const KV_REF = /^@Microsoft\.KeyVault\(/;
const AI_CS = /(^InstrumentationKey=|;IngestionEndpoint=)/;

let entries;
try {
  entries = JSON.parse(readFileSync(0, "utf8"));
} catch {
  console.error("sanitize-appsettings: stdin was not JSON");
  process.exit(2);
}
if (!Array.isArray(entries)) {
  console.error("sanitize-appsettings: expected an array");
  process.exit(2);
}

const out = entries.map((e) => {
  const value = typeof e.value === "string" ? e.value : "";
  let kind;
  if (value === "") kind = "empty";
  else if (KV_REF.test(value)) kind = "keyvault-reference";
  else if (AI_CS.test(value)) kind = "ai-connection-string";
  else if (NAME_SECRET.test(e.name) || VALUE_SECRET.test(value) || OPAQUE.test(value)) kind = "secret-literal";
  else kind = "plain";
  const keep = kind === "plain" || kind === "keyvault-reference";
  return { name: e.name, slotSetting: !!e.slotSetting, kind, value: keep ? value : undefined };
});
process.stdout.write(JSON.stringify(out));
