# Avstemming Bicep mot produksjon

Kjente forskjeller mellom Bicep og det som kjører i `rg-invi-prod-swc-001`, med beslutning for hver. Sist avstemt mot live
2026-10-15 (read-only). Gaten (`docs/deploy-safety-gate.md`) kontrollerer at listen under fortsatt stemmer før hver utrulling.

Beslutningene er tre:

* **Behold og deklarer**: verdien finnes live og er ønsket, og skal stå i Bicep slik at en utrulling ikke fjerner den.
* **Fjern senere**: finnes live, er ikke ønsket på sikt, men fjernes bare etter eksplisitt godkjenning (egen, reviewet endring).
* **Utenfor Bicep, med begrunnelse**: forvaltes et annet sted. Gaten overvåker at det ikke endrer seg uten gjennomgang.

## Data API (`main.bicep`)

| ID | Forskjell | Live | Bicep før | Beslutning | Begrunnelse |
|---|---|---|---|---|---|
| D1 | `WebDrafts__RequireCaptcha` | `true` | mangler: ville bli **slettet** | Behold og deklarer (`true`, invariant i manifestet) | kodens standard er `false` (`TurnstileVerifier`): å slette innstillingen ville slått captcha av uten at noen la merke til det |
| D2 | `WebDrafts__TrustCloudflareConnectingIp` | `false` | mangler: ville bli **slettet** | Behold og deklarer (`false`, invariant) | kodens standard er også `false`, så en sletting ville ikke endret atferd; den deklareres for at verdien og avhengigheten (må forbli `false` til origin-lås, IaC-4, er på plass) ikke forsvinner stilltiende |
| D3 | `InviteBaseUrl` | `https://app.cetchapp.com/` | uten `/` | Behold live-verdien (med `/`) | koden trimmer skråstreken; ingen atferdsendring, utrullingen blir en no-op for denne |
| D4 | diagnostikk `inviMetrics` | 4 kategorier | mangler | Behold og deklarer (nøyaktig kopi) | gaten kontrollerer navn og at ingen aktiv kategori mistes |
| D5 | `api.cetchapp.com` + Origin CA-sertifikat | bundet (SNI) | mangler | Behold og deklarer; sertifikatet refereres som `existing` | den private nøkkelen er aldri i Git |
| D6 | `snet-migration-temp` (10.20.4.0/24) | finnes, NIC til `vm-db-migration-temp` | mangler: utrulling ville forsøke å **slette** den | Behold midlertidig (vokter) **og fjern senere etter godkjenning** | tømmes ved å sette `migrationSubnetPrefix = ''` i samme PR som avviklingen |
| D7 | NSG-regel `Allow-Migration-MySQL` (prio 120) | finnes | mangler: ville bli **slettet** | som D6 | |
| (ny) | `PlaceSuggestions__Enabled` | ikke satt | mangler | Deklarer `false` | trygg standard; den nåværende koden kjenner den ikke, så den er uten virkning inntil #7 |

## Admin-appen (`modules/adminapp.bicep`)

| ID | Forskjell | Live | Bicep før | Beslutning | Begrunnelse |
|---|---|---|---|---|---|
| D8a | `DATA_API_BASE_URL_TEST` | Render staging-URL | mangler: ville bli **slettet** | Behold og deklarer | admin-panelets miljøbryter (test/prod); app-repoets README og workflow forventer den på App Service |
| D8b | `DATA_API_ADMIN_KEY_TEST` | Key Vault-referanse, status **Resolved** | mangler: ville bli **slettet** | Behold; deklareres som referanse til `admin-publishing-api-key-test` | ingen hemmelig verdi i Git; referansen løses (til forskjell fra API-enes) |
| D8c | `SCM_DO_BUILD_DURING_DEPLOYMENT` | `false` | mangler: ville bli **slettet** | Behold og deklarer | app-repoets README krever den: pipelinen bygger, plattformen skal ikke |
| D8d | `NEXT_PUBLIC_APP_URL`, `DATA_API_BASE_URL_PROD` | med avsluttende `/` | uten `/` | Behold live-verdiene | appen normaliserer; ingen atferdsendring |
| D9 | rolletildeling på secret `admin-publishing-api-key-test` | håndlaget (`03e6c59f…`) | mangler | Behold; adopteres med navn | én tildeling per prinsipal/rolle/scope; en ny med annet navn feiler (`RoleAssignmentExists`) |

**D8 er avklart**: ingen mal som oppdaterer admin-appen (`adminapp-a`) skal deployes uten disse tre innstillingene. Gaten
håndhever det (`BAG-LIVE-ONLY` og `BAG-REQUIRED-MISSING`).

## Ikke i Bicep (med begrunnelse)

| ID | Hva | Beslutning | Begrunnelse og oppfølging |
|---|---|---|---|
| D10 | 3 GitHub-deployidentiteter, 5 federated credentials, 3 rolletildelinger | **Utenfor Bicep inntil IaC-5** | håndlaget; gaten fanger nye identiteter, credentials, endrede subjects og uvurderte rolletildelinger. De to utdaterte `…-prod-migration`-credentials fjernes etter eksplisitt godkjenning (finding F11) |
| D11 | Auth API tilgangsregler (Allow all) | **Ikke endret her** | IaC-3 (privat endepunkt, deretter nekt), trinnvis og med egen godkjenning |
| – | `vm-db-migration-temp` + disk, NIC, offentlig IP, `nsg-migration-temp`, rolletildeling Secrets Officer (hele vaultet) | **Fjern senere etter godkjenning** | midlertidig; fjernes når dataretting er ferdig. Gaten viser den vault-brede tildelingen som kjent risiko |
| – | `invi-test-resource` (AI-konto, offentlig, nøkkelautentisering) og `swa-cetchapp-web-dev-001` | **Utenfor Bicep, avgjøres** | deklarer med `disableLocalAuth` og RBAC, eller slett |
| – | Secret-literaler i app settings: RevenueCat (2) og Entra-klienthemmelighet | **Behold som secure parameters** | verdiene hentes fra miljøet ved utrulling og står aldri i Git. Å flytte dem til Key Vault-referanse krever at noen oppretter secret og, for API-ene, at koden leser den (`KeyVaultConfiguration.SecretMap`). For admin-appen fungerer Key Vault-referanser |
| – | Key Vault purge protection av | **Fjern senere / egen endring** | kan ikke slås av igjen etter at den er slått på |

## Ting avstemmingen fant som revisjonen ikke hadde

* `deploy.sh` *krevde* de utdaterte `prod-migration`-credentials (trinn 8) og opprettet identiteter og rolletildelinger med CLI.
  Fjernet; se `docs/deploy-safety-gate.md`.
* admin-appens settings-bag og `authsettingsV2` kan ikke evalueres av what-if (betinget på en secure parameter). Gaten
  evaluerer dem i en kopi uten `@secure()` og sammenligner Easy Auth-verdiene mot live (`AUTH-CHANGE`).
* Key Vault-referansene på de to API-ene har status `OtherReasons` (ikke løst av App Service); appene laster secrets selv
  via `KeyVault__Uri`. Admin-appens referanse er `Resolved`.
* what-if viser `netFrameworkVersion: v4.6` og `localMySqlEnabled: false` som «Create» mens live har `v4.0`. Det er
  skjema-standardverdier som what-if legger til; de skrives ikke (ingen virkning på Linux). Gaten behandler dem som støy og
  etterverifiseringen sjekker at live ikke endret seg.
* MySQL-serveren skrives ikke av en vanlig utrulling (`mysqlServerMode = 'existing'`): administratorpassordet, som begge API-ene
  bruker, sendes aldri, og gaten stopper alt som ville gjort det. Tidligere ble det sendt ved hver utrulling. Opprettelse
  (`create`) og endring av serveregenskaper (`update`, uten login og passord) er egne, godkjente trinn. Se `docs/deploy-runbook.md` §2.3.
* PR #12 setter `enableDataApiStagingSlot = true` i `prod.bicepparam`, og en swap ville flyttet slotens settings (uten D1/D2) inn
  i produksjon. Se `docs/staging-slot.md` i utvidelsen av PR #12.
