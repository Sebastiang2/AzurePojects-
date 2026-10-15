// Network, diagnostics, data, vault, RBAC and static web app checks (desired vs live).
import { lc, tail, isExpression, sameSet, globToRegExp, PLACEHOLDER } from "./util.mjs";
import { armGuid } from "./guid.mjs";

const present = (v) => v !== undefined && v !== null && v !== "";
/** "Sweden Central" (display name) and "swedencentral" (name) are the same region. */
const normalizeLocation = (v) => (v === undefined || v === null ? undefined : lc(String(v).replace(/\s+/g, "")));
const list = (single, plural) => [...new Set([single, ...(plural ?? [])].filter(present).map(String))].sort();

function createAllowed(ctx, type, name) {
  return (ctx.deployment.allowedCreates ?? []).find((c) => lc(c.type) === lc(type) && globToRegExp(c.name).test(name));
}

// ---------------------------------------------------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------------------------------------------------
export function checkNetwork(ctx) {
  const { desired, live, manifest, findings } = ctx;

  for (const vnet of desired.ofType("Microsoft.Network/virtualNetworks")) {
    const wantSubnets = vnet.properties?.subnets;
    const liveVnet = live.vnet && lc(live.vnet.name) === lc(vnet.name) ? live.vnet : undefined;
    if (!liveVnet) {
      const exists = live.resources.some((r) => lc(r.type) === "microsoft.network/virtualnetworks" && lc(r.name) === lc(vnet.name));
      if (exists) findings.fail("EVIDENCE-VNET", vnet.name, "the virtual network exists but its live configuration could not be read");
      continue;
    }
    const wantSpace = vnet.properties?.addressSpace?.addressPrefixes;
    if (wantSpace && !sameSet(wantSpace, liveVnet.addressSpace?.addressPrefixes)) {
      findings.fail("NET-ADDRESS-SPACE", vnet.name, "address space would change");
    }
    if (!Array.isArray(wantSubnets)) {
      findings.info("NET-SUBNETS-UNMANAGED", vnet.name, "the template declares no subnets array for this network");
      continue;
    }
    const defaults = manifest.defaults?.subnet ?? {};
    for (const ls of live.subnets) {
      if (!wantSubnets.some((s) => lc(s.name) === lc(ls.name))) {
        const inUse = (ls.ipConfigurations ?? []).length + (ls.privateEndpoints ?? []).length;
        findings.fail("NET-SUBNET-REMOVED", `${vnet.name}/${ls.name}`, `subnet exists live and is not declared: the deployment would try to delete it (${inUse} attached interface(s))`, { subnet: ls.name });
      }
    }
    findings.count("subnetsLive", live.subnets.length);
    for (const ws of wantSubnets) {
      findings.count("subnetsDeclared");
      const name = `${vnet.name}/${ws.name}`;
      const ls = live.subnets.find((s) => lc(s.name) === lc(ws.name));
      if (!ls) {
        const a = createAllowed(ctx, "Microsoft.Network/virtualNetworks/subnets", ws.name);
        if (a) findings.allowed("NET-SUBNET-NEW", name, `subnet is created (${a.why ?? "listed in manifest"})`);
        else findings.fail("NET-SUBNET-NEW", name, "a subnet would be created and is not listed in the manifest");
        continue;
      }
      const p = ws.properties ?? {};
      if (p.addressPrefix !== undefined && p.addressPrefix !== ls.addressPrefix) findings.fail("NET-SUBNET-PREFIX", name, `address prefix would change from ${ls.addressPrefix} to ${p.addressPrefix}`);
      const wantNsg = p.networkSecurityGroup?.id;
      if (wantNsg === undefined && ls.networkSecurityGroup) findings.fail("NET-SUBNET-NSG-DETACHED", name, "the live NSG association would be removed");
      else if (wantNsg !== undefined && !isExpression(wantNsg) && lc(tail(wantNsg)) !== lc(tail(ls.networkSecurityGroup?.id))) findings.fail("NET-SUBNET-NSG-CHANGE", name, "the NSG association would change");
      const wantDelegations = (p.delegations ?? []).map((d) => d.properties?.serviceName ?? d.serviceName);
      const liveDelegations = (ls.delegations ?? []).map((d) => d.serviceName ?? d.properties?.serviceName);
      if (!sameSet(wantDelegations, liveDelegations)) findings.fail("NET-SUBNET-DELEGATION", name, `delegations would change from [${liveDelegations}] to [${wantDelegations}]`);
      const wantEndpoints = (p.serviceEndpoints ?? []).map((e) => e.service);
      const liveEndpoints = (ls.serviceEndpoints ?? []).map((e) => e.service);
      if (!sameSet(wantEndpoints, liveEndpoints)) findings.fail("NET-SUBNET-ENDPOINTS", name, `service endpoints would change from [${liveEndpoints}] to [${wantEndpoints}]`);
      const wantPe = p.privateEndpointNetworkPolicies ?? defaults.privateEndpointNetworkPolicies ?? "Disabled";
      if (lc(wantPe) !== lc(ls.privateEndpointNetworkPolicies)) findings.fail("NET-SUBNET-PE-POLICY", name, `privateEndpointNetworkPolicies would change from ${ls.privateEndpointNetworkPolicies} to ${wantPe}`);
      const wantPls = p.privateLinkServiceNetworkPolicies ?? defaults.privateLinkServiceNetworkPolicies ?? "Enabled";
      if (lc(wantPls) !== lc(ls.privateLinkServiceNetworkPolicies)) findings.fail("NET-SUBNET-PLS-POLICY", name, `privateLinkServiceNetworkPolicies would change from ${ls.privateLinkServiceNetworkPolicies} to ${wantPls}`);
      if (ls.routeTable && !p.routeTable) findings.fail("NET-SUBNET-ROUTE-DETACHED", name, "the route table would be detached");
      if (ls.natGateway && !p.natGateway) findings.fail("NET-SUBNET-NAT-DETACHED", name, "the NAT gateway would be detached");
    }
  }

  for (const nsg of desired.ofType("Microsoft.Network/networkSecurityGroups")) {
    const liveNsg = live.nsgs.find((n) => lc(n.name) === lc(nsg.name));
    if (!liveNsg) {
      const a = createAllowed(ctx, "Microsoft.Network/networkSecurityGroups", nsg.name);
      if (a) findings.allowed("NET-NSG-NEW", nsg.name, `NSG is created (${a.why ?? "listed in manifest"})`);
      else findings.fail("NET-NSG-NEW", nsg.name, "an NSG would be created and is not listed in the manifest");
      continue;
    }
    const want = nsg.properties?.securityRules;
    if (!Array.isArray(want)) {
      findings.info("NET-NSG-UNMANAGED", nsg.name, "the template declares no security rules array");
      continue;
    }
    for (const r of liveNsg.securityRules ?? []) {
      if (!want.some((w) => lc(w.name) === lc(r.name))) {
        findings.fail("NET-RULE-REMOVED", `${nsg.name}/${r.name}`, `rule exists live (priority ${r.priority}, ${r.direction} ${r.access}) and is not declared: a deployment would delete it`, { rule: r.name });
      }
    }
    findings.count("nsgRulesLive", (liveNsg.securityRules ?? []).length);
    for (const w of want) {
      findings.count("nsgRulesDeclared");
      const name = `${nsg.name}/${w.name}`;
      const l = (liveNsg.securityRules ?? []).find((r) => lc(r.name) === lc(w.name));
      if (!l) {
        const a = createAllowed(ctx, "Microsoft.Network/networkSecurityGroups/securityRules", name);
        if (a) findings.allowed("NET-RULE-NEW", name, `rule is created (${a.why ?? "listed in manifest"})`);
        else findings.fail("NET-RULE-NEW", name, "a security rule would be created and is not listed in the manifest");
        continue;
      }
      const p = w.properties ?? {};
      const fields = {
        priority: [p.priority, l.priority],
        direction: [lc(p.direction), lc(l.direction)],
        access: [lc(p.access), lc(l.access)],
        protocol: [lc(p.protocol), lc(l.protocol)],
        source: [list(p.sourceAddressPrefix, p.sourceAddressPrefixes), list(l.sourceAddressPrefix, l.sourceAddressPrefixes)],
        destination: [list(p.destinationAddressPrefix, p.destinationAddressPrefixes), list(l.destinationAddressPrefix, l.destinationAddressPrefixes)],
        sourcePort: [list(p.sourcePortRange, p.sourcePortRanges), list(l.sourcePortRange, l.sourcePortRanges)],
        destinationPort: [list(p.destinationPortRange, p.destinationPortRanges), list(l.destinationPortRange, l.destinationPortRanges)],
      };
      for (const [field, [wantValue, liveValue]] of Object.entries(fields)) {
        if (JSON.stringify(wantValue) !== JSON.stringify(liveValue)) {
          findings.fail("NET-RULE-CHANGE", name, `${field} would change from ${JSON.stringify(liveValue)} to ${JSON.stringify(wantValue)}`, { rule: w.name, field });
        }
      }
    }
  }

  for (const zone of desired.ofType("Microsoft.Network/privateDnsZones")) {
    if (!live.privateDnsZones.some((z) => lc(z.name) === lc(zone.name))) {
      const exists = live.resources.some((r) => lc(r.type) === "microsoft.network/privatednszones" && lc(r.name) === lc(zone.name));
      if (exists) findings.fail("EVIDENCE-DNS", zone.name, "the private DNS zone exists but could not be read");
      else if (!createAllowed(ctx, "Microsoft.Network/privateDnsZones", zone.name)) findings.fail("NET-DNS-NEW", zone.name, "a private DNS zone would be created and is not listed in the manifest");
    }
  }
  for (const link of desired.ofType("Microsoft.Network/privateDnsZones/virtualNetworkLinks")) {
    const [zone, linkName] = String(link.name).split("/");
    const l = (live.dnsLinks[zone] ?? []).find((x) => lc(x.name) === lc(linkName));
    if (!l) {
      if (!createAllowed(ctx, "Microsoft.Network/privateDnsZones/virtualNetworkLinks", link.name)) findings.fail("NET-DNS-LINK-NEW", link.name, "a DNS zone link would be created and is not listed in the manifest");
      continue;
    }
    const p = link.properties ?? {};
    if (p.registrationEnabled !== undefined && p.registrationEnabled !== l.registrationEnabled) findings.fail("NET-DNS-LINK-CHANGE", link.name, "registrationEnabled would change");
    if (p.virtualNetwork?.id && lc(tail(p.virtualNetwork.id)) !== lc(tail(l.virtualNetwork?.id))) findings.fail("NET-DNS-LINK-CHANGE", link.name, "the linked virtual network would change");
  }
  for (const pe of desired.ofType("Microsoft.Network/privateEndpoints")) {
    const l = live.privateEndpoints.find((x) => lc(x.name) === lc(pe.name));
    if (!l) {
      const a = createAllowed(ctx, "Microsoft.Network/privateEndpoints", pe.name);
      if (a) findings.allowed("NET-PE-NEW", pe.name, `private endpoint is created (${a.why ?? "listed in manifest"})`);
      else findings.fail("NET-PE-NEW", pe.name, "a private endpoint would be created and is not listed in the manifest");
      continue;
    }
    const p = pe.properties ?? {};
    if (p.subnet?.id && lc(tail(p.subnet.id)) !== lc(tail(l.subnet?.id))) findings.fail("NET-PE-CHANGE", pe.name, "the private endpoint would move to another subnet");
    const wantTarget = p.privateLinkServiceConnections?.[0]?.properties?.privateLinkServiceId;
    const liveTarget = (l.privateLinkServiceConnections ?? [])[0]?.privateLinkServiceId;
    if (wantTarget && liveTarget && lc(tail(wantTarget)) !== lc(tail(liveTarget))) findings.fail("NET-PE-CHANGE", pe.name, "the private endpoint would target another resource");
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Diagnostic settings
// ---------------------------------------------------------------------------------------------------------------------
function liveDiagFor(live, scopeId) {
  const parts = String(scopeId).split("/").filter(Boolean);
  const idx = parts.findIndex((p) => lc(p) === "providers");
  const scopeSegments = parts.slice(idx + 1); // Microsoft.Web/sites/<name>[/slots/<slot>]
  const type = lc(scopeSegments.slice(0, 2).join("/"));
  const name = scopeSegments[2];
  if (scopeSegments.length > 3) return undefined; // slot or other nested scope: evidence not collected
  const unwrap = (d) => (Array.isArray(d) ? d : Array.isArray(d?.value) ? d.value : undefined);
  if (type === "microsoft.web/sites") return unwrap(live.apps[name]?.diag);
  if (type === "microsoft.keyvault/vaults") return unwrap(live.keyvaultDiag);
  if (type === "microsoft.dbformysql/flexibleservers") return unwrap(live.mysqlDiag);
  return undefined;
}

export function checkDiagnostics(ctx) {
  const { desired, live, findings } = ctx;
  for (const diag of desired.ofType("Microsoft.Insights/diagnosticSettings")) {
    const id = String(diag.id ?? "");
    const scopeId = id.split("/providers/Microsoft.Insights/")[0];
    const existing = liveDiagFor(live, scopeId);
    if (!existing) {
      if (createAllowed(ctx, "Microsoft.Insights/diagnosticSettings", diag.name)) findings.allowed("DIAG-NEW", diag.name, "diagnostic setting is created (listed in manifest)");
      else findings.fail("DIAG-EVIDENCE", diag.name, `no live diagnostic settings evidence for ${tail(scopeId, 3)}; creation is not listed in the manifest`);
      continue;
    }
    const current = existing.find((s) => lc(s.name) === lc(diag.name));
    if (!current) {
      if (createAllowed(ctx, "Microsoft.Insights/diagnosticSettings", diag.name)) findings.allowed("DIAG-NEW", diag.name, "diagnostic setting is created (listed in manifest)");
      else findings.fail("DIAG-NEW", diag.name, "a diagnostic setting would be created and is not listed in the manifest");
      continue;
    }
    findings.count("diagnosticSettings");
    const wantEnabled = (diag.properties?.logs ?? []).filter((l) => l.enabled).map((l) => l.category ?? l.categoryGroup);
    const liveEnabled = (current.logs ?? []).filter((l) => l.enabled).map((l) => l.category ?? l.categoryGroup);
    for (const c of liveEnabled) {
      if (!wantEnabled.map(lc).includes(lc(c))) findings.fail("DIAG-CATEGORY-LOST", diag.name, `log category ${c} is enabled live and would stop`, { category: c });
    }
    for (const c of wantEnabled) {
      if (!liveEnabled.map(lc).includes(lc(c))) findings.info("DIAG-CATEGORY-ADDED", diag.name, `log category ${c} would be enabled (more ingestion)`, { category: c });
    }
    const liveMetrics = (current.metrics ?? []).filter((m) => m.enabled).map((m) => m.category);
    const wantMetrics = (diag.properties?.metrics ?? []).filter((m) => m.enabled).map((m) => m.category);
    for (const c of liveMetrics) if (!wantMetrics.map(lc).includes(lc(c))) findings.fail("DIAG-METRIC-LOST", diag.name, `metric category ${c} is enabled live and would stop`);
    const wantWs = diag.properties?.workspaceId;
    if (wantWs && !isExpression(wantWs) && lc(tail(wantWs)) !== lc(tail(current.workspaceId))) findings.fail("DIAG-WORKSPACE-CHANGE", diag.name, "the destination workspace would change");
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// MySQL, Key Vault, App Service plan
// ---------------------------------------------------------------------------------------------------------------------
function compareDeclared(ctx, subject, pairs, idPrefix) {
  for (const [label, wantValue, liveValue] of pairs) {
    if (wantValue === undefined || isExpression(wantValue)) continue;
    const same = typeof wantValue === "string" ? lc(wantValue) === lc(liveValue) : wantValue === liveValue;
    if (!same) ctx.findings.fail(`${idPrefix}-CHANGE`, subject, `${label} would change from ${JSON.stringify(liveValue)} to ${JSON.stringify(wantValue)}`, { property: label });
  }
}

export function checkDataAndVault(ctx) {
  const { desired, live, findings } = ctx;

  for (const server of desired.ofType("Microsoft.DBforMySQL/flexibleServers")) {
    const l = live.mysql && lc(live.mysql.name) === lc(server.name) ? live.mysql : undefined;
    if (!l) {
      const exists = live.resources.some((r) => lc(r.type) === "microsoft.dbformysql/flexibleservers" && lc(r.name) === lc(server.name));
      if (exists) findings.fail("EVIDENCE-MYSQL", server.name, "the server exists but its live configuration could not be read");
      continue;
    }
    const p = server.properties ?? {};
    compareDeclared(ctx, server.name, [
      ["version", p.version, l.version],
      ["sku.name", server.sku?.name, l.sku?.name],
      ["sku.tier", server.sku?.tier, l.sku?.tier],
      ["administratorLogin", p.administratorLogin, l.administratorLogin],
      ["network.publicNetworkAccess", p.network?.publicNetworkAccess, l.network?.publicNetworkAccess],
      ["network.delegatedSubnet", p.network?.delegatedSubnetResourceId ? tail(p.network.delegatedSubnetResourceId) : undefined, tail(l.network?.delegatedSubnetResourceId)],
      ["network.privateDnsZone", p.network?.privateDnsZoneResourceId ? tail(p.network.privateDnsZoneResourceId) : undefined, tail(l.network?.privateDnsZoneResourceId)],
      ["backup.backupRetentionDays", p.backup?.backupRetentionDays, l.backup?.backupRetentionDays],
      ["backup.geoRedundantBackup", p.backup?.geoRedundantBackup, l.backup?.geoRedundantBackup],
      ["highAvailability.mode", p.highAvailability?.mode, l.highAvailability?.mode],
      ["storage.storageSizeGB", p.storage?.storageSizeGB, l.storage?.storageSizeGb ?? l.storage?.storageSizeGB],
      ["storage.autoGrow", p.storage?.autoGrow, l.storage?.autoGrow],
      ["storage.autoIoScaling", p.storage?.autoIoScaling, l.storage?.autoIoScaling],
      ["location", normalizeLocation(server.location), normalizeLocation(l.location)],
    ], "DB");
    findings.count("databaseServers");
    const pw = p.administratorLoginPassword;
    const feed = PLACEHOLDER.exec(typeof pw === "string" ? pw : "");
    if (!feed) findings.fail("DB-PASSWORD-LITERAL", server.name, "the administrator password is not fed from a secure parameter");
    else findings.info("DB-PASSWORD-OPAQUE", server.name, `the administrator password is set from ${feed[1]} on every deployment; it cannot be compared and a wrong value changes the live password. Verify the value out-of-band before deploying.`);
  }

  for (const vault of desired.ofType("Microsoft.KeyVault/vaults")) {
    const l = live.keyvault && lc(live.keyvault.name) === lc(vault.name) ? live.keyvault : undefined;
    if (!l) {
      const exists = live.resources.some((r) => lc(r.type) === "microsoft.keyvault/vaults" && lc(r.name) === lc(vault.name));
      if (exists) findings.fail("EVIDENCE-KEYVAULT", vault.name, "the vault exists but its live configuration could not be read");
      continue;
    }
    const p = vault.properties ?? {};
    const lp = l.properties ?? {};
    findings.count("keyVaults");
    compareDeclared(ctx, vault.name, [
      ["enableRbacAuthorization", p.enableRbacAuthorization, lp.enableRbacAuthorization],
      ["enableSoftDelete", p.enableSoftDelete, lp.enableSoftDelete],
      ["softDeleteRetentionInDays", p.softDeleteRetentionInDays, lp.softDeleteRetentionInDays],
      ["publicNetworkAccess", p.publicNetworkAccess, lp.publicNetworkAccess],
      ["sku.name", p.sku?.name, lp.sku?.name],
    ], "KV");
    if (Array.isArray(p.accessPolicies) && p.accessPolicies.length < (lp.accessPolicies ?? []).length) findings.fail("KV-ACCESS-POLICY-REMOVED", vault.name, "access policies exist live and the template declares fewer");
    if (p.networkAcls === undefined && lp.networkAcls && lp.networkAcls.defaultAction && lc(lp.networkAcls.defaultAction) !== "allow") {
      findings.info("KV-NETWORK-ACLS", vault.name, "live network ACLs exist and are not declared (not changed by the template)");
    }
    if (lp.enablePurgeProtection !== true) findings.info("KV-PURGE-PROTECTION-OFF", vault.name, "purge protection is off live (cannot be switched off again once on; a separate approved change)");
  }

  for (const plan of desired.ofType("Microsoft.Web/serverfarms")) {
    const l = live.plan && lc(live.plan.name) === lc(plan.name) ? live.plan : undefined;
    if (!l) continue;
    // sku.tier is derived from sku.name and reported differently by the platform (P0v3 -> "Premium0V3"): name is what counts.
    const lp = l.properties ?? {};
    compareDeclared(ctx, plan.name, [
      ["sku.name", plan.sku?.name, l.sku?.name],
      ["reserved", plan.properties?.reserved, lp.reserved ?? l.reserved],
      ["perSiteScaling", plan.properties?.perSiteScaling, lp.perSiteScaling ?? l.perSiteScaling],
      ["zoneRedundant", plan.properties?.zoneRedundant, lp.zoneRedundant ?? l.zoneRedundant ?? false],
      ["kind", plan.kind, l.kind],
      ["location", normalizeLocation(plan.location), normalizeLocation(l.location)],
    ], "PLAN");
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// RBAC
// ---------------------------------------------------------------------------------------------------------------------
function parseRoleAssignment(ra, live) {
  const id = String(ra.id ?? "");
  // The id is either an extensionResourceId(...) expression (name computed with guid()) or a plain path (literal name).
  const scope = isExpression(id)
    ? /extensionResourceId\('([^']+)'/.exec(id)?.[1]
    : id.split(/\/providers\/Microsoft\.Authorization\/roleAssignments\//i)[0] || undefined;
  const roleDefinitionId = ra.properties?.roleDefinitionId;
  const principalExpr = ra.properties?.principalId;
  let principalId;
  const site = /reference\('[^']*\/sites\/([^'\/]+)'/.exec(String(principalExpr))?.[1];
  const slotMatch = /reference\('[^']*\/sites\/([^'\/]+)\/slots\/([^'\/]+)'/.exec(String(principalExpr));
  if (site) principalId = live.apps[site]?.show?.identity?.principalId;
  else if (!isExpression(principalExpr)) principalId = principalExpr;
  let name = ra.name;
  let nameKnown = true;
  if (isExpression(name)) {
    const args = /^\[guid\((.*)\)\]$/s.exec(name)?.[1];
    const quoted = args ? [...args.matchAll(/'([^']*)'/g)].map((m) => m[1]) : [];
    // guid('<scope>', reference('<site>', ...).identity.principalId, '<role definition>')
    if (args && scope && roleDefinitionId && principalId && quoted[0] === scope) {
      name = armGuid(scope, principalId, quoted[quoted.length - 1]);
    } else {
      nameKnown = false;
    }
  }
  return { name, nameKnown, scope, roleDefinitionId, principalId, site, slot: slotMatch ? `${slotMatch[1]}/${slotMatch[2]}` : undefined };
}

export function checkRbac(ctx) {
  const { desired, live, manifest, findings } = ctx;
  for (const ra of desired.ofType("Microsoft.Authorization/roleAssignments")) {
    const info = parseRoleAssignment(ra, live);
    const label = info.nameKnown ? info.name : "(name not predictable)";
    if (info.slot) {
      // The principal is the identity of a deployment slot. It does not exist until the slot does, so the assignment cannot be
      // predicted: it is accepted only together with the slot, which is itself an explicit manifest decision.
      const slotAllowed = (ctx.deployment.allowedCreates ?? []).some((c) => lc(c.type) === "microsoft.web/sites/slots" && lc(c.name) === lc(info.slot));
      if (slotAllowed) findings.allowed("RBAC-NEW-SLOT-IDENTITY", info.slot, `role assignment for the new slot identity on ${tail(info.scope ?? "", 2)} (follows the slot approved in the manifest)`);
      else findings.fail("RBAC-NEW-SLOT-IDENTITY", info.slot, `a role assignment for the identity of slot ${info.slot} would be created, and that slot is not approved in the manifest`);
      continue;
    }
    if (!info.nameKnown || !info.scope || !info.principalId) {
      findings.fail("RBAC-UNVERIFIABLE", label, "the role assignment's name, scope or principal could not be predicted offline; verify it by hand");
      continue;
    }
    const sameScope = live.roleAssignments.filter((r) => lc(r.scope) === lc(info.scope));
    const byName = sameScope.find((r) => lc(r.name) === lc(info.name));
    const samePrincipalRole = sameScope.find((r) => lc(r.principalId) === lc(info.principalId) && lc(tail(r.roleDefinitionId)) === lc(tail(info.roleDefinitionId)));
    findings.count("roleAssignmentsPredicted");
    if (byName) {
      if (lc(byName.principalId) !== lc(info.principalId) || lc(tail(byName.roleDefinitionId)) !== lc(tail(info.roleDefinitionId))) {
        findings.fail("RBAC-MISMATCH", info.name, "a live assignment with this name has another principal or role (a deployment would fail)");
      } else {
        findings.info("RBAC-OK", info.name, `${tail(info.roleDefinitionId)} for ${info.site ?? info.principalId} on ${tail(info.scope, 2)} exists live under the predicted name`);
      }
    } else if (samePrincipalRole) {
      findings.fail("RBAC-NAME-COLLISION", info.name, `the same principal, role and scope exist live under the name ${samePrincipalRole.name}: the deployment would fail with RoleAssignmentExists unless that name is adopted`);
    } else if (createAllowed(ctx, "Microsoft.Authorization/roleAssignments", info.name)) {
      findings.allowed("RBAC-NEW", info.name, "role assignment is created (listed in manifest)");
    } else {
      findings.fail("RBAC-NEW", info.name, `a role assignment (${tail(info.roleDefinitionId)} on ${tail(info.scope, 2)}) would be created and is not listed in the manifest`);
    }
  }

  // Unreviewed live assignments: anything privileged at or below the resource group that the manifest does not know.
  const known = new Set((manifest.rbac?.knownAssignments ?? []).map((a) => lc(a.name)));
  const watched = new Set((manifest.rbac?.watchedRoles ?? []).map(lc));
  const rg = lc(`/resourceGroups/${manifest.scope?.resourceGroup}`);
  for (const r of live.roleAssignments) {
    if (!watched.has("*") && !watched.has(lc(r.roleDefinitionName))) continue;
    if (!lc(r.scope).includes(rg) && !/^\/subscriptions\/[^/]+$/i.test(r.scope)) continue;
    findings.count("roleAssignmentsReviewed");
    if (known.has(lc(r.name))) continue;
    findings.fail("RBAC-UNREVIEWED", r.name, `${r.roleDefinitionName} for ${r.principalName ?? r.principalId} on ${r.scope.replace(/^\/subscriptions\/[^/]+/i, "")} is not in the reviewed list`);
  }
  const liveNames = new Set(live.roleAssignments.map((r) => lc(r.name)));
  for (const a of manifest.rbac?.knownAssignments ?? []) {
    if (a.expected !== false && !liveNames.has(lc(a.name))) findings.info("RBAC-KNOWN-MISSING", a.name, `reviewed assignment ${a.role} ${a.description ?? ""} no longer exists live`);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Identities and federated credentials (GitHub OIDC): a new credential is a new way into the subscription
// ---------------------------------------------------------------------------------------------------------------------
export function checkIdentities(ctx) {
  const { live, manifest, findings } = ctx;
  const known = manifest.identities?.known ?? {};
  for (const identity of live.identities) {
    findings.count("identitiesReviewed");
    const reviewed = known[identity.name];
    if (!reviewed) {
      findings.fail("IDENTITY-UNREVIEWED", identity.name, "user-assigned identity is not in the reviewed list");
      continue;
    }
    const credentials = live.fics[identity.name] ?? [];
    for (const c of credentials) {
      const k = reviewed[c.name];
      if (!k) findings.fail("FIC-UNREVIEWED", `${identity.name}/${c.name}`, `federated credential (subject ${c.subject}) is not in the reviewed list`);
      else if (k.subject !== c.subject) findings.fail("FIC-SUBJECT-CHANGED", `${identity.name}/${c.name}`, `subject changed from ${k.subject} to ${c.subject}`);
      else if (/^stale/.test(k.status ?? "")) findings.info("FIC-STALE", `${identity.name}/${c.name}`, k.status);
    }
    for (const name of Object.keys(reviewed)) {
      if (!credentials.some((c) => c.name === name)) findings.info("FIC-MISSING", `${identity.name}/${name}`, "reviewed credential no longer exists live");
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Static web apps and custom domains
// ---------------------------------------------------------------------------------------------------------------------
export function checkStaticSites(ctx) {
  const { desired, live, findings } = ctx;
  for (const swa of desired.ofType("Microsoft.Web/staticSites")) {
    const l = live.staticSites.find((s) => lc(s.name) === lc(swa.name));
    if (!l) {
      if (!createAllowed(ctx, "Microsoft.Web/staticSites", swa.name)) findings.fail("SWA-NEW", swa.name, "a static web app would be created and is not listed in the manifest");
      continue;
    }
    if (swa.sku?.name && lc(swa.sku.name) !== lc(l.sku?.name)) findings.fail("SWA-SKU-CHANGE", swa.name, `sku would change from ${l.sku?.name} to ${swa.sku.name}`);
  }
  for (const domain of desired.ofType("Microsoft.Web/staticSites/customDomains")) {
    const [site, host] = String(domain.name).split("/");
    const live_ = (live.swaHostnames[site] ?? []).find((h) => lc(h.name) === lc(host));
    if (!live_) {
      if (!createAllowed(ctx, "Microsoft.Web/staticSites/customDomains", domain.name)) findings.fail("SWA-DOMAIN-NEW", domain.name, "a custom domain would be bound and is not listed in the manifest");
    }
  }
}
