# Sjekkliste: utrulling av Studio og onboarding-API-et, søndag 18. oktober 2026

**Status 2026-10-16 (kveld): ingenting er rullet ut.** Ingen Azure-skriving, ingen DNS-endring, ingen databaseendring, ingen hemmelighet opprettet, ingen merge. De tre PR-ene er åpne og alt under er forberedt og testet lokalt og mot live Azure *kun med lesing*
(gaten: `onboardingapi`, `studio` og `main` PASS). Ingenting under skjer før søndag og uten **eksplisitt, skriftlig godkjenning per trinn** fra Nicolai (og Karl der det står). Verdier til hemmeligheter står aldri i denne siden og skal aldri limes inn i chat, Git eller en fil.

Hver rad har: hvem, kommando, forventet resultat, stoppkriterium og tilbakerulling. Bakgrunn og bevis: [`studio-and-onboarding-api.md`](studio-and-onboarding-api.md) («runbooken»), gaten: [`deploy-safety-gate.md`](deploy-safety-gate.md). Databasen: `docs/launch-database.md` i API-repoet.
Betaling: `docs/billing.md` i Studio-repoet. OrganizerId på tvers av systemene: `docs/organizer-id.md` i API-repoet.

Faste navn: abonnement `563af248-8461-42a9-8121-e350e48ca7b6` («CetchApp Prod», tenant `b914fd45-5574-470d-bb21-730850389005`), ressursgruppe `rg-invi-prod-swc-001`, plan `asp-invi-prod-001`, hvelv `kv-invi-prod-001`, MySQL `mysql-invi-prod-001`,
Log Analytics `574a4429-0f3d-4753-9271-693d7874d15d`. Appene: `app-invi-onboarding-api-prod-001` og `app-invi-studio-prod-001`.

```bash
SUB=563af248-8461-42a9-8121-e350e48ca7b6; RG=rg-invi-prod-swc-001; API=app-invi-onboarding-api-prod-001; STUDIO=app-invi-studio-prod-001; LAW=574a4429-0f3d-4753-9271-693d7874d15d
```

## A. Beslutninger som mangler (Karl) før noe åpnes for kunder

| # | Spørsmål | Hva som skjer uten svar | Blokkerer |
|---|---|---|---|
| D1 | **Skal klubber (typer som ikke er «Venue») vises i appen uten kommende aktiviteter?** I produksjon i dag vises alle aktive arrangører med posisjon. Data API `staging` og appen på `master` (c9f0f64) skjuler klubber mellom arrangementene sine. Karl ønsker at arrangører skal vises uten publiserte aktiviteter | ingenting endres i produksjon nå; regelen kommer med neste Data API-/appslipp. Kodepunkt og testplan: `docs/organizer-id.md` | offentlig lansering for klubber |
| D2 | **Hvilken bruker er `ADMIN_ACTIVITY_CREATOR_ID`?** Admin-repoet sier selv at den er «uavklart»; det skal være en egen, ikke-innloggbar systembruker (ikke en person, aldri Nicolai eller Karl). Finnes den ikke i produksjon må den lages (Karl/DB-person, se `launch-database.md` M5). Jeg setter ikke en ID og gjetter ikke på 657 | API-et nekter å opprette aktiviteter (503) og dyp helsesjekk sier `activity-creator`. Studio kan ikke brukes til kamper/kalender | teknisk og offentlig |
| D3 | **Er Stripe klart søndag?** Krever: live-konto, produktet «Merch» (250 kr/mnd inkl. mva.), webhook, nøkler i hvelvet, innstillinger i Bicep (se `docs/billing.md`, «Opening payment»). Pris-ID-er lager bare Karl | Studio kjører **stengt**: ingen kan betale ennå, og bare fritatte arrangører kan publisere merch/booking. Å lage kontoer, profil og innhold er gratis | offentlig lansering for betalende kunder |
| D4 | **Prisen for booking** («La folk booke!» viser 499 kr som plassholder i `plans.ts`) | booking kan ikke selges; bare fritatte kan slå på bookingressurser | betalende booking |
| D5 | **Listen over tidlige kunder som skal publisere gratis**: `OrganizerId`, navn, hvorfor, evt. sluttdato; og hvem som er «autorisert administrator» som kjører SQL-en (to-personers-regel: Karl godkjenner listen skriftlig) | ingen er fritatt; ingen kan publisere betalt innhold | tidlige kunder |
| D6 | Plan **P1v3**? Minnet er 58-65 % i snitt på P0v3 før disse to appene; anslag 70-80 % etter (gjetning, må måles) | måles i trinn 12 | nei, men mål |
| D7 | `STUDIO_REQUIRE_EMAIL=false` (ingen e-postbekreftelse) ved lansering? Krever Resend (verifisert domene, nøkkel) for `true` | selvregistrerte bekrefter ikke e-post; de er skjult til admin godkjenner | beslutning |
| D8 | Hvem er på vakt søndag, og hvem kan stoppe appene (rollback-myndighet)? | ingen | teknisk |
| D9 | `VenueType`/`OrganizersTable` mangler kolonner (hvis forhåndssjekken viser det): Karl leverer ALTER-setningene. Jeg har ikke gjettet dem | NO-GO til de er på plass | teknisk |
| D10 | Skal Data API-et få `ADMIN_ACTIVITY_CREATOR_ID` i **samme søndag**? (egen endring + omstart av Data API-et) | adminpanelets redaksjonelle publisering gir 503 (som i dag) | nei for Studio |
| D12 | **Ressurstype-katalogen (`ResourceTable`).** Data API-et lager tabellen *tom*, og ingen kode i noe repo fyller den (i testdatabasen ble den fylt for hånd). Uten rader kan ingen legge til en bookingressurs. Studio kjenner disse typene: Bowling lane, Dining table, Private sauna, Tennis court, Individual seat, Gaming station, Pool table, Tennis racket. Karl leverer radene (kategori Space/Seat/Onsite + navn) fra testdatabasen; jeg gjetter ikke kategoriene | booking kan ikke tas i bruk; merch, aktiviteter og profil virker | booking (P13) |
| D11 | **Synlighet i appen.** Publisert merch og «Selges på stadion» vises i Invi-appen først når Data API-et i produksjon har koden (i dag bare på `staging`, commit f934035 og 6a33206) og en appversjon som viser den er ute (appen på `master` har den; butikkene hadde 3.3.22 sist sjekket 2026-10-07). Skal kunder betale for merch før den er synlig? | Studio virker, men en klubb som betaler 250 kr/mnd ser ikke varene i appen | betaling for merch (anbefalt NO-GO til det er synlig) |

## B. GO / NO-GO

### B1. Teknisk utrulling (GO-T): kan vi begynne på trinn 1?

Alle må være oppfylt. Ett «nei» = NO-GO, og ingenting rulles ut.

| # | Krav | Bevis |
|---|---|---|
| T1 | De tre PR-ene er gjennomgått og grønne (`build`/`validate`), ikke `CONFLICTING` | `gh pr view` viser `MERGEABLE`, CI grønn |
| T2 | Effekten av merge er kjent: **merge deployer ingenting** (alle tre workflowene deployer bare ved manuell kjøring på `main` med `deploy=true`, og bare når `AZURE_CLIENT_ID` finnes) | `grep -n workflow_dispatch .github/workflows/deploy-azure.yml` i begge app-repoene; IaC-repoet bygger bare |
| T3 | Gaten gir **PASS** for `onboardingapi` og `studio` (og `main` hvis Data API-endringen i trinn 11 skal inn), sist kjørt på det som faktisk er merget | `bash Infrastructure/scripts/deploy.sh --deployment <navn> --dry-run` |
| T4 | **Databaseforhåndssjekken er kjørt** (kun lesing) og gir ingen uforklart NO-GO: bare de tre tabellene API-et lager mangler, ingen manglende kolonner (ellers M1/M4 først), `OrganizerId` er `int` InnoDB, og `VenueType` og `CategoryTable` har rader | `Migrations/preflight-readonly.sql` (trinn F4) |
| T5 | D2 er avgjort **og verifisert i produksjonsdatabasen** (bruker finnes, ingen passord, ikke administrator, ingen e-post/telefon, eier ingen aktiviteter) | preflight-setning 7 |
| T6 | Backup-punkt notert (tidspunkt UTC) eller tatt (`az mysql flexible-server backup create`) | trinn F5 |
| T7 | Personene finnes: Contributor (kjører Bicep), **Owner** (rolletildelinger), hvelv-nettverksvei + Secrets Officer (hemmeligheter), repo-administrator (miljø og variabler), DB-person (MySQL fra VNet) | navn skrevet inn her før start |
| T8 | Data API-et, Auth API-et og admin-appen svarer normalt (grunnlinje: `curl https://api.cetchapp.com/api/v1/extras/is-up` = 200, ingen 5xx siste time) | notert tidspunkt og resultat |
| T9 | **Eksplisitt skriftlig godkjenning fra Nicolai** for utrullingen (og Karl for D2, D3, D5) | meldingen lagres |

### B2. Offentlig lansering (GO-P): kan `studio.invi.lol` åpnes for kunder?

Alle må være oppfylt etter at GO-T er gjennomført og trinn 1-12 er grønne. Ett «nei» = **NO-GO for kunder** (appene kan likevel stå på standardadressen for intern testing).

| # | Krav | Bevis |
|---|---|---|
| P1 | Dyp helsesjekk er `ok` på standardadressen (nøkkel, API, database, `VenueType`, alle tabeller og kolonner, aktivitetsskaper) | `curl "https://$STUDIO.azurewebsites.net/api/health?deep=1"` = `{"status":"ok"}` |
| P2 | API-loggen har `readiness: ready=true activity-creator=ok(<id>)` og ingen `Could not create` eller `could not load` | trinn 8 |
| P3 | Aktivitetsskaper: en testaktivitet fra testarrangøren har `OrganizerId` = testarrangøren og `CreatorId` = systembrukeren, og kan ses i Data API-et | trinn 10 |
| P4 | **Betaling: ingen publiserer betalt innhold gratis.** Enten (a) Stripe er live og prøvd ende til ende (kjøp → publisering, oppsigelse → nedtak), eller (b) betaling er stengt og dette er bevist: en ikke-fritatt arrangør får 402/503, en fritatt kan publisere | trinn 9-10 |
| P5 | Fritakslisten fra Karl (D5) er lagt inn, hver rad kontrollert (`studio-billing-exemption-admin.sql`, setning 4), og hver tidlig kunde er prøvd | trinn 9 |
| P6 | D1 er avgjort, og appversjonen/Data API-versjonen i produksjon oppfører seg slik Karl vil | notert |
| P7 | Overvåkning: ingen 5xx fra de to appene og ingen `Database connection failed` i én time; minne under 80 % snitt og 90 % topp | trinn 12 |
| P8 | DNS og sertifikat er på plass og gyldig; dyp helsesjekk er `ok` også på `studio.invi.lol` | trinn 13-14 |
| P9 | Rollback er gått gjennom (hvem stopper hva, og hvordan): se E | to personer har lest E |
| P10 | Admin kan godkjenne selvregistrerte og utstede innlogginger (D7: `IsActive=false` til godkjent) | testet med testarrangøren |
| P11 | Karl har sagt ja til å åpne (skriftlig) | meldingen lagres |
| P13 | **Hvis booking tilbys:** ressurstype-katalogen er fylt (D12, preflight-setning 12) og en testarrangør kan legge til et bord og se det i listen | trinn 10 |
| P12 | **Det kunden betaler for er synlig i appen** (D11): produksjons-Data API-et har merch-/billettsalg-koden og appversjonen i butikkene viser den. Ellers tas det ikke betalt for merch (holdes stengt), og kundene får vite det | `gh run list --repo CetchApp/invi-data-api --workflow main_app-invi-data-api-prod-001.yml --limit 1 --json headSha`, så `git merge-base --is-ancestor f934035 <headSha>`; appversjon i butikkene |

## C. Før start (lørdag og søndag morgen; kun lesing og forberedelser)

### F1. PR-ene er ferske

```bash
for pr in "Sebastiang2/AzurePojects-:16" "CetchApp/cetchapp-onboarding-api:1" "CetchApp/invi-studio:1"; do gh pr view "${pr##*:}" --repo "${pr%%:*}" --json state,mergeable,mergeStateStatus,headRefOid -q '[.state,.mergeable,.mergeStateStatus,.headRefOid]|@tsv'; done
```

Forventet `OPEN MERGEABLE CLEAN`. Står en som `CONFLICTING` (Karl pusher til `main` hele dagen): merge `main` inn i grenen (aldri force-push), la CI gå, les diffen mot betalings- og publiseringskoden (`src/lib/billing*.ts`, `src/app/api/organization/merch/publish`, `reservation-config`).

### F2. Merge (gir ingen utrulling)

Repo-administrator/teamet merger de tre PR-ene: API-et og Studio først, så IaC. Kontroll: ingen kjøring av `deploy-azure.yml` har `deploy` (`gh run list --workflow deploy-azure.yml --limit 3`), og `app-invi-*` finnes fortsatt ikke
(`az resource list -g $RG --resource-type Microsoft.Web/sites -o tsv --query "[].name"` viser bare de tre eksisterende). Stopp: en PR som ikke er grønn.

### F3. Gaten (kun lesing, deployer aldri)

```bash
git -C AzurePojects- fetch origin && git -C AzurePojects- checkout main && git -C AzurePojects- pull --ff-only
for d in onboardingapi studio; do bash AzurePojects-/Infrastructure/scripts/deploy.sh --deployment $d --dry-run; done
```

Forventet for hver: `== GATE PASS`, `0 blocking, 9 allowed by manifest`, what-if `Ignore`/`Create`, ingen `Modify` og ingen `Delete`. `studio-platform-rbac` kan ikke vurderes før appene finnes (navnene på rolletildelingene avledes av appenes identiteter): det er forventet og håndteres i trinn 5.

### F4. Databaseforhåndssjekk (kun lesing; DB-person med nettverksvei)

Hvelvet og MySQL er private. Start maskinen bare mens du jobber og deallokér den rett etterpå: `az vm start -g $RG -n vm-db-migration-temp` … `az vm deallocate -g $RG -n vm-db-migration-temp` (offentlig IP; hvelv-bred Secrets Officer, så den skal ikke stå på).

```bash
mysql --host=mysql-invi-prod-001.mysql.database.azure.com --user=inviadmin --password --ssl-mode=REQUIRED --database=invi --table < Migrations/preflight-readonly.sql
```

(Sett `SET @creator = <ID>;` først når D2 er avgjort. Passordet spørres om og står aldri i en fil.) Les hvert resultat mot «Expect»-linjen i filen. Forventet nå: manglende tabeller = akkurat `OrganizerMerch`, `OrganizerTicketSale`, `StudioBillingExemption`;
manglende kolonner = sannsynligvis de fire `ActivityTable.Recurrence*`/`Recurring` (migrering M1), og kanskje noen i `VenueType`/`OrganizersTable` (D9). **Dette er et funn:** produksjonens Data API (`main`) lager ikke gjentakelseskolonnene på `ActivityTable`, og uten dem feiler hver aktivitet Studio lager,
og hele kalenderen. Setning 12 viser katalogene: `VenueType` og `CategoryTable` må ha rader, og `ResourceTable` (ressurstypene) er sannsynligvis tom (D12/M6). Resultatet avgjør om M1/M4/M5/M6 trengs. Stopp: en manglende tabell utenom de tre, `OrganizerId` som ikke er `int` InnoDB, eller en skaper som er en person.

### F5. Backup-punkt

Automatiske daglige sikkerhetskopier finnes (14 dager, ikke geo-redundant, ingen HA; siste ca. kl. 23:16 UTC). Før første databaseendring:

```bash
date -u +%Y-%m-%dT%H:%M:%SZ        # skriv tidspunktet her: gjenopprettingspunktet
az mysql flexible-server backup create -g $RG -n mysql-invi-prod-001 --backup-name pre-studio-20261018
```

Rollback ved gjenoppretting lager en *ny* server og krever nye innstillinger i alle apper: bare reell nød. Normal rollback er per endring (E).

## D. Utrulling (søndag; hvert trinn krever sin egen godkjenning)

### 1. Databasen: M1, evt. M4 og M5 (DB-person; før API-et startes)

Bare det forhåndssjekken viste at trengs. Alt er additivt og kjørt og testet mot en lokal MySQL (`launch-db`, 42 sjekker).

```bash
mysql --host=mysql-invi-prod-001.mysql.database.azure.com --user=inviadmin --password --ssl-mode=REQUIRED --database=invi --table < Migrations/20261018_02_activity_recurrence.sql   # M1: fire kolonner, ALGORITHM=INSTANT, kan kjøres to ganger
```

Så kjør forhåndssjekken på nytt: ingen manglende kolonner. **Stopp** hvis ALTER svarer at INSTANT ikke er mulig (da endres ingenting; ikke fall tilbake til en tabellkopi uten ny avgjørelse), eller hvis noe i Invi-appen eller Data API-et endrer oppførsel (5xx).
Rollback: ingenting (kolonnene er harmløse), eller `…rollback.sql` mens `SELECT COUNT(*) FROM ActivityTable WHERE Recurring=1` er 0. M5 (systembrukeren): `SHOW CREATE TABLE UserTable` først; bruker uten passord, uten e-post; deretter forhåndssjekkens setning 7.

### 2. Aktivitetsskaperen settes i Bicep (PR, etter at D2 og trinn 1 er verifisert)

Egen liten PR med to linjer og begge gater:

```
Infrastructure/environments/prod.onboardingapi.bicepparam   param activityCreatorId = <ID>
Infrastructure/environments/prod.bicepparam                 param dataApiActivityCreatorId = <ID>   (først i trinn 11)
```

Samme bruker i begge. Mal-testene (`Infrastructure/tests/webapp-templates.test.mjs`) sjekker at begge følger parametrene og at Data API-et ellers er uendret (42 innstillinger). Merge før trinn 3.

### 3. Opprett appene (Contributor; kommandoene i IaC-repoet på `origin/main`, ren arbeidskopi)

```bash
cd AzurePojects- && git fetch origin && git checkout main && git pull --ff-only && git status --short   # tomt
az account show --query "{sub:id, tenant:tenantId}" -o tsv                                              # 563af248-…  b914fd45-…
bash Infrastructure/scripts/deploy.sh --deployment onboardingapi --dry-run
bash Infrastructure/scripts/deploy.sh --deployment onboardingapi        # skriver DEPLOY onboardingapi <12 tegn> når den ber om det
bash Infrastructure/scripts/deploy.sh --deployment studio --dry-run
bash Infrastructure/scripts/deploy.sh --deployment studio
```

Forventet (hver `--dry-run`): `== GATE PASS`, `0 blocking, 9 allowed by manifest`, ingen Modify og ingen Delete. Etter utrullingen:

```bash
for app in $API $STUDIO; do az webapp show -g $RG -n $app --query "{state:state, host:defaultHostName, identity:identity.type}" -o tsv; done   # Running … SystemAssigned
az webapp config show -g $RG -n $STUDIO --query "{route:vnetRouteAllEnabled, cmd:appCommandLine, runtime:linuxFxVersion}" -o tsv   # true  node launch.mjs  NODE|24-lts
az webapp config show -g $RG -n $API    --query "{route:vnetRouteAllEnabled, cmd:appCommandLine, runtime:linuxFxVersion}" -o tsv   # true  dotnet invi-studio-api.dll  DOTNETCORE|10.0
curl -s -o /dev/null -w '%{http_code}\n' https://api.cetchapp.com/api/v1/extras/is-up                                                # 200: Data API upåvirket
```

Stopp: `GATE FAIL` (les `report.md`; ikke omgå), eller at Data API ikke svarer 200 etterpå. Appene har ingen kode ennå: containeren prøver å starte i en løkke og belaster den delte planen. Gjør trinn 4 til 8 i samme arbeidsøkt; må du ta en pause, stopp appene
(`az webapp stop -g $RG -n <app>`) og start dem før trinn 7. Rollback: runbooken §12 punkt 4 (`az webapp delete` for begge, Application Insights og identitetene).

### 4. GitHub-variabler (repo-administrator; verdiene er ikke hemmeligheter)

```bash
for pair in "invi-studio:studio" "cetchapp-onboarding-api:onboarding-api"; do
  repo="${pair%%:*}"; app="${pair##*:}"
  gh variable set AZURE_CLIENT_ID       --repo "CetchApp/$repo" --body "$(az identity show -g $RG -n "id-gha-invi-$app-prod-001" --query clientId -o tsv)"
  gh variable set AZURE_TENANT_ID       --repo "CetchApp/$repo" --body "$(az account show --query tenantId -o tsv)"
  gh variable set AZURE_SUBSCRIPTION_ID --repo "CetchApp/$repo" --body "$(az account show --query id -o tsv)"
done
```

Repo-administrator oppretter også miljøet `production` (påkrevd godkjenner, «Deployment branches: main») og grenbeskyttelse på `main` i begge app-repoene: `gh api repos/CetchApp/<repo>/environments/production --jq '.protection_rules'` viser en `required_reviewers`.
Forventet: `gh variable list --repo CetchApp/invi-studio` viser tre variabler. Rollback: `gh variable delete`.

### 5. Hemmeligheter (person med nettverksvei til hvelvet og Key Vault Secrets Officer)

Verdien lages og lagres i samme kommando og vises aldri (hvelvet er privat: `publicNetworkAccess: Disabled`, privat endepunkt `10.20.3.4`; kjør fra VNet-maskinen som i F4).

```bash
az keyvault secret set --vault-name kv-invi-prod-001 --name studio-api-key        --value "$(openssl rand -base64 48 | tr -d '\n')" --output none
az keyvault secret set --vault-name kv-invi-prod-001 --name studio-session-secret --value "$(openssl rand -base64 64 | tr -d '\n')" --output none
az keyvault secret show --vault-name kv-invi-prod-001 --name studio-api-key        --query "attributes.enabled" -o tsv   # true
az keyvault secret show --vault-name kv-invi-prod-001 --name studio-session-secret --query "attributes.enabled" -o tsv   # true
az keyvault secret show --vault-name kv-invi-prod-001 --name database-password     --query "attributes.enabled" -o tsv   # true (finnes fra før)
```

Stripe-hemmelighetene (`stripe-secret-key`, `stripe-webhook-secret`) lages **bare** hvis D3 er ja, og da i en egen IaC-endring (navn i `settingSecretNames` og rollene i `studio-platform-rbac`). Stopp: `Forbidden`/`ForbiddenByRbac` (du mangler rolle; be om den, ikke omgå).
Rollback: `az keyvault secret delete` (myk sletting; rens er av).

### 6. Rolletildelinger (team lager PR-en; en Owner kjører utrullingen)

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

Forventet: Studio har `Key Vault Secrets User` på `…/secrets/studio-api-key` og `…/secrets/studio-session-secret`; API-et på `…/secrets/studio-api-key` og `…/secrets/database-password`; ingen annen rolle. Hver deploy-identitet har `Website Contributor` på sin egen app.
Stopp: `AuthorizationFailed` (du er ikke Owner) eller `ResourceNotFound` (en hemmelighet fra trinn 5 mangler). Rollback: `az role assignment delete --ids <id>` for de seks. Vent 5-10 minutter før trinn 7.

### 7. Kode: API-et først, så Studio (team; manuelle kjøringer)

Appene leser hemmelighetene én gang, ved oppstart: start dem på nytt etter at rollene har satt seg (`az webapp restart -g $RG -n $API`, `-n $STUDIO`).

```bash
gh workflow run deploy-azure.yml --repo CetchApp/cetchapp-onboarding-api --ref main -f deploy=true    # godkjenn miljøet `production` i GitHub
gh run list --repo CetchApp/cetchapp-onboarding-api --workflow deploy-azure.yml --limit 1
# vent på grønn deploy og trinn 8 for API-et; så:
gh workflow run deploy-azure.yml --repo CetchApp/invi-studio --ref main -f deploy=true
gh run list --repo CetchApp/invi-studio --workflow deploy-azure.yml --limit 1
```

Forventet: `build` og `deploy` grønne; API-ets smoke check viser at `/api/health` svarer og at en anonym forespørsel avvises (401). Studios viser `/api/health` 200, innloggingssiden 200 og dyp helsesjekk. Stopp: rød `deploy`. Feiler `build` på «artifact storage quota», er organisasjonens lagringskvote for Actions brukt opp.
Rollback: tilbakestill commit-en på `main` og kjør workflowen på nytt (pakken beholdes én dag), eller `az webapp stop`.

**Første oppstart av API-et skriver til produksjonsdatabasen, og dette er hele listen** (`launch-database.md` §1):
`CREATE TABLE IF NOT EXISTS` for `OrganizerMerch`, `OrganizerTicketSale` og `StudioBillingExemption` (bare nye tabeller; ingen endring av eksisterende), og deretter, hvert minutt, `UPDATE ActivityTable SET IsEnded …` for utløpte arrangør-aktiviteter. De tre tabellene blir stående ved tilbakerulling.

### 8. Bevis at alt henger sammen (kun lesing)

```bash
az monitor log-analytics query -w $LAW -o table --analytics-query "
  AppServiceConsoleLogs | where TimeGenerated > ago(1h) and (ResultDescription startswith 'key-vault:' or ResultDescription has_any ('readiness:', 'Could not create'))
  | project TimeGenerated, app = tostring(split(tolower(_ResourceId), '/')[-1]), ResultDescription | order by TimeGenerated desc"
```

Forventet (forsinkelse på noen minutter): `key-vault: loaded 2 secret(s) into the environment: ONBOARDING_DB_PASSWORD, STUDIO_API_KEY` for API-et og `… STUDIO_API_KEY, STUDIO_SESSION_SECRET` for Studio; **`readiness: ready=true activity-creator=ok(<ID>) missing-tables=[] missing-columns=[] empty-tables=[] warnings=[]`** (en advarsel om `ResourceTable` betyr bare at booking ikke kan tas i bruk ennå, D12);
ingen `could not load` og ingen `Could not create`. Ikke `ready=true` eller en advarsel (`can log in`, `administrator`): les linjen, rett det den sier (manglende kolonne → M1/M4; `activity-creator=not-configured` → trinn 2), og start API-et på nytt. **Gå ikke videre til DNS før dyp helsesjekk gir 200.**

```bash
curl -sS https://$STUDIO.azurewebsites.net/api/health                  # {"status":"ok"}
curl -sS "https://$STUDIO.azurewebsites.net/api/health?deep=1"         # {"status":"ok"}: nøkkel, API, database, VenueType og alt Studio trenger
curl -sS -o /dev/null -w '%{http_code}\n' https://$API.azurewebsites.net/api/organizers/1       # 401 (aldri 200)
curl -sS -o /dev/null -w '%{http_code}\n' https://$API.azurewebsites.net/api/admin/organizers   # 404
curl -sS -o /dev/null -w '%{http_code}\n' https://$API.azurewebsites.net/api/studio/billing/exemption   # 401: også fritaksruten trenger nøkkelen
curl -sS -o /dev/null -w '%{http_code}\n' https://api.cetchapp.com/api/v1/extras/is-up          # 200
```

Dyp helsesjekk `503` med `problem`: `not-configured` (en hemmelighet ble ikke lastet), `api-refused` (ulik nøkkel), `database` (MySQL svarer ikke, eller kontrollen feilet), `schema` (en tabell eller kolonne mangler: `readiness:`-linjen sier hvilken),
`activity-creator` (ingen brukbar skaper: trinn 2/D2).

### 9. Fritak for tidlige kunder (DB-person etter Karls skriftlige liste, D5)

For hver arrangør i listen, med `Migrations/studio-billing-exemption-admin.sql` (setning for setning; plassholderne må byttes ut før noe skriver): finn arrangøren (1), gi fritaket (2), vis hvem som er fritatt nå (4). Kontroller at hver rad er riktig arrangør (navn og by).
Fritaket gjelder én `OrganizerId` og alt som er betalt; det kan trekkes tilbake (3) og slår inn/ut innen ett minutt uten omstart. Historikk (5) beholdes.

### 10. Integrasjonstest (testarrangør som teamet eier; ikke en ekte bedrift)

Forutsetning: en testarrangør med Studio-innlogging, opprettet i adminpanelet, **skjult** (`IsActive=0`). Sjekkene i to nivåer:

*Uten offentlig virkning* (kjør alle):

| Sjekk | Forventet |
|---|---|
| Logg inn i Studio på standardadressen; fyll ut profil | virker; testarrangøren vises ikke i appen (skjult) |
| Lag et utkast til en aktivitet; valider | OK; utkastet er bare synlig i Studio |
| Åpne ressurssiden og legg til et bord (hvis booking tilbys) | ressurstypene finnes (D12); ressursen lagres **av** |
| Legg til en merch-vare; sett opp en bookingressurs | lagres; vare **ikke** utgitt; ressurs **av** |
| Trykk «Legg ut for brukere!» / «La folk booke!» som **ikke fritatt** | 402 og betalingsdialog; «Betal» gir 503 «Betaling er ikke åpnet ennå» (stengt) eller Stripe (D3) |
| Fritak: DB-personen gir testarrangøren fritak (trinn 9), vent ett minutt | publisering virker; trekk fritaket tilbake, vent ett minutt: nektes igjen |
| Prøv å åpne en annen arrangørs ressurs/aktivitet-ID i adressen | 404, aldri data |
| Aktivitetsskaper: `SELECT ActivityId, OrganizerId, CreatorId FROM ActivityTable WHERE OrganizerId=<TEST> ORDER BY ActivityId DESC LIMIT 5;` | etter punktet under: `OrganizerId`=test, `CreatorId`=systembrukeren |

*Med offentlig virkning* (én kontrollert test, krever egen godkjenning): publiser **én** aktivitet med navnet «TEST (slettes)» langt frem i tid fra testarrangøren, kontroller raden over og at Data API-et ser den, og **avlys og slett** den i Studio innen fem minutter. Stopp og rull tilbake hvis noe annet enn raden over vises i appen.

Er D3 ja: kjøp merch med et ekte kort på en ikke-fritatt testarrangør, publiser, si opp, og se at varene tas ned (webhook), og at gjentatte hendelser ikke gjør noe to ganger.

### 11. (Eget vindu, valgfritt for Studio) Data API: aktivitetsskaper

Krever D10 og at samme ID er satt i `prod.bicepparam`. `bash Infrastructure/scripts/deploy.sh --deployment main --dry-run` skal gi PASS og vise **én** endret innstilling (`ADMIN_ACTIVITY_CREATOR_ID`) på Data API-et; en endret innstilling **omstarter Data API-et** (kort avbrudd for appen):
kjør bare på et rolig tidspunkt og følg `https://api.cetchapp.com/api/v1/extras/is-up` til 200. Rollback: sett `dataApiActivityCreatorId = 0` og kjør `main` igjen.

### 12. Overvåkning og kapasitet (én time, før DNS)

```bash
az monitor log-analytics query -w $LAW -o table --analytics-query "AppServiceHTTPLogs | where TimeGenerated > ago(1h) and ScStatus >= 500 | summarize n = count() by CsHost"        # ingen rader
az monitor log-analytics query -w $LAW -o table --analytics-query "AppServiceConsoleLogs | where TimeGenerated > ago(1h) and ResultDescription has_any ('Database connection failed','Unhandled exception','could not load')"   # ingen rader
az monitor metrics list --resource $(az appservice plan show -g $RG -n asp-invi-prod-001 --query id -o tsv) --metric MemoryPercentage --interval PT5M --aggregation Average Maximum -o table
```

Snitt over 80 % eller topp over 90 % = oppgrader planen (D6) før kunder kommer. Følg også at `ActivityEndStatusService` ikke logger feil hvert minutt (da mangler M1).

### 13. DNS (person med tilgang til Namecheap for `invi.lol`)

| Type | Vert | Verdi |
|---|---|---|
| TXT | `asuid.studio` | `az webapp show -g $RG -n $STUDIO --query customDomainVerificationId -o tsv` |
| CNAME | `studio` | `app-invi-studio-prod-001.azurewebsites.net.` |

Rør ikke MX, SPF, `ALIAS @`, `_dnsauth` og `www`. Kontroll: `dig +short CNAME studio.invi.lol` og `dig +short TXT asuid.studio.invi.lol`. Rollback: fjern de to postene. **Kun når GO-P er oppfylt, unntatt P8.**

### 14. Domene og sertifikat (Contributor; når CNAME svarer)

```bash
bash Infrastructure/scripts/deploy.sh --deployment studio-domain --dry-run && bash Infrastructure/scripts/deploy.sh --deployment studio-domain
bash Infrastructure/scripts/deploy.sh --deployment studio-domain-tls --dry-run && bash Infrastructure/scripts/deploy.sh --deployment studio-domain-tls
curl -sS -o /dev/null -w '%{http_code}\n' https://studio.invi.lol/organization/login            # 200 med gyldig sertifikat
curl -sS "https://studio.invi.lol/api/health?deep=1"                                              # {"status":"ok"}
```

Stopp: `EVIDENCE-BINDINGS` (DNS er ikke på plass ennå) eller at sertifikatet ikke utstedes. Rollback: runbooken §12 punkt 2.

### 15. Åpne for kunder

Når P1-P11 er oppfylt og Karl har sagt ja: del adressen. Etterpå: følg Application Insights og minnet i et døgn; fjern `introducedBy` fra de to appene i manifestet; deallocate `vm-db-migration-temp` hvis den ble startet; skriv i README/CHANGELOG hva som er live.
Stripe, Google Places og OpenAI legges til senere (runbooken §4): navnet inn i `settingSecretNames` i `prod.studio.bicepparam` og `prod.studio-platform-rbac.bicepparam` i samme PR.

## E. Rollback

| Hva | Hvordan | Merknad |
|---|---|---|
| **Nødbrems for kunder** | `az webapp stop -g $RG -n $STUDIO` (og/eller fjern de to DNS-postene) | Data API-et, appen og Auth API-et avhenger ikke av Studio. Stopp av API-et: `az webapp stop -g $RG -n $API` (stopper også `ActivityEndStatusService`) |
| Noen publiserer noe de ikke skulle | `UPDATE StudioBillingExemption SET RevokedAtUtc=UTC_TIMESTAMP(6), RevokedBy='…' WHERE OrganizerId=<ID> AND RevokedAtUtc IS NULL` (setning 3), og Studio nekter innen ett minutt | allerede utgitte varer tas ned av webhook (Stripe) eller av `POST /api/studio/merch/unpublish` for arrangøren |
| Feil aktivitetsskaper | fjern `activityCreatorId` i Bicep (0) og kjør `onboardingapi` på nytt: API-et nekter å lage aktiviteter igjen | aktiviteter som allerede er laget beholder skaperen sin |
| Databasen | M1: ingenting, eller `20261018_02_activity_recurrence.rollback.sql` mens ingen serie finnes; de tre nye tabellene: `…rollback.sql` | gjenoppretting til backup-punktet (F5) er siste utvei og lager en ny server |
| Koden | tilbakestill commit på `main`, kjør workflowen på nytt (pakken beholdes en dag) | |
| Appene | runbooken §12 punkt 4 | |
| Data API-innstillingen | `dataApiActivityCreatorId = 0`, kjør `main` | omstart av Data API-et |

## Stoppkriterier (gjelder hele veien)

* Gaten gir `FAIL`, eller `deploy.sh` ber om noe som ikke står her: stopp og les rapporten.
* Data API-et, Auth API-et eller admin-appen endrer oppførsel (svarkoder, restart) etter noe av dette: stopp og rull tilbake det siste trinnet.
* Dyp helsesjekk er ikke `ok` før DNS: ikke åpne `studio.invi.lol`.
* En arrangør kan publisere betalt innhold uten betaling eller fritak, eller en fritatt arrangør mister det: stopp og bruk nødbremsen.
* Noen ber om en hemmelighet i chat eller en fil: nei; verdier lages og lagres i samme kommando.
