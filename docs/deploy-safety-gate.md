# Sikker utrulling: preflight-gate for produksjon

Bicep i dette repoet er kilde til sannhet for Azure-infrastrukturen. Denne siden beskriver mekanismen som må bestås før noe
deployes til produksjon, hva den kontrollerer, og, like viktig, hva den **ikke** kan kontrollere.

**Gaten deployer aldri.** Den er read-only og *fail-closed*: alt den ikke kan bekrefte er en feil.

## Slik brukes den

```bash
# 1. Les-bare kontroll (ingen endring i Azure). Exit 0 = PASS, 1 = FAIL, 2 = kunne ikke kjøre (også FAIL).
bash Infrastructure/scripts/preflight.sh --deployment main

# 2. Utrulling: kjører gaten på nytt, viser hva du godkjenner, krever skrevet godkjenning, deployer, verifiserer etterpå.
bash Infrastructure/scripts/deploy.sh --deployment main
```

Nøkler (`--deployment`) står i `Infrastructure/safety/manifest.json`: `main`, `adminapp-a`, `adminapp-b-rbac`,
`adminapp-c-domain`, `swa-web`, `swa-domain-app-cetchapp-com`, `swa-domain-invi-lol`, `swa-domain-www-invi-lol`.

`preflight.sh` bruker `--allow-dirty` for lokal gjennomgang av uforpliktede endringer. En rapport fra den kan ikke brukes til
utrulling: `deploy.sh` kjører sin egen gate og krever ren arbeidskopi på `origin/main`.

## Hva gaten gjør

| # | Krav | Kontroll (ID i rapporten) |
|---|---|---|
| 1 | Riktig tenant, subscription og resource group | `SCOPE-SUBSCRIPTION`, `SCOPE-TENANT`, `SCOPE-RESOURCE-GROUP`; alle kall får `--subscription` eksplisitt, standardabonnementet endres aldri |
| 2 | Riktig template og parameterfil | `SCOPE-TEMPLATE`, `SCOPE-PARAMETERS`, `SCOPE-USING` (parameterfilens `using` peker på malen som deployes); begge hentes fra manifestet, ikke fra omgivelsene |
| 3 | Kompilering og validering | `STEP-FAILED compile/lint/params/snapshot`; lint-feil stopper |
| 4 | what-if | `WHATIF-*`; status må være `Succeeded`, ingen `error`, ikke tomt, og hver deklarert ressurs må finnes i resultatet (`WHATIF-COVERAGE`) |
| 5 | Uventet sletting | `WHATIF-DELETE`, `WHATIF-DELETE-ELEMENT` (element i subnets, securityRules, tilgangsregler ...) |
| 6 | Uventet erstatning / duplikat | `WHATIF-REPLACEMENT-RISK` (uforanderlige egenskaper), `WHATIF-CREATE` (alle opprettelser må stå i manifestet) |
| 7 | Subnett og NSG-regler som kan fjernes | `NET-SUBNET-REMOVED`, `NET-RULE-REMOVED` (sammenligner live med ønsket, uavhengig av what-if), `NET-RULE-CHANGE`, `NET-SUBNET-*` |
| 8 | Fullstendige app setting-navn | `BAG-LIVE-ONLY` (finnes live, mangler i koden: ville blitt slettet), `BAG-NEW`, `BAG-VALUE-CHANGE` |
| 9 | Nødvendige settings | `BAG-REQUIRED-MISSING`, `BAG-INVARIANT` (for eksempel `WebDrafts__Enabled` må være `false`) |
| 10 | Key Vault, identiteter, RBAC | `KV-*`, `RBAC-*` (forutsagt rolletildelingsnavn mot live, `RBAC-UNREVIEWED`), `IDENTITY-*`, `FIC-*` |
| 11 | Domener og sertifikatbindinger bevares | `BINDING-*`, `AUTH-CHANGE` (Easy Auth), `BINDING-UNMANAGED` (informasjon) |
| 12 | Slots og SCM | `SLOT-*`, `SITE-PROP-CHANGE` (inkl. SCM-egenskaper), `ACCESS-RULE-*`, `PUBLISH-POLICY-CHANGE` |
| 13 | Manglende rettigheter, ufullstendige resultater, uavklart drift | `EVIDENCE-*` (manglende/ulesbare data, feilet kall, for gammelt grunnlag), `STEP-*` |
| 14 | Eksplisitt godkjenning | `deploy.sh`: skrevet `DEPLOY <nøkkel> <digest>`; godkjenningen er bundet til digesten av filene og grunnlaget |

### De tre uavhengige signalene

Gaten stoler ikke på ett signal alene:

1. **Ønsket tilstand fra koden**: `az bicep snapshot` evaluerer mal og parametere offline. Secure parameters får plassholdere
   (`__GATE:<MILJØVARIABEL>__`), og `@secure()` fjernes i en *kopi* som bare brukes til evalueringen, slik at hele
   innstillings-bagen (`union()`/`if()`) kan evalueres. Kopien deployes aldri.
2. **Live tilstand**: read-only oppslag (`show`/`list`/`GET`). App settings går rett i en sanitiserer: navn, art og
   ikke-hemmelige verdier beholdes, hemmelige literaler får verken verdi, lengde eller fingeravtrykk. Key Vault-secrets leses
   aldri, heller ikke navnene.
3. **what-if** mot produksjon, redusert i samme pipe til en liste uten hemmeligheter.

Nested objekter (app settings-bag, `securityRules`, `subnets`) erstattes som helhet også i Incremental-modus. Derfor sammenlignes
de element for element mot live, uavhengig av hva what-if rapporterer.

## Manifestet (`Infrastructure/safety/manifest.json`)

Alt gaten godtar som «forventet» står her og gjennomgås som kode. Det som ikke står der, stopper. Endre det i **samme PR** som
endringen som trenger det, med begrunnelse:

* `allowedCreates`: ressurser som får opprettes (for eksempel adopsjon av en håndlaget diagnostikkinnstilling)
* `allowedNewSettings`, `allowedRemovedSettings`, `allowedChanges`: nye/fjernede/endrede app settings og egenskaper, med
  eksakt før- og etter-verdi
* `apps.*.required` og `mustEqual`: innstillinger som alltid må finnes og verdier som må holde
* `noise`: egenskaper plattformen fyller inn som what-if alltid viser (med begrunnelse)
* `rbac.knownAssignments` og `identities.known`: gjennomgåtte rolletildelinger, identiteter og federated credentials. Nye
  tildelinger eller credentials live som ikke står her stopper gaten (`RBAC-UNREVIEWED`, `FIC-UNREVIEWED`)

Manifestet bør kreve review av en som kan Azure-sikkerhet (for eksempel CODEOWNERS).

## Hva gaten ikke kan kontrollere (rest-risiko som godkjenneren må kvittere)

1. **Secure parameters.** MySQL-passord, RevenueCat-nøkler og Entra-klienthemmelighet er ugjennomsiktige: what-if kan ikke
   sammenligne dem, og gaten leser dem aldri. En feil `MYSQL_ADMIN_PASSWORD` *endrer* databasepassordet; en feil RevenueCat-verdi
   bryter kjøp. Verdiene må sjekkes utenfor gaten før godkjenning.
2. **Restart.** Å skrive app settings restarter appene (kort avbrudd).
3. **Key Vault.** Secret-navn og -verdier verifiseres ikke. Key Vault-referansene på de to API-ene vises med status
   `OtherReasons` (ikke løst av App Service); appene laster secrets selv via `KeyVault__Uri`.
4. **what-if-hull.** what-if leser ikke app settings, deler av `siteConfig` og `guid()`-navngitte rolletildelinger. Gaten
   dekker navn og struktur fra live-oppslag, ikke hemmelige verdier.
5. **Utenfor ARM.** Cloudflare, GitHub, Entra-appregistreringer og MySQL-brukere.
6. **Tidsvindu.** Produksjon kan endre seg mellom gate og deploy; grunnlaget utløper etter 30 minutter.
7. **Omgåelse.** Gaten er en prosess, ikke håndhevelse: fem personer er Contributor på abonnementet og kan deploye uten den.
   Håndhevelse krever deployment stacks (`az stack group` med deny-settings) eller Azure Policy, og er ikke aktivert.

## Når gaten feiler

| ID | Betyr | Gjør |
|---|---|---|
| `BAG-LIVE-ONLY` | en live app setting mangler i koden og ville blitt slettet | legg den i Bicep (ikke-hemmelig: verdi; hemmelig: Key Vault-referanse eller secure parameter) eller fjern den bevisst via `allowedRemovedSettings` etter godkjenning |
| `NET-SUBNET-REMOVED` / `NET-RULE-REMOVED` | subnett eller regel finnes live, mangler i koden | deklarer den (midlertidig vokter) eller fjern den som egen, godkjent endring |
| `WHATIF-CREATE` | en ressurs ville blitt opprettet | er det et duplikat? Finnes den allerede under et annet navn? List den i manifestet bare når den er ment |
| `WHATIF-UNEXPECTED-CHANGE` | en endring som ikke er støy | les den; er den ment, legg den i manifestet med begrunnelse |
| `RBAC-NAME-COLLISION` | samme prinsipal/rolle/scope finnes live under et annet navn | adopter navnet (`existingAssignmentNames`), ellers feiler deploy |
| `RBAC-UNREVIEWED` / `FIC-UNREVIEWED` | ny tildeling/credential siden forrige gjennomgang | finn ut hvem og hvorfor; legg den i manifestet eller fjern den |
| `EVIDENCE-*` | manglende rettigheter, feilet kall, ufullstendig eller gammelt grunnlag | rett årsaken og kjør på nytt; aldri tolk det som «ingenting der» |

## Tester

```bash
node --test Infrastructure/scripts/gate/tests/gate.test.mjs     # 54 tester, offline, syntetiske data
bash Infrastructure/scripts/validate.sh                         # bygg, lint og statiske kontroller
```

Hvert farlig scenario (manglende setting, fjernet subnett, endret NSG-regel, slettet ressurs, ufullstendig eller feilet what-if,
manglende rettigheter, gammelt grunnlag, feil abonnement/parameterfil/modus, uvurdert rolletildeling) har en test som må avvise det.

## Endringer i `deploy.sh`

* gaten må bestås, og godkjenningen er skrevet og bundet til digesten
* ingen rå what-if på skjermen (den kunne vise hemmeligheter); kun den reduserte rapporten
* `az bicep build` skriver ikke lenger `main.json` inn i treet; `Infrastructure/main.json` (utdatert siden 2026-09-21) er fjernet
* abonnementet sendes på hvert kall; `az account set` brukes ikke
* trinn 7-9 (opprette GitHub-identiteter, federated credentials og rolletildelinger med CLI) er fjernet. De omgikk Bicep, og
  trinn 8 *krevde* at de utdaterte `prod-migration`-credentials fantes. Identitetene leses og sammenlignes nå av gaten; å
  adoptere dem i Bicep er egen endring (IaC-5)
* alle utrullinger går gjennom samme skript, styrt av manifestet (ikke bare `main`)
