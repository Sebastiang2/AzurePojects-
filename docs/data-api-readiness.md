# Data API readiness controls

Production explicitly sets both `dataApiReadinessWarmupEnabled=false` and `dataApiHealthCheckEnabled=false` in
`Infrastructure/environments/prod.bicepparam`. Merging these independent controls activates neither feature. Both target
the database-backed `/v1/extras/ready` endpoint; `/v1/extras/is-up` is liveness-only.

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
2. In a separate activation PR, change **only the chosen production parameter**. A warm-up activation needs safety-manifest
   permission for exactly the two new `WEBSITE_WARMUP_*` settings. A Health Check activation needs permission for exactly
   the `healthCheckPath` change. This code-only PR grants neither permission.
3. Run offline validation and a fresh read-only what-if/safety gate with the complete main template and real secure inputs.
   Review all drift and expected resource changes, including the complete App Settings bag; do not assume this parameter is
   the only change in an un-deployed template. Obtain separate deployment approval.
4. After each activation, verify repeated readiness responses and the actual App Service configuration. An external 200
   before activation alone cannot prove Azure's internal Health Check probes succeed.

## Rollback

Set **only the affected control** back to `false` in a reviewed rollback PR, with narrowly scoped safety-manifest permission
for the reverse change. Warm-up rollback removes both `WEBSITE_WARMUP_*` settings; Health Check rollback clears
`healthCheckPath`. Confirm the exact reverse change in a fresh what-if/safety gate, provide secure inputs, and obtain separate
deployment approval. The configuration deployment can recycle the Data API, so allow for a brief interruption and verify
health afterward. Neither rollback has been exercised in production. If reverting API code to a revision without `/ready`,
remove the warm-up requirement first through an approved deployment.
