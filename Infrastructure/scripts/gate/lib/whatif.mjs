// Judges the reduced what-if result (summarize-whatif.mjs output) against the manifest. what-if is one of three independent
// signals (the others are the offline desired-vs-live checks and the RBAC/evidence checks); it is never trusted alone.
import { lc, normalizePath, globToRegExp, isExpression } from "./util.mjs";
import { originLockTransition } from "./checks-sites.mjs";

const PROTECTED = /(subnets|securityRules|ipSecurityRestrictions|scmIpSecurityRestrictions|hostNameSslStates|hostNameBindings|accessPolicies|userAssignedIdentities|privateEndpointConnections|delegations|serviceEndpoints|virtualNetworkRules|identity)(\[|\.|$)/i;

function matchNoise(manifest, type, path, op) {
  return (manifest.noise ?? []).find(
    (n) =>
      lc(n.type) === lc(type) &&
      (!n.ops || n.ops.map(lc).includes(lc(op))) &&
      (n.paths ?? []).some((g) => globToRegExp(g).test(normalizePath(path))),
  );
}

export function evaluateWhatIf(ctx) {
  const { whatif, manifest, deployment, findings, live } = ctx;
  if (!whatif) {
    findings.fail("WHATIF-MISSING", "what-if", "no what-if result is available");
    return { noise: {}, counts: {} };
  }
  if (whatif.status !== "Succeeded") findings.fail("WHATIF-STATUS", "what-if", `what-if status is ${JSON.stringify(whatif.status)}`);
  if (whatif.error) findings.fail("WHATIF-ERROR", "what-if", `what-if reported an error: ${whatif.error.code ?? ""} ${whatif.error.message ?? ""}`.trim());
  if (!Array.isArray(whatif.changes) || whatif.changes.length === 0) {
    findings.fail("WHATIF-EMPTY", "what-if", "what-if returned no changes at all: the result is incomplete");
    return { noise: {}, counts: whatif.counts ?? {} };
  }

  // Coverage: every declared resource must appear in the what-if result, or the result is incomplete.
  const seen = new Set(whatif.changes.map((c) => `${lc(c.type)}|${lc(c.name)}`));
  for (const r of ctx.desired?.resources ?? []) {
    if (isExpression(r.name)) continue; // computed at deployment time; reported as Unsupported
    if (seen.has(`${lc(r.type)}|${lc(r.name)}`)) continue;
    const blind = (deployment.whatifBlind ?? []).find((b) => lc(b.type) === lc(r.type) && lc(b.name) === lc(r.name));
    if (blind) findings.allowed("WHATIF-BLIND", `${r.type} ${r.name}`, `what-if does not list this resource (${blind.why}); verified by ${blind.verifiedBy}`);
    else findings.fail("WHATIF-COVERAGE", `${r.type} ${r.name}`, "declared in the template but missing from the what-if result: the result is incomplete");
  }

  // Approved resources: a deployment may only change the resources its manifest entry lists. A change to anything else is a
  // change to a resource nobody approved for this deployment, even if the template declares it.
  if (!Array.isArray(deployment.touches)) {
    findings.fail("WHATIF-TOUCHES-MISSING", "manifest", "the manifest does not list the resources this deployment may change (touches)");
  }
  const unsupportedByModule = {};

  const noiseCounts = {};
  const countNoise = (rule) => {
    const key = `${rule.type} ${rule.paths.join(", ")}`;
    noiseCounts[key] = (noiseCounts[key] ?? 0) + 1;
  };

  for (const change of whatif.changes) {
    const subject = `${change.type} ${change.name}`;
    const judgedByModule = change.changeType === "Unsupported" || change.changeType === "Deploy";
    if (Array.isArray(deployment.touches) && change.changeType !== "NoChange" && change.changeType !== "Ignore" && !judgedByModule) {
      const approved = deployment.touches.some((t) => lc(t.type) === lc(change.type) && globToRegExp(t.name).test(change.name));
      if (!approved) findings.fail("WHATIF-RESOURCE-NOT-APPROVED", subject, `the deployment would ${String(change.changeType).toLowerCase()} a resource that is not in this deployment's approved list (touches)`);
    }
    switch (change.changeType) {
      case "NoChange":
      case "Ignore":
        break;
      case "Delete":
        findings.fail("WHATIF-DELETE", subject, "the deployment would delete this resource");
        break;
      case "Create": {
        const allowance = (deployment.allowedCreates ?? []).find((c) => lc(c.type) === lc(change.type) && globToRegExp(c.name).test(change.name));
        if (allowance) findings.allowed("WHATIF-CREATE", subject, `created (${allowance.why ?? "listed in manifest"})`);
        else findings.fail("WHATIF-CREATE", subject, "a resource would be created and is not listed in the manifest (a duplicate or an unexpected new resource)");
        break;
      }
      case "Unsupported":
      case "Deploy": {
        const module = /resources\.([A-Za-z0-9_-]+)\.properties\.template/.exec(change.unsupportedReason ?? "")?.[1];
        unsupportedByModule[module] = (unsupportedByModule[module] ?? 0) + 1;
        const allowance = (deployment.allowedUnsupported ?? []).find((u) => u.module && lc(u.module) === lc(module));
        if (allowance) findings.allowed("WHATIF-UNSUPPORTED", `${change.changeType} (module ${module})`, `not analysable by what-if; verified by other checks (${allowance.why ?? "listed in manifest"})`);
        else findings.fail("WHATIF-UNSUPPORTED", subject, `what-if cannot analyse this resource and the manifest does not cover it${module ? ` (module ${module})` : ""}`);
        break;
      }
      case "Modify": {
        for (const d of change.deltas ?? []) {
          if (d.op === "NoEffect") {
            noiseCounts["changes ARM itself marks as NoEffect"] = (noiseCounts["changes ARM itself marks as NoEffect"] ?? 0) + 1;
            continue;
          }
          const rule = matchNoise(manifest, change.type, d.path, d.op);
          if (rule) {
            countNoise(rule);
            continue;
          }
          // The reduced what-if hides array bodies. Accept only a whole, manifest-exact transition independently
          // verified against the desired snapshot and live access rules; never exempt SCM or another site.
          const originSite = deployment.originLock?.resource;
          const scopedOrigin = lc(change.type) === "microsoft.web/sites/config" && lc(change.name) === lc(`${originSite}/web`);
          const fullOrigin = lc(change.type) === "microsoft.web/sites" && lc(change.name) === lc(originSite);
          const originPrefix = scopedOrigin ? "properties." : "properties.siteConfig.";
          if ((scopedOrigin || fullOrigin) &&
            new RegExp(`^${originPrefix.replaceAll(".", "\\.")}ipSecurityRestrictions(?:DefaultAction|(?:\\[\\d+\\])?(?:\\.[A-Za-z]+)?)$`).test(d.path)) {
            const desiredSite = ctx.desired.find("Microsoft.Web/sites", originSite);
            const desiredWeb = ctx.desired.find("Microsoft.Web/sites/config", `${originSite}/web`);
            const desiredConfig = desiredSite?.properties?.siteConfig ?? desiredWeb?.properties;
            const liveSite = live.apps[originSite];
            const liveRules = (liveSite?.accessrestrictions?.ipSecurityRestrictions ?? liveSite?.config?.ipSecurityRestrictions ?? [])
              .filter((r) => Number(r.priority) !== 2147483647);
            const baseline = liveSite?.config?.ipSecurityRestrictionsDefaultAction == null &&
              lc(ctx.manifest.defaults?.siteConfig?.ipSecurityRestrictionsDefaultAction) === "allow" &&
              lc(desiredConfig?.ipSecurityRestrictionsDefaultAction) === "allow" &&
              liveRules.length === 0 && desiredConfig?.ipSecurityRestrictions?.length === 0;
            // Azure reports the implicit Allow default as null, then what-if reports an explicit
            // Allow as Create. This is safe only while both live and desired rule lists are empty.
            if (baseline && d.path === `${originPrefix}ipSecurityRestrictionsDefaultAction` &&
              d.op === "Create" && d.before == null && lc(d.after) === "allow") {
              findings.allowed("WHATIF-ORIGIN-BASELINE", subject, `${d.path} makes the existing implicit Allow explicit while both main-site rule lists stay empty`);
              continue;
            }
            // The scoped web config shows deletion of App Service's synthetic "Allow all"
            // list when the disabled template explicitly declares an empty list.
            if (scopedOrigin && baseline && d.path === "properties.ipSecurityRestrictions" && d.op === "Delete" &&
              d.before?.kind === "array" && d.before.length === 1 && d.before.names?.length === 1 &&
              lc(d.before.names[0]) === "allow all") {
              findings.allowed("WHATIF-ORIGIN-BASELINE", subject, "the implicit Allow all rule is represented by an explicit empty main-site list");
              continue;
            }
            const transition = originLockTransition(ctx, originSite);
            const expected = deployment.originLock.rules;
            const relevant = transition === "enable" ? d.after : d.before;
            const observedNames = [relevant?.name, ...(relevant?.names ?? [])].filter(Boolean);
            const knownNames = new Set(expected.map((r) => lc(r.name)));
            const indexed = /ipSecurityRestrictions\[(\d+)\](?:\.(name|priority|action|ipAddress))?$/.exec(d.path);
            const member = indexed ? expected[Number(indexed[1])] : null;
            const scalar = transition === "enable" ? d.after : d.before;
            const memberMatches = !indexed || (member && (!scalar ||
              (typeof scalar === "object" ? (!scalar.name || lc(scalar.name) === lc(member.name)) :
                indexed[2] && lc(scalar) === lc(member[indexed[2]]))));
            const arrayMatches = d.after?.kind !== "array" ||
              (transition === "enable" ? d.after.length === expected.length && d.after.names?.length === expected.length : d.after.length === 0);
            const defaultMatches = !d.path.endsWith("DefaultAction") || d.after === undefined ||
              lc(d.after) === (transition === "enable" ? "deny" : "allow");
            const namesMatch = observedNames.every((name) => knownNames.has(lc(name)));
            if (transition && memberMatches && arrayMatches && defaultMatches && namesMatch) {
              findings.allowed("WHATIF-ORIGIN-LOCK", subject, `${d.path} is the reviewed ${transition} transition (${deployment.originLock.why})`);
            } else {
              findings.fail("WHATIF-ORIGIN-LOCK", subject, `${d.path} is not an exact reviewed origin-lock transition`);
            }
            continue;
          }
          // what-if reads only part of a site's configuration; a "Create" in siteConfig is judged against the live config.
          if (lc(change.type) === "microsoft.web/sites" && /^properties\.siteConfig\.[A-Za-z0-9]+$/.test(d.path) && d.op === "Create") {
            const key = d.path.split(".").pop();
            const liveValue = live.apps[change.name]?.config?.[key];
            const after = d.after;
            const approved = (deployment.allowedChanges ?? []).find(
              (c) => lc(c.resource) === lc(change.name) && lc(c.property) === lc(`siteConfig.${key}`) && (c.after === undefined || lc(String(c.after)) === lc(String(after))),
            );
            if (approved) {
              findings.allowed("WHATIF-SITECONFIG", subject, `${d.path} -> ${JSON.stringify(after)} (${approved.why ?? "approved in manifest"})`);
              continue;
            }
            if (isExpression(after)) {
              findings.info("WHATIF-SITECONFIG-EXPR", subject, `${d.path} is an expression; compared by the offline site check`);
              continue;
            }
            if (liveValue !== undefined && lc(String(liveValue)) === lc(String(after))) {
              noiseCounts["Microsoft.Web/sites siteConfig values equal to live"] = (noiseCounts["Microsoft.Web/sites siteConfig values equal to live"] ?? 0) + 1;
              continue;
            }
            if (liveValue === undefined || liveValue === null) {
              // the live config does not report it: the default would be written. Only a listed default is acceptable.
              const listed = (manifest.defaults?.siteConfig ?? {})[key];
              if (listed !== undefined && lc(String(listed)) === lc(String(after))) {
                noiseCounts["Microsoft.Web/sites siteConfig platform defaults"] = (noiseCounts["Microsoft.Web/sites siteConfig platform defaults"] ?? 0) + 1;
                continue;
              }
            }
            findings.fail("WHATIF-SITECONFIG", subject, `${d.path} would be written as ${JSON.stringify(after)} while live has ${JSON.stringify(liveValue)}`);
            continue;
          }
          // diagnostic settings: dropped disabled categories are harmless; enabled ones are caught by DIAG-CATEGORY-LOST.
          if (lc(change.type) === "microsoft.insights/diagnosticsettings" && /^properties\.(logs|metrics)/.test(d.path)) {
            noiseCounts["Microsoft.Insights/diagnosticSettings category entries (judged by DIAG-* checks)"] = (noiseCounts["Microsoft.Insights/diagnosticSettings category entries (judged by DIAG-* checks)"] ?? 0) + 1;
            continue;
          }
          // role assignment adoption (name fixed in the template): principal is an unevaluated expression
          if (lc(change.type) === "microsoft.authorization/roleassignments") {
            noiseCounts["Microsoft.Authorization/roleAssignments (judged by RBAC-* checks)"] = (noiseCounts["Microsoft.Authorization/roleAssignments (judged by RBAC-* checks)"] ?? 0) + 1;
            continue;
          }
          if (lc(change.type) === "microsoft.web/sites/config" && /\/appsettings$/i.test(change.name) && d.path === "properties") {
            noiseCounts["Microsoft.Web/sites/config appsettings bag (judged by BAG-* checks)"] = (noiseCounts["Microsoft.Web/sites/config appsettings bag (judged by BAG-* checks)"] ?? 0) + 1;
            continue;
          }
          const allowance = (deployment.allowedChanges ?? []).find(
            (c) => c.whatif === true && lc(c.type) === lc(change.type) && lc(c.resource) === lc(change.name) && globToRegExp(c.property).test(normalizePath(d.path)),
          );
          if (allowance) {
            findings.allowed("WHATIF-CHANGE", subject, `${d.path} (${allowance.why ?? "listed in manifest"})`);
            continue;
          }
          if (d.op === "Delete" && PROTECTED.test(d.path)) {
            const element = d.before?.name ?? d.before?.names?.[0];
            findings.fail("WHATIF-DELETE-ELEMENT", subject, `the deployment would remove ${d.path}${element ? ` (${element})` : ""}`, { path: d.path });
          } else {
            findings.fail("WHATIF-UNEXPECTED-CHANGE", subject, `${d.op} ${d.path} is not covered by the noise list or the manifest`, { path: d.path, op: d.op });
          }
        }
        for (const rule of manifest.immutable ?? []) {
          if (lc(rule.type) !== lc(change.type)) continue;
          for (const d of change.deltas ?? []) {
            if (globToRegExp(rule.path).test(normalizePath(d.path)) && d.op !== "NoEffect") {
              findings.fail("WHATIF-REPLACEMENT-RISK", subject, `${d.path} is immutable or forces a replacement (${rule.why ?? ""})`.trim(), { path: d.path });
            }
          }
        }
        break;
      }
      default:
        findings.fail("WHATIF-UNKNOWN-CHANGETYPE", subject, `unknown change type ${JSON.stringify(change.changeType)}`);
    }
  }
  // An allowed module may only contain as many unanalysable resources as the manifest says; more means something was added.
  for (const u of deployment.allowedUnsupported ?? []) {
    const n = unsupportedByModule[u.module] ?? 0;
    if (u.count !== undefined && n > u.count) {
      findings.fail("WHATIF-UNSUPPORTED-COUNT", `module ${u.module}`, `what-if cannot analyse ${n} resources in this module and the manifest approved ${u.count}`);
    }
  }
  return { noise: noiseCounts, counts: whatif.counts ?? {} };
}
