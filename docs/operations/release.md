# GX production-only release runbook

`gx.zra.workers.dev` is the only public application host. Release and rollback
must use the repository workflows; do not deploy production directly.

## Steady-state contract

- Worker: `gx`, `workers_dev: true`, `preview_urls: false`, with no `route` or
  `routes` entry.
- Authenticated Worker subdomain: `enabled: true`, `previews_enabled: false`.
- D1: exactly one `PROD_DB` binding to `gx-production`.
- Rate limiter: exactly one `REPORT_RATE_LIMITER` binding with limit `60` and
  period `60`.
- Assets: `ASSETS`, directory `./public`, with `run_worker_first: true`.
- Variables: `ENVIRONMENT`, `OPENAI_MODEL`, `PRODUCTION_HOST`, `RELEASE_ID`, and
  `TRUSTED_TYPES_MODE` only.
- Worker secrets: `OPENAI_API_KEY`, `PROD_PIN_SALT`, `PROD_PIN_DIGEST`,
  `PROD_IP_HMAC_KEY`, and `PROD_SESSION_KEY` only.
- Release metadata: schema 2 with the exact production host and Worker version.

Any missing or extra binding, variable, secret, route, or public candidate URL
is a release failure. Secret values must never be printed or stored in release
artifacts.

## GitHub environments

The `candidate` environment exposes:

- Variables: `CLOUDFLARE_ACCOUNT_ID`, `OPENAI_MODEL`, `PRODUCTION_HOST`,
  `TRUSTED_TYPES_MODE`.
- Secrets: `CLOUDFLARE_API_TOKEN`, `OPENAI_API_KEY`, `RELEASE_ADMIN_TOKEN`.

The `production` environment exposes:

- Variables: `CLOUDFLARE_ACCOUNT_ID`, `PRODUCTION_HOST`.
- Secrets: `CLOUDFLARE_API_TOKEN`, `PRODUCTION_SMOKE_PIN`,
  `D1_BACKUP_ENCRYPTION_KEY`, `RELEASE_ADMIN_TOKEN`.

`PRODUCTION_HOST` must be `gx.zra.workers.dev`, and `PRODUCTION_SMOKE_PIN` must
be the current six-digit production PIN. Keep production approval protection
enabled and limit candidate deployment to `main`.

## Release

1. Merge the reviewed commit to `main` and confirm CI succeeds for that exact
   SHA.
2. Collect HTTPS evidence URLs for real macOS Safari and iPhone/iOS Safari.
3. Run the `Release` workflow for the current `main` SHA with
   `temporary_relaxation: false` and both evidence URLs.
4. Let the workflow create and attest the unroutable candidate version, encrypt
   the D1 backup, apply migrations, deploy the exact version, run production
   smoke and telemetry checks, and publish the immutable known-good release.
5. Accept the release only when every workflow job succeeds and the published
   release ID equals the deployed commit SHA.

The workflow automatically restores the starting Worker version if a failure
occurs after promotion begins. A failed or cancelled run is not a release.

## Acceptance readback

Confirm all of the following for the deployed release:

- `https://gx.zra.workers.dev/health` returns HTTP 200 with `status: "ok"` and
  the expected release ID.
- The Worker deployment status has exactly one active version at 100% and its
  version ID matches the immutable deployment record.
- The active version has the exact bindings, five variables, and five Worker
  secrets listed above.
- The authenticated Worker subdomain still reports `enabled: true` and
  `previews_enabled: false`.
- Root redirects to `/login`, production PIN login succeeds, authenticated
  session access works, telemetry has no policy violations, and compressed
  assets pass the workflow checks.

## Rollback

Run the `Rollback` workflow with the full lowercase 40-character release SHA.
Only one of the five newest published known-good releases is eligible. The
workflow verifies the signed archive, deployment record, schema compatibility,
exact Worker version, production smoke, and unchanged domain data before it
reports success.

Do not use direct Wrangler rollback or delete commands. If rollback verification
fails, stop and preserve the workflow evidence for diagnosis.
