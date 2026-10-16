# Sjekkliste: utrulling av Studio og onboarding-API-et

Konkret rekkefølge med kommandoer, hvem som kan gjøre hva, forventet resultat, stoppkriterium og tilbakerulling for hvert trinn. Bakgrunn, valg og beviser står i
[`studio-and-onboarding-api.md`](studio-and-onboarding-api.md) (heretter «runbooken»); gaten er beskrevet i [`deploy-safety-gate.md`](deploy-safety-gate.md). Ingenting under er utført
i produksjon. Verdier til hemmeligheter står aldri i denne siden og skal aldri limes inn i chat, Git eller en fil.

Faste navn: abonnement `563af248-8461-42a9-8121-e350e48ca7b6` («CetchApp Prod», tenant `b914fd45-5574-470d-bb21-730850389005`), ressursgruppe `rg-invi-prod-swc-001`, plan `asp-invi-prod-001`,
hvelv `kv-invi-prod-001`. Appene: `app-invi-onboarding-api-prod-001` og `app-invi-studio-prod-001`.

```bash
SUB=563af248-8461-42a9-8121-e350e48ca7b6; RG=rg-invi-prod-swc-001; API=app-invi-onboarding-api-prod-001; STUDIO=app-invi-studio-prod-001
```

## Beslutninger og avklaringer før noe rulles ut

| # | Spørsmål | Hvorfor |
|---|---|---|
| B1 | Hvilken bruker eier aktiviteter som Studio publiserer? Finnes bruker 657 i produksjonens `UserTable`? | `ADMIN_ACTIVITY_CREATOR_ID` er ikke satt i noen app i produksjon; API-et faller tilbake til 657 (testdatabasens skaper). Finnes den ikke, feiler opprettelse av aktiviteter og kamper. Velg en systembruker og sett innstillingen i `prod.onboardingapi.bicepparam` (og Data API-ets), eller bekreft 657 (SQL i trinn 8). |
| B2 | Skal betaling være av ved lansering? | Uten `STRIPE_SECRET_KEY` og pris er alle planer gratis: bookingressurser og klubb-merch kan opprettes og legges ut uten å betale. Stripe legges til senere i parameterfilen (nøkkelen som Key Vault-hemmelighet, `STRIPE_PRICE_ID`/`STRIPE_MERCH_PRICE_ID` som innstilling). `STUDIO_BILLING_PREVIEW` skal aldri settes. |
| B3 | Planen er P0v3 med én instans og minne 55-65 % i snitt (topp 70 %) før disse to appene. P1v3? | Estimert 70-80 % med to apper til (anslag). Kostnadsbeslutning for teamet; mål etter trinn 7 og avgjør før kunder kommer. |
| B4 | Hvem utsteder Studio-innlogginger? | Admin-appen via Data API-ets admin-ruter (`organizers/{id}/account/login`). Uten en aktivert arrangør kan ingen logge inn; Studio har ingen åpen selvbetjent aktivering (selvregistrerte opprettes skjult og aktiveres i admin). |

## Trinn

### 0. PR-ene (team; reviewere med skrivetilgang, repo-administrator til innstillingene)

| Hva | Kontroll |
|---|---|
| Gå gjennom og merge `CetchApp/cetchapp-onboarding-api#1`, `CetchApp/invi-studio#1`, `Sebastiang2/AzurePojects-#16` | alle tre `MERGEABLE`, `build`/`validate` grønne. Studio-`main` får nye commits fra Karl hele tiden: står PR-en som `CONFLICTING`, merge `main` inn i grenen (det er gjort tre ganger) og la CI gå på nytt før merge |
| Repo-administrator: miljøet `production` (påkrevd godkjenner, «Deployment branches: main») og grenbeskyttelse på `main` i begge app-repoene | `gh api repos/CetchApp/<repo>/environments/production --jq '.protection_rules'` viser en `required_reviewers` |

Stopp: en PR som ikke er grønn. Merge deployer ingenting (alle tre workflowene deployer bare ved manuell kjøring på `main`).

### 1. Opprett appene (Contributor på abonnementet; kommandoene skrives i IaC-repoet på `origin/main`, ren arbeidskopi)

```bash
cd AzurePojects- && git fetch origin && git checkout main && git pull --ff-only && git status --short   # tomt
az account show --query "{sub:id, tenant:tenantId}" -o tsv                                              # 563af248-…  b914fd45-…
bash Infrastructure/scripts/deploy.sh --deployment onboardingapi --dry-run
bash Infrastructure/scripts/deploy.sh --deployment onboardingapi        # skriver DEPLOY onboardingapi <12 tegn> når den ber om det
bash Infrastructure/scripts/deploy.sh --deployment studio --dry-run
bash Infrastructure/scripts/deploy.sh --deployment studio
```

Forventet (hver `--dry-run`): `== GATE PASS`, `0 blocking, 9 allowed by manifest`, what-if `{"Ignore":40,"Create":8}`, ingen Modify og ingen Delete. Etter utrullingen:

```bash
for app in $API $STUDIO; do az webapp show -g $RG -n $app --query "{state:state, host:defaultHostName, identity:identity.type}" -o tsv; done   # Running … SystemAssigned
az webapp config show -g $RG -n $STUDIO --query "{route:vnetRouteAllEnabled, cmd:appCommandLine, runtime:linuxFxVersion}" -o tsv   # true  node launch.mjs  NODE|24-lts
az webapp config show -g $RG -n $API    --query "{route:vnetRouteAllEnabled, cmd:appCommandLine, runtime:linuxFxVersion}" -o tsv   # true  dotnet invi-studio-api.dll  DOTNETCORE|10.0
curl -s -o /dev/null -w '%{http_code}\n' https://api.cetchapp.com/api/v1/extras/is-up                                                # 200: Data API upåvirket
```

Stopp: `GATE FAIL` (les `report.md`; ikke omgå), eller at Data API ikke svarer 200 etterpå. Appene har ingen kode ennå: containeren prøver å starte i en løkke og belaster den delte planen. Gjør trinn 2 til 6 i samme arbeidsøkt; må du ta en pause, stopp appene
(`az webapp stop -g $RG -n <app>`) og start dem før trinn 6. Rollback: runbooken §12 punkt 4 (`az webapp delete` for begge, Application Insights og identitetene).

### 2. GitHub-variabler (repo-administrator; verdiene er ikke hemmeligheter)

```bash
for pair in "invi-studio:studio" "cetchapp-onboarding-api:onboarding-api"; do
  repo="${pair%%:*}"; app="${pair##*:}"
  gh variable set AZURE_CLIENT_ID       --repo "CetchApp/$repo" --body "$(az identity show -g $RG -n "id-gha-invi-$app-prod-001" --query clientId -o tsv)"
  gh variable set AZURE_TENANT_ID       --repo "CetchApp/$repo" --body "$(az account show --query tenantId -o tsv)"
  gh variable set AZURE_SUBSCRIPTION_ID --repo "CetchApp/$repo" --body "$(az account show --query id -o tsv)"
done
```

Forventet: `gh variable list --repo CetchApp/invi-studio` viser tre variabler. Rollback: `gh variable delete`.

### 3. Hemmeligheter (person med nettverksvei til hvelvet og Key Vault Secrets Officer)

Hvelvet er privat (`publicNetworkAccess: Disabled`, privat endepunkt `10.20.3.4`). Kommandoene må kjøres fra en vert i VNet-et; i dag er det bare `vm-db-migration-temp` (deallocated; den har offentlig IP og hvelv-bred Secrets Officer, så start den
bare mens du jobber og `az vm deallocate` den rett etterpå). Verdien lages og lagres i samme kommando og vises aldri.

```bash
az keyvault secret set --vault-name kv-invi-prod-001 --name studio-api-key        --value "$(openssl rand -base64 48 | tr -d '\n')" --output none
az keyvault secret set --vault-name kv-invi-prod-001 --name studio-session-secret --value "$(openssl rand -base64 64 | tr -d '\n')" --output none
az keyvault secret show --vault-name kv-invi-prod-001 --name studio-api-key        --query "attributes.enabled" -o tsv   # true
az keyvault secret show --vault-name kv-invi-prod-001 --name studio-session-secret --query "attributes.enabled" -o tsv   # true
az keyvault secret show --vault-name kv-invi-prod-001 --name database-password     --query "attributes.enabled" -o tsv   # true (finnes fra før)
```

Stopp: `Forbidden`/`ForbiddenByRbac` (du mangler rolle; be om den, ikke omgå). Rollback: `az keyvault secret delete` (myk sletting; rens er av).

### 4. Rolletildelinger (team lager PR-en; en Owner kjører utrullingen)

```bash
bash Infrastructure/scripts/preflight.sh --deployment studio-platform-rbac --allow-dirty      # RBAC-NEW viser de seks navnene (guid av appenes prinsipaler)
```

Før de seks navnene inn i `safety/manifest.json` (runbooken §5), merge PR-en, og så, som Owner:

```bash
bash Infrastructure/scripts/deploy.sh --deployment studio-platform-rbac --dry-run
bash Infrastructure/scripts/deploy.sh --deployment studio-platform-rbac
for app in $API $STUDIO; do
  az role assignment list --assignee "$(az webapp identity show -g $RG -n $app --query principalId -o tsv)" --all --query "[].{role:roleDefinitionName, scope:scope}" -o table
done
```

Forventet: Studio har `Key Vault Secrets User` på `…/secrets/studio-api-key` og `…/secrets/studio-session-secret`; API-et på `…/secrets/studio-api-key` og `…/secrets/database-password`; ingen annen rolle. Hver deploy-identitet har `Website Contributor` på
sin egen app. Stopp: `AuthorizationFailed` (du er ikke Owner) eller `ResourceNotFound` (en hemmelighet fra trinn 3 mangler). Rollback: `az role assignment delete --ids <id>` for de seks.

### 5. La rollene nå frem (5-10 minutter), start appene på nytt

Appene leser hemmelighetene én gang, ved oppstart, og prøver ikke igjen. `az webapp restart -g $RG -n $API` og `-n $STUDIO` etter at rollene har vært på plass noen minutter (første kodeutrulling starter dem også på nytt).

### 6. Kode (team; to manuelle kjøringer, API-et først)

```bash
gh workflow run deploy-azure.yml --repo CetchApp/cetchapp-onboarding-api --ref main -f deploy=true    # godkjenn miljøet `production` i GitHub
gh run list --repo CetchApp/cetchapp-onboarding-api --workflow deploy-azure.yml --limit 1
gh workflow run deploy-azure.yml --repo CetchApp/invi-studio --ref main -f deploy=true
gh run list --repo CetchApp/invi-studio --workflow deploy-azure.yml --limit 1
```

Forventet: `build` og `deploy` grønne. API-ets smoke check viser at `/api/health` svarer og at en anonym forespørsel til en vanlig rute avvises (401). Studios viser `/api/health` 200, innloggingssiden 200 og dyp helsesjekk (en advarsel, ikke feil, hvis noe i trinn 3-5 mangler).
Stopp: rød `deploy`. Rollback: tilbakestill commit-en på `main` og kjør workflowen på nytt (pakken beholdes én dag).

**Første oppstart av API-et skriver til produksjonsdatabasen:** `StudioTablesStartup` oppretter `OrganizerMerch` og `OrganizerTicketSale` med `CREATE TABLE IF NOT EXISTS` (bare nye tabeller). De blir stående ved tilbakerulling (`Migrations/*.rollback.sql` i API-repoet).

### 7. Bevis at hemmelighetene er lastet, og at alt henger sammen

```bash
az monitor log-analytics query -w 574a4429-0f3d-4753-9271-693d7874d15d -o table --analytics-query "
  AppServiceConsoleLogs | where TimeGenerated > ago(1h) and ResultDescription startswith 'key-vault:'
  | project TimeGenerated, app = tostring(split(tolower(_ResourceId), '/')[-1]), ResultDescription | order by TimeGenerated desc"
```

Forventet (forsinkelse på noen minutter): `key-vault: loaded 2 secret(s) into the environment: ONBOARDING_DB_PASSWORD, STUDIO_API_KEY` for API-et og `… STUDIO_API_KEY, STUDIO_SESSION_SECRET` for Studio; ingen linje med `could not load`. Hva en feillinje betyr: runbooken §6.

```bash
curl -sS https://$STUDIO.azurewebsites.net/api/health                  # {"status":"ok"}
curl -sS "https://$STUDIO.azurewebsites.net/api/health?deep=1"         # {"status":"ok"}: nøkkelen, API-et, databasen og VenueType virker
curl -sS -o /dev/null -w '%{http_code}\n' https://$API.azurewebsites.net/api/organizers/1       # 401 (aldri 200)
curl -sS -o /dev/null -w '%{http_code}\n' https://$API.azurewebsites.net/api/admin/organizers   # 404
curl -sS -o /dev/null -w '%{http_code}\n' https://api.cetchapp.com/api/v1/extras/is-up          # 200
```

Dyp helsesjekk: `503` med `problem` `not-configured` = en hemmelighet ble ikke lastet (loggen sier hvilken), `api-refused` = Studio og API-et har ulik nøkkel (skal ikke kunne skje: samme hemmelighet), `database` = MySQL svarer ikke fra API-et,
`schema` = `VenueType` eller en kolonne mangler (trinn 8). **Gå ikke videre til DNS før dyp helsesjekk gir 200.** Mål også minnet over en time: `az monitor metrics list --resource <plan-id> --metric MemoryPercentage --interval PT5M --aggregation Average Maximum -o table`
(snitt over 80 % eller topp over 90 % = oppgrader planen, B3).

### 8. Databasen (person med nettverksvei til MySQL; kun lesing)

SQL-en og beviset for hva som allerede er sjekket står i runbooken §11. Forventet: 10 rader fra `VenueType`-spørringen, 10 fra `OrganizersTable`-spørringen, `1` for `UserTable` bruker 657 (eller beslutningen i B1), `2` for `OrganizerMerch`/`OrganizerTicketSale` etter første oppstart.
Mangler kolonner i `VenueType`: en egen, godkjent og additiv databaseendring (eksempel i §11), ikke en del av denne utrullingen.

### 9. DNS (person med tilgang til Namecheap for `invi.lol`)

| Type | Vert | Verdi |
|---|---|---|
| TXT | `asuid.studio` | `az webapp show -g $RG -n $STUDIO --query customDomainVerificationId -o tsv` |
| CNAME | `studio` | `app-invi-studio-prod-001.azurewebsites.net.` |

Rør ikke MX, SPF, `ALIAS @`, `_dnsauth` og `www`. Kontroll: `dig +short CNAME studio.invi.lol` og `dig +short TXT asuid.studio.invi.lol`. Rollback: fjern de to postene.

### 10. Domene og sertifikat (Contributor; når CNAME svarer)

```bash
bash Infrastructure/scripts/deploy.sh --deployment studio-domain --dry-run && bash Infrastructure/scripts/deploy.sh --deployment studio-domain
bash Infrastructure/scripts/deploy.sh --deployment studio-domain-tls --dry-run && bash Infrastructure/scripts/deploy.sh --deployment studio-domain-tls
curl -sS -o /dev/null -w '%{http_code}\n' https://studio.invi.lol/organization/login            # 200 med gyldig sertifikat
curl -sS "https://studio.invi.lol/api/health?deep=1"                                              # {"status":"ok"}
```

Stopp: `EVIDENCE-BINDINGS` (DNS er ikke på plass ennå) eller at sertifikatet ikke utstedes. Rollback: runbooken §12 punkt 2.

### 11. Etterpå

* Studio: logg inn med en eksisterende, aktivert test-arrangør som team eier (ikke registrer en ekte bedrift som røyktest: det oppretter en ekte arrangør).
* Følg Application Insights og `MemoryPercentage` i et døgn; ingen 5xx, ingen `Database connection failed`.
* Fjern `introducedBy` fra de to appene i manifestet; deallocate `vm-db-migration-temp` hvis den ble startet; skriv i README/CHANGELOG hva som er live.
* Stripe, Google Places og OpenAI legges til senere (runbooken §4): navnet inn i `settingSecretNames` i `prod.studio.bicepparam` og `prod.studio-platform-rbac.bicepparam` i samme PR.

## Stoppkriterier (gjelder hele veien)

* Gaten gir `FAIL`, eller `deploy.sh` ber om noe som ikke står her: stopp og les rapporten.
* Data API-et, Auth API-et eller admin-appen endrer oppførsel (svarkoder, restart) etter noe av dette: stopp og rull tilbake det siste trinnet.
* Dyp helsesjekk er ikke `ok` før DNS: ikke åpne `studio.invi.lol`.
* Noen ber om en hemmelighet i chat eller en fil: nei; verdier lages og lagres i samme kommando.
