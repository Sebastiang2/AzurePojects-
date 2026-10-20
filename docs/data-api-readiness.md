# Data API readiness controls

This activation proposal sets `dataApiReadinessWarmupEnabled=true` and leaves `dataApiHealthCheckEnabled=false` in
`Infrastructure/environments/prod.bicepparam`. Merging IaC code does not deploy it, but a later **main** Bicep deployment
would activate startup warm-up. Do not merge or deploy this proposal before the gates below pass and separate approval is
given. Both controls target the database-backed `/v1/extras/ready` endpoint; `/v1/extras/is-up` is liveness-only.

| Control | When enabled | When disabled again |
| --- | --- | --- |
| `dataApiReadinessWarmupEnabled` | Adds `WEBSITE_WARMUP_PATH=/v1/extras/ready` and `WEBSITE_WARMUP_STATUSES=200` to the Data API App Settings. A newly started worker must return HTTP 200 to pass warm-up. | The complete desired App Settings resource removes both settings. Health Check is unaffected. |
| `dataApiHealthCheckEnabled` | Sets `siteConfig.healthCheckPath=/v1/extras/ready` for the Data API. | Sets `healthCheckPath` to `null`. Startup warm-up is unaffected. |

Each setting needs its own reviewed activation and rollback. App Settings or Health Check configuration changes can recycle
the Data API. On this single-worker plan, neither feature provides zero downtime or a deployment slot. Health Check cannot
reroute traffic to another worker; prolonged failed probes can replace the unhealthy worker. Warm-up that never receives 200
can delay or fail startup. Do not deploy an older API without `/v1/extras/ready` while startup warm-up requires that path.

## Required activation gate

1. Verify that the deployed API returns anonymous HTTP 200 from `/v1/extras/ready` through the App Service default hostname,
   without a redirect, and that its revision is the reviewed release. Confirm the authorized operator has all required secure
   deployment inputs without printing their values.
2. The warm-up activation PR may change only its production parameter and permit exactly the two new `WEBSITE_WARMUP_*`
   settings in the safety manifest. It must not permit a Health Check path change. Health Check requires a later, separate PR.
3. Run offline validation and a fresh read-only what-if/safety gate with the complete main template and real secure inputs.
   Review all drift and expected resource changes, including the complete App Settings bag; do not assume this parameter is
   the only change in an un-deployed template. Obtain separate deployment approval.
4. After each activation, verify repeated readiness responses and the actual App Service configuration. An external 200
   before activation alone cannot prove Azure's internal Health Check probes succeed.

The full `main` template also writes Auth API and other resources. The 2026-10-20 baseline gate found
`WebDrafts__PlaceSuggestionsPaused` missing live and would add it as `true`; this is a separate setting change even though it
pauses suggestions. The what-if reported `Modify` for Auth API site/appsettings/networkConfig, Data API equivalents,
Application Insights components, a private endpoint and DNS group, and a diagnostic setting. The gate classified their
reported deltas as platform noise or compared settings separately, but that does not prove an ARM write cannot recycle an
app. Do not approve unrelated resource writes implicitly. Before deployment, review fresh, complete what-if evidence and
decide whether a narrower Data API-only deployment path is required.

The complete Data API App Settings bag also requires `REVENUECAT_SECRET_API_KEY` and
`REVENUECAT_WEBHOOK_AUTHORIZATION` in the authorized deploying shell. Run
`Infrastructure/scripts/verify-secure-parameters.sh --deployment main`; require `MATCH` for both without recording values.
The review shell on 2026-10-20 had neither variable, so this prerequisite is **not yet satisfied**.

## Rollback

Set **only the affected control** back to `false` in a reviewed rollback PR, with narrowly scoped safety-manifest permission
for the reverse change. Warm-up rollback removes both `WEBSITE_WARMUP_*` settings; Health Check rollback clears
`healthCheckPath`. Confirm the exact reverse change in a fresh what-if/safety gate, provide secure inputs, and obtain separate
deployment approval. The configuration deployment can recycle the Data API, so allow for a brief interruption and verify
health afterward. Neither rollback has been exercised in production. If reverting API code to a revision without `/ready`,
remove the warm-up requirement first through an approved deployment.
