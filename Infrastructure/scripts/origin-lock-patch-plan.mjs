// Read-only plan for the Data API main-site perimeter. ARM/Bicep PUT of a sparse
// sites/config/web resource can reset omitted settings; a future approved change
// must use the App Service 2024-11-01 PATCH operation with this exact body.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const subscription = "563af248-8461-42a9-8121-e350e48ca7b6";
const resourceGroup = "rg-invi-prod-swc-001";
const app = "app-invi-data-api-prod-001";
export const webConfigUrl = `https://management.azure.com/subscriptions/${subscription}/resourceGroups/${resourceGroup}/providers/Microsoft.Web/sites/${app}/config/web?api-version=2024-11-01`;
const requiredSettings = {
  "WebDrafts__Enabled": "false",
  "WebDrafts__TrustCloudflareConnectingIp": "false",
  "PlaceSuggestions__Enabled": "false",
  "WebDrafts__PlaceSuggestionsPaused": "true",
  WEBSITE_WARMUP_PATH: "/v1/extras/ready",
  WEBSITE_WARMUP_STATUSES: "200",
};
const fields = ["name", "priority", "action", "ipAddress"];
const normalize = (rule) => Object.fromEntries(fields.map((key) => [key, rule[key]]));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export function planOriginLockPatch({ state, web, appSettings, rules }) {
  if (!["enable", "rollback"].includes(state)) throw new Error("state must be enable or rollback");
  if (!Array.isArray(rules) || rules.length !== 22 ||
      rules.filter((r) => r.name?.includes("-v4-")).length !== 15 ||
      rules.filter((r) => r.name?.includes("-v6-")).length !== 7 ||
      new Set(rules.map((r) => r.name)).size !== rules.length ||
      new Set(rules.map((r) => r.priority)).size !== rules.length ||
      rules.some((r) => Object.keys(r).sort().join(",") !== "action,ipAddress,name,priority" || r.action !== "Allow")) {
    throw new Error("the manifest must contain the exact reviewed 15 IPv4 and 7 IPv6 allow rules");
  }
  const p = web?.properties;
  if (!p || p.scmIpSecurityRestrictionsUseMain !== false || p.healthCheckPath != null ||
      (p.scmIpSecurityRestrictionsDefaultAction ?? "Allow") !== "Allow" ||
      (p.scmIpSecurityRestrictions ?? []).some((rule) => Number(rule.priority) !== 2147483647) ||
      p.alwaysOn !== true || p.linuxFxVersion !== "DOTNETCORE|10.0" ||
      p.minTlsVersion !== "1.2" || p.scmMinTlsVersion !== "1.2" ||
      p.http20Enabled !== true || p.webSocketsEnabled !== true || p.siteAuthEnabled !== false) {
    throw new Error("live SCM, health check, always-on, TLS, authentication or runtime differs from the reviewed baseline");
  }
  const settings = new Map((appSettings ?? []).map(({ name, value }) => [name, value]));
  for (const [name, expected] of Object.entries(requiredSettings)) {
    const actual = settings.get(name);
    const matches = expected === "true" || expected === "false"
      ? typeof actual === "string" && actual.toLowerCase() === expected
      : actual === expected;
    if (!matches) throw new Error(`required non-secret App Setting ${name} differs from baseline`);
  }
  const live = (p.ipSecurityRestrictions ?? []).filter((rule) => Number(rule.priority) !== 2147483647)
    .map(normalize).sort((a, b) => a.priority - b.priority);
  const reviewedRules = rules.map(normalize).sort((a, b) => a.priority - b.priority);
  const action = p.ipSecurityRestrictionsDefaultAction ?? "Allow";
  if (state === "enable" && (live.length !== 0 || action !== "Allow")) {
    throw new Error("activation requires the unrestricted reviewed main-site baseline");
  }
  if (state === "rollback" && (!same(live, reviewedRules) || action !== "Deny")) {
    throw new Error("rollback requires the exact reviewed Cloudflare list and Deny state");
  }
  return {
    method: "PATCH",
    url: webConfigUrl,
    body: {
      properties: {
        ipSecurityRestrictions: state === "enable" ? rules.map(normalize) : [],
        ipSecurityRestrictionsDefaultAction: state === "enable" ? "Deny" : "Allow",
      },
    },
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const state = process.argv[2];
  if (!["enable", "rollback"].includes(state) || process.argv.length !== 3) {
    console.error("usage: node Infrastructure/scripts/origin-lock-patch-plan.mjs enable|rollback");
    process.exit(2);
  }
  try {
    const manifest = JSON.parse(readFileSync(new URL("../safety/manifest.json", import.meta.url), "utf8"));
    const rules = manifest.deployments.main.originLock.rules;
    const web = JSON.parse(execFileSync("az", ["rest", "--method", "get", "--url", webConfigUrl,
      "--only-show-errors", "-o", "json"], { encoding: "utf8" }));
    const appSettings = JSON.parse(execFileSync("az", ["webapp", "config", "appsettings", "list",
      "--subscription", subscription, "--resource-group", resourceGroup, "--name", app,
      "--only-show-errors", "-o", "json"], { encoding: "utf8" }));
    const plan = planOriginLockPatch({ state, web, appSettings, rules });
    // This output has only public Cloudflare CIDRs and the two main-site fields.
    // The tool has no write mode; a separately approved operator must execute PATCH.
    console.log(JSON.stringify(plan, null, 2));
  } catch (error) {
    // Never print Azure CLI output or App Settings: an error may contain sensitive data.
    console.error("Origin-lock PATCH plan blocked: production baseline or Azure read failed.");
    process.exit(1);
  }
}
