# Data API readiness controls

Production now has startup warm-up active. Both `Infrastructure/environments/prod.bicepparam` and the dedicated
`Infrastructure/environments/prod.data-api-warmup.bicepparam` set `dataApiReadinessWarmupEnabled=true`, so a later full
**main** deployment preserves the two live warm-up settings. The deployment script requires these parameters to match;
the full main deployment is not an activation or rollback path. `dataApiHealthCheckEnabled=false` remains separate.
Both controls target the database-backed
`/v1/extras/ready` endpoint; `/v1/extras/is-up` is liveness-only.

| Control | When enabled | When disabled again |
| --- | --- | --- |
| `dataApiReadinessWarmupEnabled` | Adds `WEBSITE_WARMUP_PATH=/v1/extras/ready` and `WEBSITE_WARMUP_STATUSES=200` to the Data API App Settings. A newly started worker must return HTTP 200 to pass warm-up. | The complete desired App Settings resource removes both settings. Health Check is unaffected. |
| `dataApiHealthCheckEnabled` | Sets `siteConfig.healthCheckPath=/v1/extras/ready` for the Data API. | Sets `healthCheckPath` to `null`. Startup warm-up is unaffected. |

Each setting needs its own reviewed activation and rollback. App Settings or Health Check configuration changes can recycle
the Data API. On this single-worker plan, neither feature provides zero downtime or a deployment slot. Health Check cannot
reroute traffic to another worker; prolonged failed probes can replace the unhealthy worker. Warm-up that never receives 200
can delay or fail startup. Do not deploy an older API without `/v1/extras/ready` while startup warm-up requires that path.

## Required activation gate

1. Verify that the deployed API returns anonymous HTTP 200 from `/v1/extras/ready` through `api.cetchapp.com`,
   without a redirect, and that its revision is the reviewed release. Before origin lock, verify the direct Azure hostname
   too; after origin lock, direct public access must be denied and must not be required by the readiness guard.
   Confirm the authorized operator has all required secure
   deployment inputs without printing their values.
2. Use the dedicated `data-api-warmup` deployment target. Its Bicep file declares only the existing Data API site and
   Application Insights component as read-only references and writes only `app-invi-data-api-prod-001/appsettings`. The
   safety manifest must reject any Auth API, Health Check, network, RBAC, identity or other resource write.
3. Run `Infrastructure/scripts/verify-secure-parameters.sh --deployment data-api-warmup` in the **same authorized shell**
   that will deploy. The operator supplies both RevenueCat values through a secure, non-echoing prompt as described in
   `docs/deploy-runbook.md`; require `MATCH` for each. `deploy.sh` repeats this check and fails closed. Do not print, log,
   commit or save the values in evidence.
4. Run offline validation and a fresh read-only `preflight.sh --deployment data-api-warmup` / what-if. It must show only
   the Data API App Settings resource changing, adding `WEBSITE_WARMUP_PATH=/v1/extras/ready`,
   `WEBSITE_WARMUP_STATUSES=200`, and the separately acknowledged `WebDrafts__PlaceSuggestionsPaused=true` drift. Review the
   complete bag and obtain separate deployment approval. Do not use `--deployment main` for this activation.
5. The approved `deploy.sh --deployment data-api-warmup` path verifies three consecutive 200 responses at the pinned
   backend SHA before changing settings, and waits for three more after the write. Failure stops and reports; it never
   retries deployment or rolls back automatically. After activation, verify the actual App Service configuration. An external 200
   before activation alone cannot prove Azure's internal Health Check probes succeed.

The full `main` template also writes Auth API and other resources; it is **not** the warm-up activation path. The 2026-10-20 baseline gate found
`WebDrafts__PlaceSuggestionsPaused` missing live and would add it as `true`; this is a separate setting change even though it
pauses suggestions. The what-if reported `Modify` for Auth API site/appsettings/networkConfig, Data API equivalents,
Application Insights components, a private endpoint and DNS group, and a diagnostic setting. The gate classified their
reported deltas as platform noise or compared settings separately, but that does not prove an ARM write cannot recycle an
app. Do not approve unrelated resource writes implicitly. The dedicated target must fail closed if its fresh what-if includes
any of them.

The complete Data API App Settings bag also requires `REVENUECAT_SECRET_API_KEY` and
`REVENUECAT_WEBHOOK_AUTHORIZATION` in the authorized deploying shell. Run
`Infrastructure/scripts/verify-secure-parameters.sh --deployment data-api-warmup`; require `MATCH` for both without recording values.
The review shell on 2026-10-20 had neither variable, so this prerequisite is **not yet satisfied**.

## Rollback

Set `dataApiReadinessWarmupEnabled=false` in **both** production parameter files in a reviewed rollback PR. Then deploy only
`data-api-warmup`. The manifest permits removing just the two `WEBSITE_WARMUP_*` settings. Confirm the exact reverse change
in a fresh what-if/safety gate, verify both RevenueCat inputs, and obtain separate deployment approval. The App Settings
write can recycle the Data API. The rollback path deliberately does **not** require `/ready` before removing warm-up;
afterward it requires three `/v1/extras/is-up` 200 responses, while the safety gate verifies that both warm-up settings
are absent. The deployment script rejects a mismatch between the canonical and dedicated parameters. The main manifest also rejects the
warm-up settings being added or removed by an unrelated full deployment. Do not deploy an older backend
revision without `/ready` until this rollback has completed. Health Check remains disabled throughout. This rollback has
not been exercised in production.
