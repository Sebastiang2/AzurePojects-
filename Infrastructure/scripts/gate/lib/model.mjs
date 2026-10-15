// Loads the two sides the gate compares:
//   desired - what the Bicep code says, as predicted offline by `az bicep snapshot` (one entry per ARM resource)
//   live    - what production looks like, as collected read-only by collect-live.sh (already sanitized)
import { existsSync, readdirSync } from "node:fs";
import { lc, readJson } from "./util.mjs";

export function loadDesired(snapshotPath, problems) {
  const snapshot = readJson(snapshotPath, problems);
  const resources = Array.isArray(snapshot?.predictedResources) ? snapshot.predictedResources : [];
  const byType = new Map();
  for (const r of resources) {
    const key = lc(r.type);
    if (!byType.has(key)) byType.set(key, []);
    byType.get(key).push(r);
  }
  return {
    ok: Boolean(snapshot) && Array.isArray(snapshot.predictedResources),
    resources,
    ofType: (type) => byType.get(lc(type)) ?? [],
    find: (type, name) => (byType.get(lc(type)) ?? []).find((r) => lc(r.name) === lc(name)),
  };
}

export function loadLive(dir, problems) {
  const read = (rel) => readJson(`${dir}/${rel}`, problems);
  const appsDir = `${dir}/apps`;
  const appNames = existsSync(appsDir)
    ? readdirSync(appsDir).filter((f) => f.endsWith(".show.json")).map((f) => f.replace(/\.show\.json$/, ""))
    : [];
  const apps = {};
  for (const name of appNames) {
    const part = (suffix) => readJson(`${appsDir}/${name}.${suffix}.json`, problems);
    apps[name] = {
      show: part("show"),
      config: part("config"),
      appsettings: part("appsettings"),
      kvrefs: part("kvrefs"),
      slots: part("slots"),
      slotconfignames: part("slotconfignames"),
      accessrestrictions: part("accessrestrictions"),
      publishFtp: part("publishpolicy.ftp"),
      publishScm: part("publishpolicy.scm"),
      hostnamebindings: part("hostnamebindings"),
      networkconfig: part("networkconfig"),
      diag: part("diag"),
      authsettings: part("authsettingsv2"),
    };
  }
  const zones = read("private-dns-zones.json") ?? [];
  const dnsLinks = {};
  for (const z of zones) dnsLinks[z.name] = readJson(`${dir}/dnslinks.${z.name}.json`, problems) ?? [];
  const identities = read("identities.json") ?? [];
  const fics = {};
  for (const i of identities) fics[i.name] = readJson(`${dir}/fic.${i.name}.json`, problems) ?? [];
  const staticSites = readJson(`${dir}/swa.list.json`, undefined) ?? [];
  const swaHostnames = {};
  for (const s of staticSites) swaHostnames[s.name] = readJson(`${dir}/swa.${s.name}.hostnames.json`, problems) ?? [];
  return {
    dir,
    account: read("account.json"),
    resources: read("resources.json") ?? [],
    apps,
    plan: read("plan.json"),
    vnet: read("vnet.json"),
    subnets: read("subnets.json") ?? [],
    nsgs: read("nsgs.json") ?? [],
    privateEndpoints: read("private-endpoints.json") ?? [],
    privateDnsZones: zones,
    dnsLinks,
    mysql: read("mysql.json"),
    keyvault: read("keyvault.json"),
    keyvaultDiag: readJson(`${dir}/keyvault.diag.json`, undefined),
    mysqlDiag: readJson(`${dir}/mysql.diag.json`, undefined),
    roleAssignments: read("roleassignments.json") ?? [],
    identities,
    fics,
    certs: readJson(`${dir}/certs-detail.json`, undefined)?.value ?? [],
    staticSites,
    swaHostnames,
  };
}
