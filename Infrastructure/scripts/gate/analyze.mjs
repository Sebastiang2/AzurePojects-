#!/usr/bin/env node
// Deployment safety gate: the analysis engine. Fail-closed: anything it cannot positively verify is a failure.
//
//   node analyze.mjs --work <dir> --manifest <manifest.json> --deployment <key> [--out report.json] [--md report.md]
//
// <dir> holds what preflight.sh gathered (read-only):
//   context.json   what ran, with which files and hashes (written by preflight.sh)
//   snapshot.json  `az bicep snapshot` of the template + parameters (offline evaluation, secure parameters = placeholders)
//   whatif.json    reduced what-if result (summarize-whatif.mjs; no secret values)
//   live/          production state collected by collect-live.sh (names and non-secret values only)
//
// Exit code: 0 = PASS, 1 = FAIL (at least one blocking finding), 2 = the gate could not run (also a failure for deploy).
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { Findings, canonical, readJson, sha256, lc } from "./lib/util.mjs";
import { loadDesired, loadLive } from "./lib/model.mjs";
import { checkSites, checkAppSettings, checkSlotSettings, checkAuthSettings, checkHostBindings, checkPublishingPolicies, checkSlots } from "./lib/checks-sites.mjs";
import { checkNetwork, checkDiagnostics, checkDataAndVault, checkRbac, checkIdentities, checkStaticSites } from "./lib/checks-infra.mjs";
import { evaluateWhatIf } from "./lib/whatif.mjs";

export const GATE_SCHEMA = "gate-report/1";

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) args[argv[i].slice(2)] = argv[i + 1]?.startsWith("--") || argv[i + 1] === undefined ? true : argv[++i];
  }
  return args;
}

function hashTree(dir) {
  const out = {};
  const walk = (d) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out[p.slice(dir.length + 1).replace(/\\/g, "/")] = sha256(readFileSync(p));
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
}

export function analyze({ work, manifestPath, deploymentKey, now = new Date() }) {
  const findings = new Findings();
  const problems = [];

  const manifest = readJson(manifestPath, problems);
  if (!manifest || manifest.schemaVersion !== 1) {
    return { fatal: `manifest ${manifestPath} is missing, unreadable or has an unsupported schemaVersion` };
  }
  const deployment = manifest.deployments?.[deploymentKey];
  if (!deployment) return { fatal: `deployment ${JSON.stringify(deploymentKey)} is not in the manifest (known: ${Object.keys(manifest.deployments ?? {}).join(", ")})` };

  // A manifest entry that matches no check silently approves nothing (or the wrong thing): every allowedChanges entry has to
  // be one of the documented shapes (see lib/checks-sites.mjs).
  const shapeProblems = [];
  (deployment.allowedChanges ?? []).forEach((c, i) => {
    const where = `deployments.${deploymentKey}.allowedChanges[${i}]`;
    const known = new Set(["resource", "property", "before", "after", "why", "whatif", "type"]);
    for (const k of Object.keys(c ?? {})) if (!known.has(k)) shapeProblems.push(`${where}: unknown key ${JSON.stringify(k)}`);
    if (typeof c?.resource !== "string" || !c.resource) shapeProblems.push(`${where}: "resource" is required`);
    if (typeof c?.property !== "string" || !c.property) shapeProblems.push(`${where}: "property" is required`);
    if (typeof c?.why !== "string" || c.why.trim().length < 10) shapeProblems.push(`${where}: "why" must explain the approval`);
    if (c?.whatif !== undefined && (c.whatif !== true || typeof c.type !== "string")) shapeProblems.push(`${where}: a what-if entry needs "whatif": true and a "type"`);
    if (c?.whatif === undefined && typeof c?.property === "string" && !/^(setting:\S+|(scm)?ipSecurityRestrictions:.+|siteConfig\.[A-Za-z0-9]+|[A-Za-z][A-Za-z0-9]*)$/.test(c.property)) {
      shapeProblems.push(`${where}: property ${JSON.stringify(c.property)} is none of setting:<NAME>, ipSecurityRestrictions:<rule>, siteConfig.<name> or a site property`);
    }
  });
  if (deployment.mysqlServer !== undefined) {
    const s = deployment.mysqlServer;
    const where = `deployments.${deploymentKey}.mysqlServer`;
    if (typeof s?.name !== "string" || !s.name) shapeProblems.push(`${where}: "name" is required`);
    if (!["existing", "update", "create"].includes(s?.mode)) shapeProblems.push(`${where}: "mode" must be existing, update or create`);
    if (typeof s?.why !== "string" || s.why.trim().length < 10) shapeProblems.push(`${where}: "why" must explain the decision`);
  }
  for (const p of shapeProblems) findings.fail("MANIFEST-ENTRY-SHAPE", "manifest", p);

  const context = readJson(join(work, "context.json"), problems);
  if (!context) return { fatal: "context.json is missing or unreadable" };

  // ---- 1. scope: right tenant, subscription, resource group, template and parameter file ---------------------------
  const expectScope = manifest.scope;
  if (lc(context.account?.subscriptionId) !== lc(expectScope.subscriptionId)) findings.fail("SCOPE-SUBSCRIPTION", "scope", `active subscription is ${context.account?.subscriptionId}, expected ${expectScope.subscriptionId}`);
  if (lc(context.account?.tenantId) !== lc(expectScope.tenantId)) findings.fail("SCOPE-TENANT", "scope", `tenant is ${context.account?.tenantId}, expected ${expectScope.tenantId}`);
  if (lc(context.target?.resourceGroup) !== lc(expectScope.resourceGroup)) findings.fail("SCOPE-RESOURCE-GROUP", "scope", `resource group is ${context.target?.resourceGroup}, expected ${expectScope.resourceGroup}`);
  if (context.target?.resourceGroupExists !== true) findings.fail("SCOPE-RESOURCE-GROUP-MISSING", "scope", "the resource group could not be confirmed to exist");
  if (context.deployment !== deploymentKey) findings.fail("SCOPE-DEPLOYMENT", "scope", `context was produced for ${context.deployment}, not ${deploymentKey}`);
  if (context.files?.template?.path !== deployment.template) findings.fail("SCOPE-TEMPLATE", "scope", `template is ${context.files?.template?.path}, expected ${deployment.template}`);
  if (context.files?.parameters?.path !== deployment.parameters) findings.fail("SCOPE-PARAMETERS", "scope", `parameter file is ${context.files?.parameters?.path}, expected ${deployment.parameters}`);
  if (context.files?.parameters?.using && context.files?.template?.resolvedUsing && context.files.parameters.resolvedUsing !== context.files.template.resolvedUsing) {
    findings.fail("SCOPE-USING", "scope", "the parameter file's `using` does not point at the template that is deployed");
  }
  if (context.mode !== "Incremental") findings.fail("SCOPE-MODE", "scope", `deployment mode is ${context.mode}; only Incremental is allowed (Complete deletes everything the template does not declare)`);
  for (const [step, rc] of Object.entries(context.steps ?? {})) {
    if (rc !== 0) findings.fail("STEP-FAILED", step, `step ${step} did not complete (rc ${rc})`);
  }
  for (const required of ["compile", "lint", "params", "snapshot", "whatif", "live"]) {
    if (!(required in (context.steps ?? {}))) findings.fail("STEP-MISSING", required, `step ${required} did not run`);
  }
  for (const name of context.envReads ?? []) {
    if (!(deployment.secureEnvironment ?? []).includes(name)) findings.fail("ENV-READ-UNDECLARED", name, `the parameter file reads environment variable ${name}, which the manifest does not declare for this deployment`);
  }
  if (context.secureEnvironment?.mode !== "placeholders") findings.fail("SECURE-ENV", "scope", "the gate must evaluate with placeholders for secure parameters, never real secret values");
  for (const name of context.envReads ?? []) {
    if (!(context.secureEnvironment?.placeholders ?? []).includes(name)) findings.fail("SECURE-ENV", name, `environment variable ${name} is read by the parameter file but was not overridden with a placeholder: a real value may have reached the evaluation`);
  }
  // Sensitive parameters the deployment needs must exist in the deploying shell (presence only; never read here). In a local
  // review run (--allow-dirty) this is information, because the reviewer is not the one who deploys.
  const reviewRun = context.git?.requireClean === false;
  for (const name of deployment.secureEnvironment ?? []) {
    const present = context.secureEnvironment?.presence?.[name];
    if (present === true) continue;
    if (reviewRun) findings.info("SECURE-MISSING", name, `${name} is not set in this shell (review run: a deployment would stop here)`);
    else findings.fail("SECURE-MISSING", name, `${name} is not set in the deploying shell: the deployment would stop or set an empty value`);
  }
  if (context.git?.dirty === true && context.git?.requireClean !== false) findings.fail("GIT-DIRTY", "scope", "the working tree has uncommitted changes: the approved digest would not describe a reviewable commit");
  const ageMs = now.getTime() - new Date(context.liveCollectedAt ?? 0).getTime();
  const maxAge = (manifest.maxEvidenceAgeMinutes ?? 30) * 60_000;
  if (!Number.isFinite(ageMs) || ageMs > maxAge || ageMs < -60_000) findings.fail("EVIDENCE-STALE", "live", `live evidence was collected ${Math.round(ageMs / 60000)} minute(s) ago (limit ${manifest.maxEvidenceAgeMinutes ?? 30})`);

  // ---- 2. evidence ------------------------------------------------------------------------------------------------
  const desired = loadDesired(join(work, "snapshot.json"), problems);
  const live = loadLive(join(work, "live"), problems);
  const whatif = readJson(join(work, "whatif.json"), problems);
  if (problems.length > 0) {
    const names = problems.map((p) => `${p.file.replace(/\\/g, "/").split("/").slice(-2).join("/")} (${p.problem})`);
    const shown = names.slice(0, 6).join(", ");
    findings.fail("EVIDENCE-UNREADABLE", `${problems.length} file(s)`, `required evidence is missing, empty or unreadable: ${shown}${names.length > 6 ? ` and ${names.length - 6} more` : ""}`, { files: names });
  }
  if (!desired.ok) findings.fail("EVIDENCE-SNAPSHOT", "snapshot", "the offline evaluation of the template produced no resources");

  // Failed collection calls recorded by collect-live.sh
  for (const call of context.liveCalls ?? []) {
    if (call.required && call.rc !== 0) findings.fail("EVIDENCE-CALL", call.name, `read-only call ${call.name} failed (rc ${call.rc}); missing permissions or an incomplete result`);
  }

  // ---- 3. checks --------------------------------------------------------------------------------------------------
  const ctx = { desired, live, manifest, deployment, whatif, findings, context };
  let whatIfSummary = { noise: {}, counts: {} };
  if (desired.ok) {
    checkSites(ctx);
    checkAppSettings(ctx);
    checkSlotSettings(ctx);
    checkAuthSettings(ctx);
    checkHostBindings(ctx);
    checkPublishingPolicies(ctx);
    checkSlots(ctx);
    checkNetwork(ctx);
    checkDiagnostics(ctx);
    checkDataAndVault(ctx);
    checkRbac(ctx);
    checkIdentities(ctx);
    checkStaticSites(ctx);
  }
  whatIfSummary = evaluateWhatIf(ctx);

  // ---- 4. report --------------------------------------------------------------------------------------------------
  const failures = findings.failures;
  const evidence = {
    manifestSha256: sha256(readFileSync(manifestPath)),
    snapshotSha256: existsSync(join(work, "snapshot.json")) ? sha256(readFileSync(join(work, "snapshot.json"))) : null,
    whatIfSha256: existsSync(join(work, "whatif.json")) ? sha256(readFileSync(join(work, "whatif.json"))) : null,
    liveSha256: sha256(canonical(hashTree(join(work, "live")))),
    liveCollectedAt: context.liveCollectedAt ?? null,
    files: context.files ?? {},
  };
  const residualRisks = [...(manifest.residualRisks ?? []), ...(deployment.residualRisks ?? [])];
  const report = {
    schema: GATE_SCHEMA,
    verdict: failures.length === 0 ? "PASS" : "FAIL",
    deployment: deploymentKey,
    generatedAt: now.toISOString(),
    scope: { subscriptionId: expectScope.subscriptionId, resourceGroup: expectScope.resourceGroup },
    summary: {
      fail: failures.length,
      allowed: findings.items.filter((f) => f.severity === "allowed").length,
      info: findings.items.filter((f) => f.severity === "info").length,
    },
    findings: findings.items,
    verified: findings.stats,
    whatIf: { counts: whatIfSummary.counts, noise: whatIfSummary.noise },
    residualRisks,
    evidence,
  };
  report.digest = sha256(canonical({ verdict: report.verdict, deployment: deploymentKey, evidence, findings: findings.items.map((f) => [f.severity, f.id, f.subject, f.message]) }));
  return { report };
}

export function toMarkdown(report) {
  const lines = [];
  lines.push(`# Safety gate: ${report.verdict} (${report.deployment})`);
  lines.push("");
  lines.push(`- generated: ${report.generatedAt}`);
  lines.push(`- scope: subscription ${report.scope.subscriptionId}, resource group ${report.scope.resourceGroup}`);
  lines.push(`- digest: \`${report.digest}\``);
  lines.push(`- findings: ${report.summary.fail} blocking, ${report.summary.allowed} allowed by manifest, ${report.summary.info} informational`);
  lines.push(`- what-if: ${JSON.stringify(report.whatIf.counts)}`);
  lines.push(`- compared: ${Object.entries(report.verified ?? {}).map(([k, v]) => `${k}=${v}`).join(", ") || "nothing"}`);
  lines.push("");
  const section = (title, severity) => {
    const items = report.findings.filter((f) => f.severity === severity);
    if (items.length === 0) return;
    lines.push(`## ${title} (${items.length})`, "");
    for (const f of items) lines.push(`- **${f.id}** \`${f.subject}\`: ${f.message}`);
    lines.push("");
  };
  section("Blocking", "fail");
  section("Allowed by the manifest (the approver must read these)", "allowed");
  section("Information", "info");
  if (Object.keys(report.whatIf.noise).length) {
    lines.push("## What-if entries treated as platform noise", "");
    for (const [k, v] of Object.entries(report.whatIf.noise)) lines.push(`- ${v} x ${k}`);
    lines.push("");
  }
  if (report.residualRisks.length) {
    lines.push("## Residual risks the gate cannot verify (acknowledge before deploying)", "");
    for (const r of report.residualRisks) lines.push(`- **${r.id}** ${r.text}`);
    lines.push("");
  }
  return lines.join("\n");
}

// CLI ---------------------------------------------------------------------------------------------------------------
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = parseArgs(process.argv.slice(2));
  if (!args.work || !args.manifest || !args.deployment) {
    console.error("usage: analyze.mjs --work <dir> --manifest <file> --deployment <key> [--out report.json] [--md report.md]");
    process.exit(2);
  }
  let result;
  try {
    result = analyze({ work: resolve(args.work), manifestPath: resolve(args.manifest), deploymentKey: args.deployment, now: typeof args.now === "string" ? new Date(args.now) : new Date() });
  } catch (error) {
    console.error(`gate: internal error: ${error.stack ?? error}`);
    process.exit(2);
  }
  if (result.fatal) {
    console.error(`gate: ${result.fatal}`);
    process.exit(2);
  }
  const { report } = result;
  if (args.out && args.out !== true) writeFileSync(args.out, JSON.stringify(report, null, 2));
  const md = toMarkdown(report);
  if (args.md && args.md !== true) writeFileSync(args.md, md);
  console.log(md);
  process.exit(report.verdict === "PASS" ? 0 : 1);
}
