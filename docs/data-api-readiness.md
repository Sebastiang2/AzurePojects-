# Data API readiness warm-up

`dataApiReadinessWarmupEnabled` is deliberately `false` in `Infrastructure/environments/prod.bicepparam`. The capability is
present in Bicep but this change does not configure App Service Health Check or warm-up settings in production.

When separately approved, setting it to `true` configures the Data API only:

- `siteConfig.healthCheckPath = /v1/extras/ready`
- `WEBSITE_WARMUP_PATH = /v1/extras/ready`
- `WEBSITE_WARMUP_STATUSES = 200`

The endpoint is database-backed; do not replace it with `/v1/extras/is-up`, which is liveness-only. On this one-worker plan,
Health Check and warm-up reduce traffic being accepted before readiness but do not provide a zero-downtime deployment or a
deployment slot.

## Required activation gate

1. First merge the API release-readiness code and deploy a reviewed candidate through its manual workflow in strict mode.
   It must return three consecutive `200` responses with a matching `X-Invi-Revision` header.
2. In a separate IaC activation PR, change the production parameter to `true` and update the safety manifest to allow exactly
   `WEBSITE_WARMUP_PATH`, `WEBSITE_WARMUP_STATUSES` and the Health Check path change. Do not combine this with WebDrafts,
   Cloudflare, Key Vault, identity, RBAC or network changes.
3. Run offline validation and the read-only safety gate/what-if with the real secure deployment inputs. Review every allowed
   change, then obtain explicit approval before the Bicep deployment.

## Rollback

Set `dataApiReadinessWarmupEnabled` back to `false` in a reviewed rollback PR. The template clears `healthCheckPath` and,
because the app-settings resource is the full desired bag, removes both `WEBSITE_WARMUP_*` settings. Confirm that exact
removal in a fresh read-only what-if before deployment. The Bicep deployment itself recycles the Data API, so it requires a
separate approved maintenance decision; it is not an emergency rollback substitute for application code.
