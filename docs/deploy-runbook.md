# Runbook: utrulling og rollback av Bicep mot produksjon (CetchApp/Invi)

Gjelder utrulling `main` (`Infrastructure/main.bicep` + `environments/prod.bicepparam`): nett, MySQL, Key Vault, overvåking, App
Service-planen, Data API, Auth API og rolletildelingene til de to API-ene. Admin App, Static Web Apps og domenene er egne
utrullinger (`adminapp-a`, `adminapp-b-rbac`, `adminapp-c-domain`, `swa-*`) og er **ikke** med i `main`; se «Admin App» nederst.

Mekanismen bak (gaten, manifestet, hva den ikke kan sjekke) står i [`deploy-safety-gate.md`](deploy-safety-gate.md). Denne
siden er sjekklisten rundt den. Hvert trinn som endrer produksjon krever egen, skriftlig godkjenning; trinn merket
**(skriver)** endrer Azure, alt annet er read-only.

## 0. Forutsetninger

| Krav | Hvordan det sjekkes |
|---|---|
| PR #13 (gate), #14 (IaC-1), #15 (IaC-2) er merget **i denne rekkefølgen** | `git log --oneline origin/main -5` |
| Arbeidskopien er `origin/main`, ren | `git fetch origin && git status --short && git rev-parse HEAD origin/main` (skal gi to like hasher) |
| PR #12 (staging-slot) er **ikke** merget, eller er merget sammen med IaC-6 (slot av som standard) | `grep -n enableDataApiStagingSlot Infrastructure/environments/prod.bicepparam` finnes ikke / er `false` |
| Du er innlogget på riktig tenant | `az account show --query "{sub:id, tenant:tenantId}" -o json` gir `563af248-…` / `b914fd45-…` |
| Terminal: Git Bash (mintty) eller Linux-skall. Godkjenningen skrives for hånd, så `deploy.sh` nekter å kjøre uten terminal | |
| Ingen annen utrulling pågår: ingen kjørende GitHub Actions-jobb for Data API/Auth API, ingen annen `az deployment` | `gh run list -R CetchApp/invi-data-api --status in_progress` |

Merge-rekkefølgen er bindende. #13 først: da går alle utrullinger gjennom gaten, og den avviser den uavstemte malen. #14 og #15
etterpå gjør `main` og `adminapp-a` utrullbare. Merges #14 uten #13, ligger en avstemt mal bak det gamle `deploy.sh` uten gate.

## 1. Hva utrullingen `main` gjør

Gaten stopper ved sletting, så hver endring under er en **opprettelse eller overskriving**. Den eksakte listen står i rapporten
fra gaten (`report.md`); dette er forventningen.

| Ressurs | Endring | Effekt |
|---|---|---|
| `app-invi-data-api-prod-001` appsettings | skrives som helhet; én ny setting, `PlaceSuggestions__Enabled=false`; alle andre navn og verdier uendret | **restart** av Data API |
| `app-invi-auth-api-prod-001` appsettings | skrives som helhet; ingen endring i navn eller verdier | **restart** av Auth API |
| `Microsoft.Insights/diagnosticSettings inviMetrics` (Data API) | adopteres (identisk kopi av den håndlagde) | ingen |
| `mysql-invi-prod-001` | **skrives ikke** (modus `existing`): serveren er ikke med i utrullingen, bare databasen `invi` deklareres på nytt (NoChange) | ingen: administratorpassordet (`inviadmin`, som begge API-ene bruker) og alle serveregenskaper blir som de er |
| Application Insights ×2, PE-DNS-gruppe, nettverkskonfigurasjon for de to appene | overskrives med identiske verdier (støy i what-if) | ingen |
| RBAC (`rbac`-modulen, 2 tildelinger) | `guid()`-navn som what-if ikke kan vise; gaten har regnet navnene og sammenlignet med live | ingen: eksisterende tildelinger |
| Nett (subnett, NSG, regler), Key Vault, plan, domener, sertifikater | uendret; migreringssubnettet og regelen `Allow-Migration-MySQL` er deklarert som midlertidig vokter | ingen |

**Det som ikke endres:** WebDrafts (`WebDrafts__Enabled=false`, `RequireCaptcha=true`, `TrustCloudflareConnectingIp=false`
beholdes), Auth API-ets nettverksåpning (egen endring: IaC-3), Cloudflare, Admin App, frontend.

## 2. Før utrulling (read-only unntatt der det står)

### 2.1 Koden

```bash
node --test Infrastructure/scripts/gate/tests/*.test.mjs      # alle skal bestå
bash Infrastructure/scripts/validate.sh                       # bygg, lint, statiske kontroller: 0 feil
```

### 2.2 Grunnlag

Registrer *før* endringen (brukes til sammenligning etterpå), uten å lime inn verdier noe sted:

```bash
SUB=563af248-8461-42a9-8121-e350e48ca7b6; RG=rg-invi-prod-swc-001
for app in app-invi-data-api-prod-001 app-invi-auth-api-prod-001; do
  az webapp show -g $RG -n $app --subscription $SUB --query "{state:state, host:defaultHostName}" -o tsv
  az webapp config appsettings list -g $RG -n $app --subscription $SUB --query "length(@)" -o tsv   # antall settings
done
curl -s -o /dev/null -w "%{http_code} is-up\n"            https://api.cetchapp.com/api/v1/extras/is-up              # 200
curl -s -o /dev/null -w "%{http_code} get-categories\n"   https://api.cetchapp.com/api/v1/extras/get-categories     # 200
curl -s -o /dev/null -w "%{http_code} overview (no token)\n" https://api.cetchapp.com/api/v1/activities/overview    # 401
curl -s -o /dev/null -w "%{http_code} web-drafts (off)\n" https://api.cetchapp.com/api/v1/web-drafts/categories     # 404
```

Forventet: Data API 41 settings, Auth API 16; svarkodene i kommentarene. Avvik nå betyr at produksjon har endret seg siden
gjennomgangen: stopp og kjør gaten på nytt, den viser driften.

### 2.3 Hemmelige parametere (gaten kan ikke sjekke disse)

Gaten kjører med plassholdere og ser aldri en hemmelighet. Et feil innhold i skallet blir *skrevet til produksjon*.

```bash
read -rs REVENUECAT_SECRET_API_KEY;            export REVENUECAT_SECRET_API_KEY            # lim inn fra passordbehandler, vises ikke
read -rs REVENUECAT_WEBHOOK_AUTHORIZATION;     export REVENUECAT_WEBHOOK_AUTHORIZATION

bash Infrastructure/scripts/verify-secure-parameters.sh --deployment main
```

Skriptet leser live-verdien til RevenueCat-settingene (read-only) og skriver bare `MATCH` / `MISMATCH`, aldri verdi, hash eller
lengde. Alt annet enn `MATCH` (eller `NEW`) stopper utrullingen.

**MySQL-administratorpassordet er ikke en del av en vanlig utrulling.** Begge API-ene kobler til som administratoren
(`inviadmin`), og Azure returnerer aldri passordet, så det kan ikke sammenlignes. Derfor skrives serveren ikke:
`prod.bicepparam` har `mysqlServerMode = 'existing'`, parameterfilen leser ikke passordet fra miljøet, og manifestet
(`deployments.main.mysqlServer.mode`) sier det samme. Gaten stopper hvis malen likevel skriver serveren
(`DB-SERVER-WRITTEN`), sender et passord til en server som finnes (`DB-PASSWORD-RESENT`) eller bruker et uttrykk den ikke kan
evaluere (`DB-PASSWORD-UNVERIFIABLE`). Du trenger ikke `MYSQL_ADMIN_PASSWORD` i skallet, og skal ikke ha det der.

Modusene (`modules/mysql.bicep`, API 2024-12-30):

| Modus | Hva som skrives | Når | Godkjenning |
|---|---|---|---|
| `existing` (standard) | ingenting på serveren | alle vanlige utrullinger | manifestet |
| `update` | serveren **uten** `administratorLogin` og `administratorLoginPassword` | bevisst endring av serveregenskaper (lagring, backup, versjon) | egen PR + manifestet (`mode: update`, `touches`); Azure sier ikke hva en PUT uten passord gjør med en eksisterende server, så det står som rest-risiko i rapporten |
| `create` | serveren med login og passord fra `MYSQL_ADMIN_PASSWORD` | ny server (nytt miljø, gjenoppretting) | egen PR + manifestet; gaten stopper den hvis serveren finnes (`DB-CREATE-ON-EXISTING`) |

Å opprette en ny server er en egen, gjennomgått endring: sett `mysqlServerMode = 'create'` og
`param mysqlAdminPassword = readEnvironmentVariable('MYSQL_ADMIN_PASSWORD')` i parameterfilen, `mode: create` og
`MYSQL_ADMIN_PASSWORD` i `secureEnvironment` i manifestet, og tillat opprettelsen (`allowedCreates`). Passordet står aldri i
filen. Etter opprettelsen settes modus tilbake til `existing` i neste PR.

### 2.4 Sikkerhetskopi (skriver kun lokalt)

```bash
umask 077; BACKUP="$HOME/invi-pre-deploy-$(date -u +%Y%m%dT%H%MZ)"; mkdir -p "$BACKUP"
for app in app-invi-data-api-prod-001 app-invi-auth-api-prod-001; do
  az webapp config appsettings list -g $RG -n $app --subscription $SUB -o json > "$BACKUP/$app.appsettings.json"
done
az mysql flexible-server show -g $RG -n mysql-invi-prod-001 --subscription $SUB --query "backup" -o json   # PITR-vinduet
```

`$BACKUP` inneholder **hemmelige verdier** (RevenueCat-literaler, kobling til Key Vault). Den skal ikke ut av maskinen, ikke i
repoet, ikke i chat, og slettes etter at utrullingen er verifisert (§4). Den er kun til gjenoppretting av settings (§5.2).

MySQL: automatisk sikkerhetskopi og point-in-time-restore skal finnes og dekke tiden fra nå. I dag er det
`backupRetentionDays: 14` og `geoRedundantBackup: Disabled` (det samme som koden deklarerer); avvik fra det er drift. En manuell
sikkerhetskopi (`az mysql flexible-server backup create`) er valgfri og er en **skriver**. Lagringen er 32 GB med auto-grow:
vokser databasen forbi det koden deklarerer, ville en utrulling prøve å krympe lagringen, og gaten stopper på forskjellen
(`DB-CHANGE`) i stedet for at ARM feiler midtveis.

### 2.5 Prøvekjøring

```bash
bash Infrastructure/scripts/deploy.sh --deployment main --dry-run
```

Kjører hele gaten (read-only mot Azure), viser hva godkjenningen dekker og den nøyaktige `az deployment group create`-kommandoen,
og lister hver grunn til at en ekte kjøring ville stoppet (`BLOCKER: …`). Den deployer aldri og trenger ikke terminal.
Forventet: *ingen* blokkering, `gate verdict PASS`. Les `report.md` selv: *tillatte endringer* (`allowed`) skal være dem i §1.

## 3. Utrulling (skriver)

```bash
bash Infrastructure/scripts/deploy.sh --deployment main
```

Skriptet gjør, i denne rekkefølgen (hver avvisning stopper uten endring):

1. nekter uten terminal, uten ren arbeidskopi, uten `HEAD = origin/main`, eller uten at hemmelige parametere er satt
2. kjører gaten; stopper på alt annet enn PASS
3. viser *hva du godkjenner*: gate-dom, digest, ressursene utrullingen kan endre, tillatte endringer, rest-risiko
4. krever at du skriver `DEPLOY main <digest12>` ordrett
5. sjekker at treet og grunnlaget er uendret og yngre enn 30 minutter *etter* at du skrev godkjenningen
6. `az deployment group create --mode Incremental`
7. kjører gaten på nytt mot den nye tilstanden (`post-verify`) og sjekker at begge apper er `Running`

Under utrullingen kommer en kort restart av begge API-ene (sekunder til noen titalls sekunder). Gjør den utenfor
belastningstopper. Cloudflare er ikke berørt.

**Stopp og ikke fortsett hvis:** gaten er FAIL, digesten ikke stemmer, du er i tvil om hva en `allowed`-linje betyr, eller
*noen* i teamet deployer samtidig. Det koster ingenting å kjøre på nytt.

## 4. Etterkontroll

Automatisk (fra `deploy.sh`): `Deployment state: Succeeded`, `Post-deployment verification passed`, begge apper `Running`.

Manuelt, rett etter og igjen etter 15 og 30 minutter:

```bash
# samme sjekker som i §2.2: skal gi identiske svar, og Data API har nå 42 settings (PlaceSuggestions__Enabled)
curl -s -o /dev/null -w "%{http_code}\n" https://api.cetchapp.com/api/v1/extras/is-up       # 200
curl -s -o /dev/null -w "%{http_code}\n" https://api.cetchapp.com/api/v1/web-drafts/categories   # 404: WebDrafts er fortsatt av
```

* App Insights (`appi-invi-data-api-prod-001`, `appi-invi-auth-api-prod-001`): ingen økning i 5xx eller unntak mot grunnlaget fra
  §2.2; oppstartsloggen «WebDrafts configuration: Enabled=False, RequireCaptcha=True, TurnstileSecretKey=present, IpHashSalt=present»
  fra den nye instansen.
* Key Vault-referansene: status uendret (`OtherReasons` på de to API-ene, `Resolved` for admin). Appene laster secrets selv.
* Slett `$BACKUP` når utrullingen er verifisert og ingen rollback er aktuell.

## 5. Rollback

**Å rulle tilbake er ikke å deploye den gamle malen.** Den uavstemte malen på `origin/main` før #14/#15 sletter live-settings
og forsøker å fjerne migreringssubnettet; gaten avviser den, og den skal aldri brukes som tilbakerulling. Incremental
deployment bevarer ressurser, men *skriver app settings som helhet*. Rollback er derfor å gjenopprette verdier, ikke en mal.

### 5.1 Beslutningstabell

| Symptom | Årsak | Handling |
|---|---|---|
| `deploy.sh` stopper *før* deploy (gate FAIL, avbrutt, for gammelt grunnlag) | ingenting er endret | rett årsaken, kjør på nytt |
| `az deployment group create` feiler midtveis | ARM er idempotent, noen ressurser kan være skrevet | les feilen (`az deployment operation group list`), rett, kjør `deploy.sh` på nytt (gaten kontrollerer ny tilstand) |
| Deployment `Succeeded`, men post-verify FAIL | live avviker fra forventet: les `report.md` | §5.2 hvis en setting er feil; ellers ta funnet som en ny gate-sak |
| Data API/Auth API svarer 5xx eller starter ikke | feil settings-verdi, manglende setting, hemmelighet | §5.2, deretter `az webapp restart` |
| RevenueCat feiler (kjøp/webhook) | feil verdi i `REVENUECAT_*` | §5.2 for de to settingene |
| Tilkoblinger til MySQL avvises / «Access denied» | passordet er endret utenfor utrullingen (en utrulling endrer det ikke) | §5.3 |

### 5.2 Gjenopprett app settings (skriver; egen godkjenning)

Fra sikkerhetskopien i §2.4. `set` overskriver bare navnene i filen og sletter ikke noe; `delete` fjerner en setting.

```bash
# alle settings tilbake til forhåndstilstanden (verdier fra $BACKUP, ikke vist)
az webapp config appsettings set -g $RG -n app-invi-data-api-prod-001 --subscription $SUB \
   --settings @"$BACKUP/app-invi-data-api-prod-001.appsettings.json" --output none
# bare den nye settingen bort igjen
az webapp config appsettings delete -g $RG -n app-invi-data-api-prod-001 --subscription $SUB \
   --setting-names PlaceSuggestions__Enabled --output none
az webapp restart -g $RG -n app-invi-data-api-prod-001 --subscription $SUB
```

Gjenopprettingen er bare en midlertidig stabilisering: Bicep og live er nå ulike igjen. Kjør gaten (`preflight.sh`), finn årsaken,
rett i Bicep via PR og utrull på nytt. Ikke la live-endringen bli stående som håndlaget drift.

### 5.3 MySQL-passordet

En utrulling av `main` endrer ikke MySQL-passordet: serveren skrives ikke (§2.3), og gaten stopper alt som ville sendt et
passord til serveren. Får appene likevel «Access denied», er passordet endret utenfor utrullingen (manuelt, eller av en
`update`/`create` som er godkjent i manifestet). Da gjelder:

1. Ikke deploy på nytt og ikke gjett. Finn ut hvem som endret passordet og hva appene har i Key Vault-secreten de leser.
2. Passord endres bare utenfor Bicep (`az mysql flexible-server update --admin-password …`) og alltid sammen med
   Key Vault-secreten appene leser og en restart av appene. Gaten sjekker ingen av delene.
3. Point-in-time-restore er siste utvei og gir en *ny* server (kutt over koblingene og Key Vault-oppføringene); den er ikke en
   rollback av et passord.

### 5.4 Det rollback *ikke* gjør

* `inviMetrics`-diagnostikken er en identisk kopi av den håndlagde; den trenger ikke fjernes, og å fjerne den fjerner målinger.
* Rolletildelinger: ingen endres av `main`; gaten viser at navnene er live.
* Slot, nettverk, NSG, domener: ikke berørt.

## 6. Etter utrulling

1. Lagre gate-rapporten (`report.md` og `report.json`, uten hemmeligheter) sammen med PR-ene: digest, tidspunkt, hvem som godkjente.
2. Oppdater `Infrastructure/safety/manifest.json` bare hvis noe nytt er godkjent (egen PR).
3. Neste endringer går i denne rekkefølgen (hver med egen gate og egen godkjenning): IaC-3 trinn 1 (privat endepunkt for Auth API),
   verifiser, trinn 2 (nekt); deretter IaC-6 oppå #12; IaC-4/IaC-5.

## Admin App (`adminapp-a`)

Ikke en del av `main`. Produksjon samsvarer allerede med den avstemte koden, så ingen admin-utrulling er nødvendig for å
komme dit. Skal den likevel kjøres (for eksempel etter en endring i `adminapp.bicep`): samme flyt med
`--deployment adminapp-a`, `ADMIN_ENTRA_CLIENT_SECRET` satt og kontrollert med `verify-secure-parameters.sh --deployment adminapp-a`.
Den skriver app settings som helhet og restarter admin-appen. `adminapp-b-rbac` adopterer en eksisterende rolletildeling ved navn
og må kjøres etter `adminapp-a`.
