# Invi Studio og onboarding-API i Azure

Gjelder `https://studio.invi.lol` (repo `CetchApp/invi-studio`) og onboarding-API-et (repo `CetchApp/cetchapp-onboarding-api`). Bicep er kilden til
sannhet for alt i Azure. Denne siden er veiledningen rundt de fem utrullingene som er lagt til i
[`Infrastructure/safety/manifest.json`](../Infrastructure/safety/manifest.json); mekanismen bak (gaten) står i
[`deploy-safety-gate.md`](deploy-safety-gate.md), og den generelle sjekklisten (sikkerhetskopi, etterkontroll) i
[`deploy-runbook.md`](deploy-runbook.md). Tilstanden under er lest fra Azure og GitHub 2026-10-16; les den på nytt før du handler.

## 1. Arkitektur og valg

```
nettleser ──https──► studio.invi.lol ──► app-invi-studio-prod-001 (Node 24, Next.js standalone)
                                              │  server til server, X-Studio-Api-Key
                                              ▼
                      app-invi-onboarding-api-prod-001 (.NET 10)  ──VNet──► mysql-invi-prod-001 (privat, database `invi`)
                                                                  ◄──── kv-invi-prod-001 (privat): database-password, studio-api-key
                      Studio leser fra kv-invi-prod-001: studio-api-key, studio-session-secret
```

| Valg | Begrunnelse |
|---|---|
| Begge som App Service på `asp-invi-prod-001` | Studio er en Node-server (server-rendrede sider, route handlers, `proxy.ts`); Static Web Apps (hybrid Next.js) er uegnet. Planen har VNet-integrasjon mot den private MySQL-serveren og det private hvelvet; en annen plan trenger eget, delegert subnett. Samme mønster som admin-appen. |
| Ett generisk modul (`webapp.bicep`) og egne parameterfiler | Appene deler 95 % (site-herding, VNet, diagnostikk). Hver app er en egen utrulling i manifestet, så en feil i den ene ikke stopper den andre, og ingen av dem kan røre API-ene. `adminapp.bicep` er ikke endret. |
| Onboarding-API uten eget domene | Bare Studio-serveren kaller det. Færre bevegelige deler (ingen DNS, ingen sertifikat). Et eget domene kan legges til senere. |
| Låsing i kode, ikke i nettverket | API-et kalles bare av Studio-serveren. I produksjon krever koden Studio-nøkkelen på alle ruter unntatt `/api/health` (`STUDIO_SERVER_ONLY=true`), `/api/admin/*` er slått av (`ADMIN_ROUTES_ENABLED=false`), og teksten til en Key Vault-referanse som ikke ble løst (offentlig tekst) godtas aldri som nøkkel. Begrunnelsen står i API-repoet. Et privat endepunkt (som Auth API-et har planlagt) er et bedre neste steg, ikke et krav. |
| Appene leser hemmelighetene selv fra Key Vault ved oppstart, med rolle på én hemmelighet (ikke plattformens Key Vault-referanser) | Plattformens referanser løses ikke mot `kv-invi-prod-001` for appene på denne planen (bevis og detaljer i §6); Data API, Auth API og admin-appen leser derfor selv, og det gjør disse også. Bicep gir appen `KEY_VAULT_URI` og `KEY_VAULT_MAP`, ingen hemmelighet. Ingen hemmelighet i Git, i parameterfilene eller i GitHub. |
| Ingen `healthCheckPath` på plattformen | Planen har én instans som deles med API-ene. Helsesjekk kan få instansen byttet ut under dem (se `adminapp.bicep`). Appene har egne helseruter: API-et `/api/health`, Studio `/api/health` og `/api/health?deep=1`. |
| Deploy bare manuelt, fra `main`, i miljøet `production` | Uprøvd kode skal ikke rulles ut av en push. Workflowene bygger og tester ved hver push og PR, men deployer bare ved «Run workflow» med «Deploy» avkrysset. |

Datakilden er MySQL-databasen `invi`, den samme som Data API-et bruker. Onboarding-API-et kjører ingen migreringer; Data API-et oppretter Studio-tabellene selv
ved oppstart (`OrganizerReservationSchema`).

**«Koblet mot Data API»** betyr databasen og admin-panelet, ikke et HTTP-kall: Studio kaller aldri Data API-et (ingen kode i `invi-studio` gjør det, og ingen CORS-endring
trengs: Studio kaller fra serveren, og Data API-et tillater uansett alle origins uten credentials). Admin-appen kaller Data API-ets admin-ruter
(`/api/v1/admin/publishing/...`: `organizers/import`, `organizers/{id}/account/login` som utsteder Studio-innlogging med et engangs startpassord, og
`account/disable`), og de skriver arrangørene og kontoene (`OrganizersTable`, `OrganizerAccountTable`) som onboarding-API-et leser for Studio. Selvregistrerte
arrangører opprettes skjult (`IsActive=false`) og aktiveres i admin-panelet.

## 2. Ressurser

| Ressurs | Navn | Opprettes av |
|---|---|---|
| Web app (Studio) | `app-invi-studio-prod-001` | `studio` |
| Web app (onboarding-API) | `app-invi-onboarding-api-prod-001` | `onboardingapi` |
| Application Insights | `appi-invi-studio-prod-001`, `appi-invi-onboarding-api-prod-001` | samme |
| Diagnostikkinnstilling til `log-invi-prod-001` | `diag-app-invi-studio-prod-001`, `diag-app-invi-onboarding-api-prod-001` | samme |
| Bruker-tildelt identitet for GitHub (OIDC) | `id-gha-invi-studio-prod-001`, `id-gha-invi-onboarding-api-prod-001` | samme |
| Federated credential | `github-production` på hver identitet | samme |
| Rolle: Key Vault Secrets User på `studio-api-key`, `studio-session-secret` (Studio) og `studio-api-key`, `database-password` (API) | | `studio-platform-rbac` (Owner) |
| Rolle: Website Contributor på hver app til sin deploy-identitet | | `studio-platform-rbac` (Owner) |
| Host name binding og managed sertifikat for `studio.invi.lol` | | `studio-domain`, `studio-domain-tls` |

Ingenting eksisterende endres: gaten kjørt mot produksjon (kun lesing, `--allow-dirty`, 2026-10-16) ga PASS for `onboardingapi` og `studio` med what-if
«40 Ignore, 8 Create» for hver, ingen Modify og ingen Delete. Ny løpende kostnad: to Application Insights-ressurser (opptak faktureres per GB i det
eksisterende arbeidsområdet, som har tak på 1 GB/dag). Appene, identitetene, rollene og det managed sertifikatet har ingen egen kostnad, og det
opprettes ingen plan, database, Redis eller lagringskonto.

## 3. Rekkefølge

Hvert skrivende trinn går bak gaten (`deploy.sh`, skrevet godkjenning). Ingenting under er utført.

| # | Hvem | Hva | Kontroll |
|---|---|---|---|
| 0 | team | PR-ene i de tre repoene er gjennomgått og merget (IaC, API, Studio). `HEAD` i IaC-repoet må være `origin/main` | `deploy.sh --deployment onboardingapi --dry-run` uten `BLOCKER` |
| 1 | Contributor | `deploy.sh --deployment onboardingapi`, deretter `--deployment studio` | begge apper `Running`; `az webapp config show` gir `vnetRouteAllEnabled true` |
| 2 | person med tilgang til det private hvelvet | opprett `studio-api-key` og `studio-session-secret` (§4) | `az keyvault secret show --query "attributes.enabled"` gir `true` (verdien leses aldri) |
| 3 | team | PR som lister rolletildelingene i manifestet (§5) | `preflight.sh --deployment studio-platform-rbac --allow-dirty` uten `RBAC-NEW`/`RBAC-UNVERIFIABLE` som feil |
| 4 | Owner | `deploy.sh --deployment studio-platform-rbac` | seks tildelinger finnes; ingen vidtgående rolle |
| 5 | team | roller på plass og appene startet på nytt (§6) | loggen til begge apper har `key-vault: loaded …` (API-et 2, Studio 2) |
| 6 | repo-administrator | GitHub-variabler og miljøregler i begge repoene (§7) | |
| 7 | team | første kodeutrulling: API først, deretter Studio (manuell workflow) | smoke check i workflowen |
| 8 | person med tilgang til Namecheap | DNS-postene for `studio` (§8) | `dig +short CNAME studio.invi.lol` |
| 9 | Contributor | `deploy.sh --deployment studio-domain`, når CNAME svarer, deretter `--deployment studio-domain-tls` | gyldig sertifikat, `https://studio.invi.lol/api/health?deep=1` gir 200 |
| 10 | team | fjern `introducedBy` fra de to appene i manifestet; legg inn i README/CHANGELOG hva som er live | gaten for `main` er PASS |

`introducedBy` i manifestet (`apps.<app>.introducedBy`) gjør at en annen utrulling (for eksempel en rettelse til `main`) ikke stoppes av at en app som er
lagt til i manifestet ennå ikke er opprettet: `deploy.sh` krever bare at den er `Running` når utrullingen som innfører den kjøres.

Trinn 1 oppretter appene uten kode. Containeren starter ikke før første kodeutrulling, og Studio svarer `503` fra plattformen til da. Utfør trinn 2 til 7 i
samme arbeidsøkt for å unngå at appene ligger åpne uten kode (en app uten kode prøver å starte i en løkke i noen minutter og belaster den delte planen).

## 4. Hemmeligheter (kun navn står her; verdiene ses aldri)

Det private hvelvet nås bare fra VNet-et. Den eneste verten med nettverksvei i dag er `vm-db-migration-temp` (deallocated 2026-10-16; den må startes av en som har lov, har
hvelv-bred Secrets Officer og bør fjernes når oppryddingen er gjort). Verdien genereres og lagres i samme kommando og vises aldri; legg den aldri i chat, Git eller en fil.

```bash
# På en vert med nettverksvei til kv-invi-prod-001, innlogget som en person med Key Vault Secrets Officer eller Administrator:
az keyvault secret set --vault-name kv-invi-prod-001 --name studio-api-key        --value "$(openssl rand -base64 48 | tr -d '\n')" --output none
az keyvault secret set --vault-name kv-invi-prod-001 --name studio-session-secret --value "$(openssl rand -base64 64 | tr -d '\n')" --output none
```

| Hemmelighet | Leses av | Finnes |
|---|---|---|
| `studio-api-key` | Studio og onboarding-API-et (samme verdi: den delte nøkkelen) | nei, opprettes |
| `studio-session-secret` | Studio (signerer sesjonene; minst 32 tegn) | nei, opprettes |
| `database-password` | onboarding-API-et (som Data API og Auth API) | ja |

Rotasjon: sett en ny versjon av hemmeligheten og start API-et, deretter Studio, på nytt (appene leser siste versjon ved oppstart og leser ikke på nytt mens de kjører).
Ny `studio-session-secret` logger ut alle. Valgfrie nøkler som ikke er satt (Google Places, OpenAI, Stripe, Resend) legges til ved å føre navnet inn i
`settingSecretNames` i `prod.studio.bicepparam` og i `prod.studio-platform-rbac.bicepparam` i samme PR; ikke-hemmelige verdier (for eksempel `STRIPE_PRICE_ID`) går i `appSettings`.

## 5. Rolletildelinger i manifestet

Navnet på en rolletildeling er en `guid()` av prinsipalet, og prinsipalet finnes først når appen er opprettet. Gaten forutsier navnene fra live-tilstanden og
stopper på hver tildeling som ikke er listet. Etter trinn 1:

```bash
bash Infrastructure/scripts/preflight.sh --deployment studio-platform-rbac --allow-dirty
# les report.md: hver RBAC-NEW viser det nøyaktige navnet (6 stykker)
```

Før navnene inn i PR-en: `deployments.studio-platform-rbac.allowedCreates` (`{ "type": "Microsoft.Authorization/roleAssignments", "name": "<guid>", "why": "..." }`),
`touches` (`{ "type", "name" }`) og `rbac.knownAssignments` (`{ "name", "role", "principalType": "ServicePrincipal", "scope", "description", "status": "declared" }`).
Uten det stopper gaten alle utrullinger (`RBAC-UNREVIEWED`) etter at tildelingene er laget.

## 6. Hemmelighetene: hvordan appene får dem, og hvordan du ser at de er lastet

Appene leser hemmelighetene selv, i containeren, gjennom det private endepunktet, med sin egen administrerte identitet. Bicep setter to innstillinger som ikke er hemmelige:
`KEY_VAULT_URI` (`https://kv-invi-prod-001.vault.azure.net/`) og `KEY_VAULT_MAP` (`hemmelighet:VARIABEL;…`, for eksempel `studio-api-key:STUDIO_API_KEY`). API-et gjør lastingen først i
`Program.cs` (`Infrastructure/KeyVaultSecrets.cs`), Studio i startkommandoen `node launch.mjs` (`scripts/launch.mjs`), som deretter starter `server.js`. Verdiene havner i miljøvariabler før
konfigurasjonen bygges. En variabel som allerede har en brukbar verdi røres ikke; teksten til en uløst referanse (`@Microsoft.KeyVault(`…) regnes som «ikke satt». Tokenet sendes bare til en
`*.vault.azure.net`-adresse. Svikter noe, starter appen likevel: API-et svarer 503 på alt unntatt `/api/health`, Studio svarer 503 «ikke konfigurert» og `/api/health?deep=1` sier `not-configured`. Loggen sier hvilken
hemmelighet og hvorfor, aldri verdien, tokenet eller hvelvets egen feiltekst.

**Hvorfor ikke plattformens Key Vault-referanser.** Lest fra Azure 2026-10-16 (kun lesing): alle ti referansene på Data API-et (8) og Auth API-et (2) har status `OtherReasons` («Reference was not able to be resolved»).
Plattformens egen diagnostikk (`Key Vault Application Settings Diagnostics`, `…/detectors/KeyVaultAppSettings`) gir for begge, helt fra 2026-09-17 til nå, «VnetProxy warmup request timed out at 30 seconds» og
«VnetProxy warmup request failed … ServiceUnavailable». Nettverk og identitet er like for alle tre appene (samme delnett, `applicationTraffic`, systemtildelt identitet, Key Vault Secrets User), og NSG-ene
tillater 443 til delnettet for private endepunkter, så årsaken er ikke funnet og ligger på plattformsiden. Admin-appens ene referanse viser `Resolved`, men det er ett datapunkt på en app uten kjørende container og ikke
bevis for at nye apper får det samme. Data API-et og Auth API-et laster derfor selv (`KeyVaultConfiguration`) og har gjort det siden oppsettet; at veien fra containeren virker, ses av at Data API-ets kall til OpenAI
(som bruker nøkkelen fra hvelvet) lyktes 77 av 77 ganger siste 30 dager. Disse appene bruker samme vei.

Etter første kodeutrulling, og etter hver omstart, skal loggen vise (forsinkelse på noen minutter i Log Analytics):

```bash
az monitor log-analytics query -w 574a4429-0f3d-4753-9271-693d7874d15d -o table --analytics-query "
  AppServiceConsoleLogs | where TimeGenerated > ago(1h) and ResultDescription startswith 'key-vault:'
  | project TimeGenerated, app = tostring(split(tolower(_ResourceId), '/')[-1]), ResultDescription | order by TimeGenerated desc"
# forventet:  app-invi-onboarding-api-prod-001  key-vault: loaded 2 secret(s) into the environment: ONBOARDING_DB_PASSWORD, STUDIO_API_KEY
#             app-invi-studio-prod-001          key-vault: loaded 2 secret(s) into the environment: STUDIO_API_KEY, STUDIO_SESSION_SECRET
```

| Linje i loggen | Betyr | Gjør |
|---|---|---|
| `the vault answered 403 Forbidden/ForbiddenByRbac` | rollen finnes ikke (ennå) på akkurat den hemmeligheten | sjekk `az role assignment list --assignee <appens principalId> --all`; rolletildelinger kan trenge noen minutter; start appen på nytt |
| `the vault answered 404 SecretNotFound` | hemmeligheten finnes ikke under det navnet | opprett den (§4); start på nytt |
| `the vault did not answer` | nettverksveien (privat endepunkt, privat DNS, NSG) | sjekk at endepunktet er `Approved` og at `privatelink.vaultcore.azure.net` er koblet til VNet-et |
| `the managed identity endpoint …` / `no managed identity here` | identiteten eller plattformens identitetstjeneste | sjekk `az webapp identity show`; start på nytt; vedvarer det, er det en plattformsak |
| ingen `key-vault:`-linje | `KEY_VAULT_URI` mangler i innstillingene (kjør Bicep-utrullingen), eller containeren kjører gammel kode | `az webapp config appsettings list` (bare navn), deploy på nytt |

Start på nytt (en skrivende handling, bare for denne appen): `az webapp restart -g rg-invi-prod-swc-001 -n <app>`.

## 7. GitHub (krever administrator på repoene; utføres ikke av push-tilgang)

For hvert av `CetchApp/invi-studio` og `CetchApp/cetchapp-onboarding-api`: repository-variablene `AZURE_CLIENT_ID` (klient-ID-en til appens deploy-identitet:
`az identity show -g rg-invi-prod-swc-001 -n id-gha-invi-<app>-prod-001 --query clientId -o tsv`), `AZURE_TENANT_ID` og `AZURE_SUBSCRIPTION_ID`; miljøet `production`
med påkrevd godkjenner og «Deployment branches: main»; og grenbeskyttelse på `main` (PR og grønn bygging). Ingen av dem er hemmeligheter. Workflowen hopper over
deploy til variablene finnes. Opprett miljøet og legg inn godkjennerne *før* første kjøring: et miljø som ikke finnes opprettes av GitHub uten beskyttelse ved første bruk.

```bash
# etter at deploy-identitetene finnes (utføres av en administrator; verdiene er ikke hemmeligheter)
for pair in "invi-studio:studio" "cetchapp-onboarding-api:onboarding-api"; do
  repo="${pair%%:*}"; app="${pair##*:}"
  gh variable set AZURE_CLIENT_ID       --repo "CetchApp/$repo" --body "$(az identity show -g rg-invi-prod-swc-001 -n "id-gha-invi-$app-prod-001" --query clientId -o tsv)"
  gh variable set AZURE_TENANT_ID       --repo "CetchApp/$repo" --body "$(az account show --query tenantId -o tsv)"
  gh variable set AZURE_SUBSCRIPTION_ID --repo "CetchApp/$repo" --body "$(az account show --query id -o tsv)"
done
```

## 8. DNS hos Namecheap (`invi.lol`)

| Type | Vert | Verdi |
|---|---|---|
| TXT | `asuid.studio` | `customDomainVerificationId` fra appen: `az webapp show -g rg-invi-prod-swc-001 -n app-invi-studio-prod-001 --query customDomainVerificationId -o tsv` |
| CNAME | `studio` | `app-invi-studio-prod-001.azurewebsites.net.` |

Rør ikke MX- og SPF-postene til e-postvideresendingen eller `ALIAS @`, `_dnsauth` og `www`. `invi.lol` har HSTS uten `includeSubDomains`, så underdomenet påvirkes ikke.
Sertifikatet er et gratis, selvfornyende App Service-sertifikat og krever at CNAME-en peker rett på app-vertsnavnet (ingen proxy foran).

## 9. Verifisering etter utrulling (trygge, ikke-destruktive kall)

```bash
curl -sS https://studio.invi.lol/api/health                      # {"status":"ok"}
curl -sS "https://studio.invi.lol/api/health?deep=1"             # {"status":"ok"}: nøkkel, API og database virker (503 med problem ved feil)
curl -sS -o /dev/null -w '%{http_code}\n' https://studio.invi.lol/organization/login          # 200
curl -sS -o /dev/null -w '%{http_code}\n' https://app-invi-onboarding-api-prod-001.azurewebsites.net/api/organizers/1   # 401 (aldri 200)
curl -sS -o /dev/null -w '%{http_code}\n' https://app-invi-onboarding-api-prod-001.azurewebsites.net/api/admin/organizers # 404
curl -sS -o /dev/null -w '%{http_code}\n' https://api.cetchapp.com/api/v1/extras/is-up                                    # 200: Data API upåvirket
```

Ikke registrer en bedrift eller logg inn med ekte data som røyktest: registrering oppretter en ekte arrangør. Innlogging med et ukjent brukernavn er trygt.
Se også loggen (§6: `key-vault: loaded 2 secret(s)` for begge apper) og Application Insights (`appi-invi-studio-prod-001`, `appi-invi-onboarding-api-prod-001`): ingen 5xx, ingen `Database connection failed`.

## 10. Kapasitet på den delte planen

`asp-invi-prod-001` er P0v3 (1 vCPU, 4 GB) med én instans og tre apper. Målt over de siste sju dagene (2026-10-09 til 10-16): CPU i snitt rundt 6 % (topp 60 %),
minne i snitt 55-65 % (topp 70 %). Arbeidssett per app: Data API 360-480 MB (topp 555), Auth API 180-210 MB (topp 231), admin 210-275 MB (topp 328).
To nye apper av samme type legger til anslagsvis 0,45-0,6 GB pluss containeroverhead, altså **anslagsvis** 70-80 % i snitt (anslag, ikke måling). Det er plass, men
marginen er tynn for en plan som også kjører produksjons-API-ene. Mål minnet i `MemoryPercentage` etter utrulling; ved vedvarende snitt over 80 % eller topp over 90 %
bør planen oppgraderes til P1v3 (kostnadsbeslutning for teamet, via `main`-utrullingen og `appServiceSkuName`), før noen app begynner å restarte.

## 11. Databasen

Onboarding-API-et bruker `inviadmin` (som begge de andre API-ene) og forutsetter tabellene i `invi`. Verifiser skrivebeskyttet fra en vert med nettverksvei til
MySQL, før appen åpnes for kunder:

```sql
-- Skal gi 18 rader (tabellene Studio og API-et leser og skriver)
SELECT table_name FROM information_schema.tables WHERE table_schema = 'invi' AND table_name IN (
  'OrganizersTable','OrganizerAccountTable','OrganizerCategoryTable','OrganizerOpeningHours','CategoryTable','ActivityTable','ActivityDraftTable',
  'UserTable','VenueType','ResourceTable','OrganizerResourceConnection','OrganizerResourceUnit','OrganizerResourceBlock','OrganizerResourceBookingHours',
  'ActivityResourceConnection','Reservation','ReservationResourceConnection','UserReservationConnection');
-- Skal gi 3 rader
SELECT column_name FROM information_schema.columns WHERE table_schema = 'invi' AND table_name = 'ActivityTable' AND column_name IN ('OrganizerId','CancelledAt','CancellationReason');
-- Skal gi 1: aktiviteter opprettes alltid med bruker 657 som skaper
SELECT COUNT(*) FROM UserTable WHERE UserId = 657;
```

Data API-et oppretter ved oppstart `OrganizerAccountTable`, ressurs- og reservasjonstabellene, `OrganizerOpeningHours` og `ActivityDraftTable` (med kolonnene
`CancelledAt` og `CancellationReason`); `OrganizersTable`, `CategoryTable`, `OrganizerCategoryTable`, `ActivityTable` og `UserTable` er appens egne tabeller. **`VenueType` opprettes ikke av noen av API-ene:
Studios registrering og profil leser den, og onboarding-API-et svarer 500 uten den.** Den finnes i testdatabasen; mangler den i `invi`, må den opprettes med samme rader som en egen,
godkjent databaseendring (ikke noe denne utrullingen gjør), før Studio åpnes for kunder. `ReservationNotificationOutbox` trengs ikke så lenge `RESERVATION_NOTIFICATIONS_MODE=Disabled`.
En bakgrunnsjobb i API-et setter `IsEnded=1` på utløpte arrangør-aktiviteter hvert minutt (kolonnen `OrganizerId` må finnes).

## 12. Rollback

Ingen eksisterende ressurs er endret, så å rulle tilbake er å fjerne det nye. Hvert trinn bare etter eksplisitt godkjenning:

1. kode: tilbakestill commit-en på `main` og kjør workflowen på nytt (pakken beholdes bare én dag)
2. domene: `az webapp config hostname delete --webapp-name app-invi-studio-prod-001 -g rg-invi-prod-swc-001 --hostname studio.invi.lol`, og fjern TXT/CNAME hos Namecheap
3. rolletildelinger: `az role assignment delete --ids <id>` for de seks (listen står i `az role assignment list --all` for appenes identiteter)
4. appene: `az webapp delete` (begge), `az monitor app-insights component delete`, `az identity delete` (begge) og diagnostikken følger appen
5. hemmeligheter: `az keyvault secret delete` for `studio-api-key` og `studio-session-secret` (myk sletting; rens er av)
6. manifestet: fjern appene, identitetene og de seks tildelingene, i en PR

## 13. Åpne punkter

- Hemmelighetene i §4 er ikke opprettet (krever et menneske med tilgang til det private hvelvet).
- Plattformens Key Vault-referanser løses ikke mot hvelvet for appene på planen (§6); årsaken (VnetProxy) er ikke funnet. Appene her er bygget for å klare seg uten dem. Skulle plattformen rettes senere, er det ingen endring å gjøre.
- Tabellen `VenueType` er ikke verifisert i produksjonsdatabasen (§11); uten den feiler Studios registrering og profil.
- Eier-trinnene (§3 trinn 4) og GitHub-oppsettet (§7) krever personer med de rettighetene; gaten, miljøreglene og det manuelle utløseren er laget for det.
- Studio og API-et må ha samme `STUDIO_REQUIRE_EMAIL`. Verdien er `false` til Resend er klart (verifisert avsenderdomene for `invi.lol`, `RESEND_API_KEY`, `STUDIO_EMAIL_FROM`); da settes den til `true` i begge i samme endring.
- MySQL-brukeren er administratoren. En egen bruker med bare de rettighetene API-et trenger er bedre (MySQL-brukere ligger utenfor ARM).
- API-et er nåbart fra internett og beskyttet av kode. Privat endepunkt med nektet offentlig tilgang er et bedre, separat steg.
- `Tests/buildcheck/*.dll` er sjekket inn i API-repoet (ligger i `.gitignore` men er sporet); det påvirker ikke pakken, men bør ryddes.
- Studios `npm run lint` har seks eksisterende react-hooks-feil (`floor-plan-canvas.tsx`, `activity-create-form.tsx`); CI viser dem uten å stoppe til de er rettet.
