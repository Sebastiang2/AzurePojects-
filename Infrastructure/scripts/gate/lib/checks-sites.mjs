// App Service checks: site properties, app settings bag, host name bindings, publishing policies, slots, access rules.
// Each check compares what the Bicep declares (desired) with what production has (live) and records a finding for every
// difference. A difference is only "allowed" when the manifest names it, with its exact before and after value.
import { lc, tail, isExpression, PLACEHOLDER } from "./util.mjs";
import { NAME_SECRET, looksSecret } from "./secrets.mjs";

/** Values are shown in reports only when they are plainly not secrets. */
const shown = (name, value) => (looksSecret(name, value) ? "<hidden>" : JSON.stringify(value));

/** Site properties whose value is case-sensitive on Linux (a command line, a runtime stack, a path). Everything else about a
 *  property is compared case-insensitively because the platform reports enums with varying case. */
const CASE_SENSITIVE = new Set(["siteConfig.appCommandLine", "siteConfig.linuxFxVersion", "siteConfig.healthCheckPath", "siteConfig.windowsFxVersion"]);

/** App setting values are compared exactly; only booleans ("True"/"true") are compared without case. */
const sameSettingValue = (a, b) => {
  const x = String(a ?? "");
  const y = String(b ?? "");
  return x === y || (/^(true|false)$/i.test(x) && /^(true|false)$/i.test(y) && lc(x) === lc(y));
};

// Shapes of an entry in a deployment's `allowedChanges` (manifest). The `property` field selects the check that reads it:
//   siteConfig.<name> | httpsOnly | ...        a site property, with exact before/after          (compareValue)
//   setting:<NAME>                             an app setting value, or literal -> keyvault-reference (checkAppSettings)
//   ipSecurityRestrictions:<rule name>         an access rule that is added                       (checkAccessRules)
//   whatif: true                               a what-if path (glob) of a resource type          (whatif.mjs)
// Each entry carries a `why`; the approver reads it in the report.

/** An allowed-change entry matches on resource, property and (when given) the exact before/after values. */
function allowedChange(deployment, resource, property, before, after) {
  return (deployment.allowedChanges ?? []).find(
    (c) =>
      lc(c.resource) === lc(resource) &&
      lc(c.property) === lc(property) &&
      (c.before === undefined || lc(c.before) === lc(before)) &&
      (c.after === undefined || lc(c.after) === lc(after)),
  );
}

function compareValue(ctx, resource, property, desiredValue, rawLiveValue, id = "SITE-PROP-CHANGE") {
  if (desiredValue === undefined) return; // not declared: the template does not set it, so a deployment does not touch it
  // A property the platform reports as null has its documented default (listed in the manifest): "not set" is not a change.
  const platformDefault = ctx.manifest.defaults?.siteConfig?.[String(property).replace(/^siteConfig\./, "")];
  const liveValue = (rawLiveValue === null || rawLiveValue === undefined) && platformDefault !== undefined ? platformDefault : rawLiveValue;
  if (isExpression(desiredValue)) {
    ctx.findings.info("SITE-PROP-UNEVALUATED", resource, `${property} is an expression the gate cannot evaluate offline`, { property });
    return;
  }
  const exact = CASE_SENSITIVE.has(String(property));
  const same = exact
    ? String(desiredValue) === String(liveValue)
    : typeof desiredValue === "string" || typeof liveValue === "string"
      ? lc(desiredValue) === lc(liveValue)
      : desiredValue === liveValue;
  if (same) {
    ctx.findings.count("siteProperties");
    return;
  }
  const allowance = allowedChange(ctx.deployment, resource, property, liveValue, desiredValue);
  if (allowance) {
    ctx.findings.allowed(id, resource, `${property}: ${JSON.stringify(liveValue)} -> ${JSON.stringify(desiredValue)} (${allowance.why ?? "listed in manifest"})`, { property });
  } else {
    ctx.findings.fail(id, resource, `${property} would change from ${JSON.stringify(liveValue)} to ${JSON.stringify(desiredValue)}`, { property, before: liveValue, after: desiredValue });
  }
}

export function checkSites(ctx) {
  const { desired, live, findings } = ctx;
  for (const site of desired.ofType("Microsoft.Web/sites")) {
    const name = site.name;
    const l = live.apps[name];
    if (!l?.show || !l?.config) {
      // A site that does not exist yet is a create; the what-if evaluation decides whether that is allowed.
      const exists = live.resources.some((r) => lc(r.type) === "microsoft.web/sites" && lc(r.name) === lc(name));
      if (exists) findings.fail("EVIDENCE-SITE", name, "the site exists but its live configuration could not be read");
      else findings.info("SITE-NEW", name, "site does not exist yet (creation is judged by the what-if rules)");
      continue;
    }
    findings.count("sites");
    const p = site.properties ?? {};
    const sc = p.siteConfig ?? {};
    compareValue(ctx, name, "httpsOnly", p.httpsOnly, l.show.httpsOnly);
    compareValue(ctx, name, "publicNetworkAccess", p.publicNetworkAccess, l.show.publicNetworkAccess);
    compareValue(ctx, name, "clientAffinityEnabled", p.clientAffinityEnabled, l.show.clientAffinityEnabled);
    if (p.serverFarmId !== undefined) compareValue(ctx, name, "serverFarm", tail(p.serverFarmId), tail(l.show.serverFarmId));
    if (p.virtualNetworkSubnetId !== undefined) {
      compareValue(ctx, name, "virtualNetworkSubnet", tail(p.virtualNetworkSubnetId), tail(l.show.virtualNetworkSubnetId));
    }
    if (p.outboundVnetRouting?.applicationTraffic !== undefined) {
      compareValue(ctx, name, "outboundVnetRouting.applicationTraffic", p.outboundVnetRouting.applicationTraffic, l.show.outboundVnetRouting?.applicationTraffic);
    }
    if (site.kind !== undefined) compareValue(ctx, name, "kind", site.kind, l.show.kind, "SITE-REPLACEMENT-RISK");

    for (const [key, value] of Object.entries(sc)) {
      if (["ipSecurityRestrictions", "scmIpSecurityRestrictions", "appSettings", "connectionStrings"].includes(key)) continue;
      compareValue(ctx, name, `siteConfig.${key}`, value, l.config[key]);
    }

    // Managed identity: a template that declares SystemAssigned only would drop user-assigned identities.
    const wantType = site.identity?.type;
    const liveType = l.show.identity?.type;
    if (wantType !== undefined && lc(wantType) !== lc(liveType)) {
      findings.fail("IDENTITY-CHANGE", name, `identity type would change from ${liveType} to ${wantType}`);
    }
    const liveUserAssigned = Object.keys(l.show.identity?.userAssignedIdentities ?? {});
    if (liveUserAssigned.length > 0 && !/UserAssigned/i.test(String(wantType))) {
      findings.fail("IDENTITY-DROPPED", name, `${liveUserAssigned.length} user-assigned identit(y/ies) are attached live and the template declares none`);
    }

    // Tags are replaced as a whole.
    const wantTags = site.tags ?? {};
    const liveTags = l.show.tags ?? {};
    const wantLower = new Map(Object.entries(wantTags).map(([k, v]) => [lc(k), String(v)]));
    for (const [k, v] of Object.entries(liveTags)) {
      if (!wantLower.has(lc(k))) findings.fail("TAG-REMOVED", name, `tag ${k} exists live and is not declared (tags are replaced as a whole)`);
      else if (lc(wantLower.get(lc(k))) !== lc(v) && !isExpression(wantLower.get(lc(k)))) findings.fail("TAG-CHANGED", name, `tag ${k} would change`);
    }

    checkAccessRules(ctx, name, sc, l);
  }
}

function ruleName(rule) {
  return rule.name ?? rule.ruleName ?? `${rule.action}:${rule.ip_address ?? rule.ipAddress ?? rule.tag ?? ""}`;
}

function checkAccessRules(ctx, name, sc, l) {
  // Only rules that are explicitly managed (declared in siteConfig) are compared. The implicit "Allow all" has priority 2147483647.
  for (const [declared, liveKey, label] of [
    ["ipSecurityRestrictions", "ipSecurityRestrictions", "main"],
    ["scmIpSecurityRestrictions", "scmIpSecurityRestrictions", "SCM"],
  ]) {
    const want = sc[declared];
    if (!Array.isArray(want)) continue;
    const liveRules = (l.accessrestrictions?.[liveKey] ?? l.config?.[liveKey] ?? []).filter((r) => Number(r.priority) !== 2147483647);
    const wantNames = new Set(want.map((r) => lc(r.name)));
    for (const r of liveRules) {
      if (!wantNames.has(lc(ruleName(r)))) ctx.findings.fail("ACCESS-RULE-REMOVED", name, `${label} access rule "${ruleName(r)}" exists live and is not declared`);
    }
    const liveNames = new Set(liveRules.map((r) => lc(ruleName(r))));
    for (const r of want) {
      if (!liveNames.has(lc(r.name))) {
        const allowance = allowedChange(ctx.deployment, name, `${declared}:${r.name}`, undefined, undefined);
        if (allowance) ctx.findings.allowed("ACCESS-RULE-NEW", name, `${label} access rule "${r.name}" is added (${allowance.why ?? "listed in manifest"})`);
        else ctx.findings.fail("ACCESS-RULE-NEW", name, `${label} access rule "${r.name}" would be added and is not listed in the manifest`);
      }
    }
  }
}

export function checkAppSettings(ctx) {
  const { desired, live, manifest, findings } = ctx;
  for (const site of desired.ofType("Microsoft.Web/sites")) {
    const name = site.name;
    const bagResource = desired.find("Microsoft.Web/sites/config", `${name}/appsettings`);
    const appManifest = manifest.apps?.[name] ?? {};
    if (!bagResource) {
      findings.info("BAG-UNMANAGED", name, "the template declares no appsettings resource for this site (its settings are not touched)");
      continue;
    }
    const want = bagResource.properties;
    if (!want || typeof want !== "object" || Array.isArray(want)) {
      findings.fail("BAG-UNEVALUATED", name, "the desired app settings could not be evaluated offline, so their names cannot be checked");
      continue;
    }
    const liveEntries = live.apps[name]?.appsettings;
    const exists = live.resources.some((r) => lc(r.type) === "microsoft.web/sites" && lc(r.name) === lc(name));
    if (!Array.isArray(liveEntries)) {
      if (exists) findings.fail("EVIDENCE-APPSETTINGS", name, "live app setting names could not be read");
      continue;
    }
    const liveBy = new Map(liveEntries.map((e) => [e.name, e]));
    findings.count("appSettingNamesLive", liveEntries.length);
    findings.count("appSettingNamesDeclared", Object.keys(want).length);
    const deployment = ctx.deployment;
    const removable = new Set((deployment.allowedRemovedSettings?.[name] ?? []).map(lc));
    const addable = new Set((deployment.allowedNewSettings?.[name] ?? []).map(lc));

    // 1. Settings that exist live and are not declared: the whole bag is replaced, so they would be deleted.
    for (const e of liveEntries) {
      if (Object.prototype.hasOwnProperty.call(want, e.name)) continue;
      if (removable.has(lc(e.name))) findings.allowed("BAG-REMOVED", name, `${e.name} is removed on purpose (listed in manifest)`);
      else findings.fail("BAG-LIVE-ONLY", name, `${e.name} exists live and is not declared: a deployment would delete it`, { setting: e.name, kind: e.kind });
    }

    for (const [setting, value] of Object.entries(want)) {
      const l = liveBy.get(setting);
      const feed = PLACEHOLDER.exec(typeof value === "string" ? value : "");
      const expected = appManifest.secureFeeds?.[setting];
      if (feed) {
        // Value comes from a secure parameter fed from an environment variable: the wiring must be the declared one.
        if (!expected) findings.fail("BAG-SECURE-FEED-UNDECLARED", name, `${setting} is fed from ${feed[1]}, which the manifest does not declare`);
        else if (expected !== feed[1]) findings.fail("BAG-SECURE-FEED-MISMATCH", name, `${setting} is fed from ${feed[1]} but the manifest expects ${expected}`);
        else findings.info("BAG-SECURE-FEED", name, `${setting} <- ${feed[1]} (value not comparable)`);
      } else if (expected) {
        findings.fail("BAG-SECURE-FEED-MISSING", name, `${setting} must be fed from ${expected} and is not`);
      }
      if (!l) {
        if (addable.has(lc(setting))) findings.allowed("BAG-NEW", name, `${setting} is added (listed in manifest)`);
        else findings.fail("BAG-NEW", name, `${setting} would be created and is not listed in the manifest`, { setting });
        if (typeof value === "string" && !feed && !isExpression(value) && !/^@Microsoft\.KeyVault\(/.test(value) && NAME_SECRET.test(setting)) {
          findings.fail("BAG-SECRET-LITERAL", name, `${setting} looks like a secret and is declared as a literal`);
        }
        continue;
      }
      if (feed || isExpression(value)) {
        findings.count("appSettingValuesNotComparable"); // names only: secure parameter or runtime expression
        continue;
      }
      if (l.kind === "secret-literal" || l.kind === "ai-connection-string") {
        if (/^@Microsoft\.KeyVault\(/.test(String(value))) {
          const allowance = allowedChange(deployment, name, `setting:${setting}`, "literal", "keyvault-reference");
          if (allowance) findings.allowed("BAG-SECRET-MIGRATION", name, `${setting}: literal -> Key Vault reference (${allowance.why ?? "listed in manifest"})`);
          else findings.fail("BAG-SECRET-MIGRATION", name, `${setting} changes from a literal to a Key Vault reference; the secret and its resolution must be proven first (list it in the manifest)`);
        } else {
          findings.fail("BAG-SECRET-LITERAL", name, `${setting} is a secret in production and the template declares a plain literal for it`);
        }
        continue;
      }
      if (l.kind === "keyvault-reference" || l.kind === "plain" || l.kind === "empty") {
        if (sameSettingValue(l.value, value)) findings.count("appSettingValuesIdentical");
        if (!sameSettingValue(l.value, value)) {
          const allowance = allowedChange(deployment, name, `setting:${setting}`, l.value, value);
          if (allowance) findings.allowed("BAG-VALUE-CHANGE", name, `${setting}: ${shown(setting, l.value)} -> ${shown(setting, value)} (${allowance.why ?? "listed in manifest"})`);
          else findings.fail("BAG-VALUE-CHANGE", name, `${setting} would change from ${shown(setting, l.value)} to ${shown(setting, value)}`, { setting });
        }
      }
    }

    // 2. Names the application cannot start (or must not be enabled) without, and values that must hold.
    for (const required of appManifest.required ?? []) {
      if (!Object.prototype.hasOwnProperty.call(want, required)) findings.fail("BAG-REQUIRED-MISSING", name, `required setting ${required} is not in the desired configuration`, { setting: required });
    }
    for (const [setting, mustBe] of Object.entries(appManifest.mustEqual ?? {})) {
      const value = want[setting];
      if (value === undefined) continue; // reported by the required list when it matters
      if (isExpression(value) || lc(String(value)) !== lc(String(mustBe))) {
        findings.fail("BAG-INVARIANT", name, `${setting} must be ${JSON.stringify(mustBe)} and is ${JSON.stringify(value)}`, { setting });
      }
    }
  }
}

/**
 * App settings of a deployment slot. A slot has its own bag and, after a swap, its settings can end up in production, so the
 * same required names, invariants and secure-parameter wiring that hold for the site apply to every slot bag. (The slot
 * itself is judged by SLOT-NEW and the manifest's allowedCreates.)
 */
export function checkSlotSettings(ctx) {
  const { desired, manifest, findings } = ctx;
  for (const bagResource of desired.ofType("Microsoft.Web/sites/slots/config").filter((r) => /\/appsettings$/i.test(r.name))) {
    const [site, slot] = String(bagResource.name).split("/");
    const subject = `${site}/${slot}`;
    const appManifest = manifest.apps?.[site] ?? {};
    const want = bagResource.properties;
    if (!want || typeof want !== "object" || Array.isArray(want)) {
      findings.fail("SLOT-BAG-UNEVALUATED", subject, "the slot's app settings could not be evaluated offline, so their names cannot be checked");
      continue;
    }
    findings.count("slotBagSettings", Object.keys(want).length);
    for (const required of appManifest.required ?? []) {
      if (!Object.prototype.hasOwnProperty.call(want, required)) findings.fail("SLOT-BAG-REQUIRED-MISSING", subject, `required setting ${required} is not in the slot's configuration`, { setting: required });
    }
    for (const [setting, mustBe] of Object.entries(appManifest.mustEqual ?? {})) {
      const value = want[setting];
      if (value === undefined) continue;
      if (isExpression(value) || lc(String(value)) !== lc(String(mustBe))) findings.fail("SLOT-BAG-INVARIANT", subject, `${setting} must be ${JSON.stringify(mustBe)} and is ${JSON.stringify(value)} in the slot`, { setting });
    }
    for (const [setting, value] of Object.entries(want)) {
      const feed = PLACEHOLDER.exec(typeof value === "string" ? value : "");
      const expected = appManifest.secureFeeds?.[setting];
      if (feed && expected !== feed[1]) findings.fail("SLOT-BAG-SECURE-FEED", subject, `${setting} is fed from ${feed[1]}; the manifest expects ${expected ?? "no secure parameter"}`);
      if (!feed && expected) findings.fail("SLOT-BAG-SECURE-FEED", subject, `${setting} must be fed from ${expected} and is not`);
      if (typeof value === "string" && !feed && !isExpression(value) && !/^@Microsoft\.KeyVault\(/.test(value) && NAME_SECRET.test(setting)) {
        findings.fail("SLOT-BAG-SECRET-LITERAL", subject, `${setting} looks like a secret and is declared as a literal in the slot`);
      }
    }
  }
}

/** Declared leaves of the Easy Auth configuration must equal live; the resource replaces the whole auth config. */
export function checkAuthSettings(ctx) {
  const { desired, live, findings } = ctx;
  for (const auth of desired.ofType("Microsoft.Web/sites/config").filter((r) => /\/authsettingsV2$/i.test(r.name))) {
    const site = String(auth.name).split("/")[0];
    const current = live.apps[site]?.authsettings?.properties;
    if (!current) {
      findings.fail("EVIDENCE-AUTHSETTINGS", site, "live Easy Auth configuration could not be read");
      continue;
    }
    const walk = (want, have, path) => {
      for (const [key, value] of Object.entries(want ?? {})) {
        const p = path ? `${path}.${key}` : key;
        const liveValue = have?.[key];
        if (value && typeof value === "object" && !Array.isArray(value)) {
          walk(value, liveValue, p);
        } else if (isExpression(value)) {
          findings.info("AUTH-UNEVALUATED", site, `${p} is an expression and is not compared`);
        } else if (String(value).toLowerCase() !== String(liveValue).toLowerCase()) {
          findings.fail("AUTH-CHANGE", site, `Easy Auth ${p} would change from ${JSON.stringify(liveValue)} to ${JSON.stringify(value)}`, { path: p });
        }
      }
    };
    walk(auth.properties, current, "");
  }
}

export function checkHostBindings(ctx) {
  const { desired, live, findings } = ctx;
  for (const binding of desired.ofType("Microsoft.Web/sites/hostNameBindings")) {
    const [siteName, host] = String(binding.name).split("/");
    const bindings = live.apps[siteName]?.hostnamebindings?.value;
    if (!Array.isArray(bindings)) {
      findings.fail("EVIDENCE-BINDINGS", siteName, `live host name bindings could not be read (needed for ${host})`);
      continue;
    }
    const current = bindings.find((b) => lc(tail(b.name)) === lc(host));
    const p = binding.properties ?? {};
    if (!current) {
      findings.info("BINDING-NEW", `${siteName}/${host}`, "binding does not exist yet (creation is judged by the what-if rules)");
      continue;
    }
    const lp = current.properties ?? {};
    if (p.sslState !== undefined && lc(p.sslState) !== lc(lp.sslState)) {
      findings.fail("BINDING-SSL-CHANGE", `${siteName}/${host}`, `sslState would change from ${lp.sslState} to ${p.sslState}`);
    }
    if (p.hostNameType !== undefined && lc(p.hostNameType) !== lc(lp.hostNameType)) {
      findings.fail("BINDING-TYPE-CHANGE", `${siteName}/${host}`, `hostNameType would change from ${lp.hostNameType} to ${p.hostNameType}`);
    }
    findings.count("hostNameBindings");
    if (typeof p.thumbprint === "string") {
      const certName = /certificates\/([^'/,)]+)/i.exec(p.thumbprint)?.[1];
      const declaredHere = certName ? desired.find("Microsoft.Web/certificates", certName) : undefined;
      const liveResource = certName ? live.resources.find((r) => lc(r.type) === "microsoft.web/certificates" && lc(r.name) === lc(certName)) : undefined;
      const cert = certName ? live.certs.find((c) => lc(c.name) === lc(certName)) : undefined;
      if (certName && !liveResource && !declaredHere) {
        findings.fail("BINDING-CERT-MISSING", `${siteName}/${host}`, `certificate ${certName} was not found live`);
      } else if (certName && declaredHere) {
        // The certificate is managed by this same template (App Service managed certificate): the what-if rules judge it.
        findings.info("BINDING-CERT-DECLARED", `${siteName}/${host}`, `certificate ${certName} is declared in this template`);
      } else if (cert && lc(cert.properties?.thumbprint) !== lc(lp.thumbprint)) {
        findings.fail("BINDING-THUMBPRINT-CHANGE", `${siteName}/${host}`, "the binding would switch to a different certificate");
      } else if (certName && !cert) {
        findings.fail("EVIDENCE-CERT", `${siteName}/${host}`, `certificate ${certName} exists but its thumbprint could not be read`);
      } else if (!certName && !isExpression(p.thumbprint) && lc(p.thumbprint) !== lc(lp.thumbprint)) {
        findings.fail("BINDING-THUMBPRINT-CHANGE", `${siteName}/${host}`, "thumbprint would change");
      }
    }
  }
  // Custom domains that exist live on managed sites: report the ones this template does not declare (preserved by Incremental mode).
  for (const [site, l] of Object.entries(live.apps)) {
    if (!desired.find("Microsoft.Web/sites", site)) continue;
    const declared = new Set(desired.ofType("Microsoft.Web/sites/hostNameBindings").map((b) => lc(String(b.name).split("/")[1])));
    for (const b of l.hostnamebindings?.value ?? []) {
      const host = tail(b.name);
      if (/\.azurewebsites\.net$/i.test(host) || declared.has(lc(host))) continue;
      findings.info("BINDING-UNMANAGED", `${site}/${host}`, "custom domain exists live and is not declared here (preserved: Incremental mode never removes it)");
    }
  }
}

export function checkPublishingPolicies(ctx) {
  const { desired, live, findings } = ctx;
  for (const policy of desired.ofType("Microsoft.Web/sites/basicPublishingCredentialsPolicies")) {
    const [site, kind] = String(policy.name).split("/");
    const l = live.apps[site];
    const current = kind === "ftp" ? l?.publishFtp : l?.publishScm;
    if (!current) {
      findings.info("PUBLISH-NEW", `${site}/${kind}`, "no live policy evidence (site not collected or not created yet)");
      continue;
    }
    findings.count("publishingPolicies");
    const want = policy.properties?.allow;
    const have = current.properties?.allow;
    if (want !== undefined && want !== have) findings.fail("PUBLISH-POLICY-CHANGE", `${site}/${kind}`, `basic publishing credentials (${kind}) allow would change from ${have} to ${want}`);
  }
}

export function checkSlots(ctx) {
  const { desired, live, findings, deployment } = ctx;
  for (const slot of desired.ofType("Microsoft.Web/sites/slots")) {
    const [site, slotName] = String(slot.name).split("/");
    const existing = (live.apps[site]?.slots ?? []).some((s) => lc(tail(s.name)) === lc(slotName) || lc(s.name) === lc(`${site}/${slotName}`));
    if (existing) {
      findings.info("SLOT-EXISTS", slot.name, "slot exists live");
      continue;
    }
    const allowance = (deployment.allowedCreates ?? []).find((c) => lc(c.type) === "microsoft.web/sites/slots" && lc(c.name) === lc(slot.name));
    if (allowance) findings.allowed("SLOT-NEW", slot.name, `slot is created (${allowance.why ?? "listed in manifest"})`);
    else findings.fail("SLOT-NEW", slot.name, "a deployment slot would be created: it is a second public entrance to production data and needs its own approval");
  }
  // Sticky settings are replaced as a whole.
  for (const cfg of desired.ofType("Microsoft.Web/sites/config").filter((r) => /\/slotConfigNames$/i.test(r.name))) {
    const site = String(cfg.name).split("/")[0];
    const liveNames = live.apps[site]?.slotconfignames?.properties?.appSettingNames ?? [];
    const wantNames = cfg.properties?.appSettingNames ?? [];
    for (const n of liveNames) {
      if (!wantNames.map(lc).includes(lc(n))) findings.fail("SLOT-STICKY-REMOVED", site, `sticky setting ${n} exists live and is not declared`);
    }
  }
}
