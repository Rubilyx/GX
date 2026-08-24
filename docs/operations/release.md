# GX production-only release runbook

`gx.zra.workers.dev` is the only public application host. Release and rollback
must use the repository `Release` and `Rollback` workflows. Do not run `wrangler deploy`, `wrangler versions deploy`, or a direct production rollback from a workstation.

## Steady-state contract

- Worker: `gx`, `workers_dev: true`, `preview_urls: false`, with no `route` or
  `routes` entry.
- Authenticated Worker subdomain: `enabled: true`, `previews_enabled: false`.
- D1: exactly one `PROD_DB` binding to `gx-production`.
- Private R2: exactly one `THREADS_MEDIA` binding to `gx-threads-media`. The
  bucket must have neither an `r2.dev` public URL nor a custom public domain.
- Queue producers: `THREADS_CAPTURE_QUEUE` to `gx-threads-capture` and
  `THREADS_MEDIA_QUEUE` to `gx-threads-media`.
- Queue consumers: `gx-threads-capture` uses batch 10, three retries, and
  `gx-threads-capture-dlq`; `gx-threads-media` uses batch 1, three retries, and
  `gx-threads-media-dlq`. Both primary consumers target Worker `gx`.
- Active DLQ consumers: `gx-threads-capture-dlq` uses batch 10 and zero retries;
  `gx-threads-media-dlq` uses batch 1 and zero retries. Both target Worker `gx`
  so terminal failures are recorded rather than silently accumulating.
- Cron: exactly one schedule, `0 3 * * *` (03:00 UTC daily).
- Rate limiter: exactly one `REPORT_RATE_LIMITER` binding with limit `60` and
  period `60`.
- Assets: `ASSETS`, directory `./public`, with `run_worker_first: true`.
- Variables: `ENVIRONMENT`, `OPENAI_MODEL`, `PRODUCTION_HOST`, `RELEASE_ID`,
  `TRUSTED_TYPES_MODE`, `THREADS_APP_ID`, `THREADS_CAPTURE_QUEUE_NAME`,
  `THREADS_MEDIA_QUEUE_NAME`, `THREADS_CAPTURE_DLQ_NAME`, and
  `THREADS_MEDIA_DLQ_NAME` only. The four queue-name values must equal the four
  production queue names above.
- Worker secrets: `OPENAI_API_KEY`, `PROD_IP_HMAC_KEY`, `PROD_PIN_DIGEST`,
  `PROD_PIN_SALT`, `PROD_SESSION_KEY`, `THREADS_APP_SECRET`, and
  `THREADS_TOKEN_KEY` only.
- Release metadata: schema 2 with the exact production host and Worker version.

Any missing or extra binding, variable, secret, queue consumer, schedule, route,
or public candidate URL is a release failure. Secret values and access tokens
must never be printed, included in command arguments, or stored in release
artifacts. Workflow evidence may contain secret names only.

## Meta approval and protected environments

Complete Meta application review before setting the production app ID or
connecting an account. The approved redirect URI must be
`https://gx.zra.workers.dev/threads/oauth/callback` and the approved minimum scopes are exactly
`threads_basic`, `threads_profile_discovery`, and `threads_read_replies`.
Confirm the app remains approved for those scopes before each production
connection; do not add publishing or management scopes to this read-only
archive.

The protected `candidate` environment exposes these variables:
`CLOUDFLARE_ACCOUNT_ID`, `OPENAI_MODEL`, `PRODUCTION_HOST`,
`TRUSTED_TYPES_MODE`, `THREADS_APP_ID`, and the four queue-name variables. It
exposes `CLOUDFLARE_API_TOKEN`, `OPENAI_API_KEY`, and `RELEASE_ADMIN_TOKEN` as
workflow secrets. `THREADS_APP_ID` is a canonical nonzero decimal Meta app ID
of at most 32 digits; it is never committed to `wrangler.jsonc`.

The protected `production` environment exposes `CLOUDFLARE_ACCOUNT_ID`,
`PRODUCTION_HOST`, `THREADS_APP_ID`, and the same four queue-name variables. It
exposes `CLOUDFLARE_API_TOKEN`, `PRODUCTION_SMOKE_PIN`,
`D1_BACKUP_ENCRYPTION_KEY`, and `RELEASE_ADMIN_TOKEN` as workflow secrets.

The seven Worker secrets are managed in Cloudflare before the immutable release
flow. `THREADS_TOKEN_KEY` must be a random 32-byte base64 key. Never copy its
value, `THREADS_APP_SECRET`, or a Threads access token into GitHub variables,
logs, artifacts, screenshots, or incident tickets. Keep environment approval
protection enabled and limit candidate deployment to `main`.

## Pre-release readback

Before approving promotion, require the workflows to prove all of the following
with authenticated, read-only API calls:

- The latest/candidate Worker version has exactly the D1, private R2, Queue
  producer, assets, rate-limit, seven secret-name, and ten variable bindings in
  the steady-state contract. Unknown binding types fail closed.
- The script schedule API returns only `0 3 * * *`.
- Each of the four Queue API readbacks returns exactly one Worker consumer for
  `gx`, with its exact batch size, retry count, and primary DLQ link.
- `gx-threads-media` remains private. In the R2 dashboard or an approved
  read-only account inventory, confirm public development access and custom
  domains are disabled; a request to an unapproved public bucket hostname must
  not expose an object.
- Queue backlog inspection shows expected traffic. Inspect both primary queues
  and both DLQs; unexplained primary growth or any untriaged DLQ entry blocks
  promotion.

These checks validate existing infrastructure only. They do not provision a
bucket or queue, change a consumer, update a schedule, or rotate a secret.

## Release and migration order

1. Merge the reviewed commit to `main` and confirm CI succeeds for that exact
   SHA. CI must keep the eight evidence gates and pass the exact test Wrangler
   configuration/type check before recording them.
2. Confirm Meta approval, the exact scopes, private-bucket state, queue
   consumers/backlogs, cron, and all protected variables and secret names.
3. Collect HTTPS evidence URLs for real macOS Safari and iPhone/iOS Safari.
4. Run the `Release` workflow for the current `main` SHA with
   `temporary_relaxation: false` and both evidence URLs.
5. The workflow creates and verifies the immutable candidate, then exports and
   encrypts the production D1 backup before any migration. Preserve the backup
   digest and encrypted workflow artifact according to the release retention
   policy.
6. Apply outstanding migrations in filename order: `0002_repository_activity`,
   then `0003_repository_notes`, then `0004_threads_archive`. Never apply 0004
   before 0002 and 0003, and never migrate before the backup and active-version
   resource recheck have passed.
7. Promote the exact candidate version at 100%, verify the production resource
   graph and schedule/consumers again, run the controlled read-only smoke and
   telemetry checks, then publish the immutable known-good release.
8. Accept the release only when every workflow job succeeds and the published
   release ID equals the deployed commit SHA.

The controlled live smoke uses only the protected workflow, the production PIN,
and the already approved Threads connection. It may read the profile/archive
state and exercise a capture request only when the release operator explicitly
approves live provider traffic. It must not publish, reply, or expose provider
tokens. If the account is disconnected, expired, scope-mismatched, or token
decryption fails, stop the smoke and use the authenticated Threads reconnect
flow; never patch token rows or paste a token into D1.

## Acceptance readback and queue operations

Confirm all of the following for the deployed release:

- `https://gx.zra.workers.dev/health` returns HTTP 200 with `status: "ok"` and
  the expected release ID.
- Deployment status has exactly one active version at 100%, matching the
  immutable deployment record and exact version-bound resource graph.
- The schedule and all four Queue consumers still match the steady-state
  contract; the R2 bucket remains private.
- Root redirects to `/login`, production PIN login succeeds, authenticated
  session access works, telemetry has no policy violations, and compressed
  assets pass the workflow checks.
- Capture/media primary backlog is draining. Inspect `gx-threads-capture-dlq`
  and `gx-threads-media-dlq` for recorded terminal failures. Diagnose and retain
  evidence before using the authenticated retry control; do not purge a DLQ to
  make a release appear healthy.

For a Threads authentication failure, use the in-application disconnect and
reconnect controls. Reconfirm the three exact scopes and expected provider user
before permitting scheduled capture again.

## Rollback

Run the `Rollback` workflow with the full lowercase 40-character release SHA.
Only one of the five newest published known-good releases is eligible. Before
allocation changes, the workflow verifies the signed archive, deployment
record, schema compatibility, exact target and active version bindings, and the
current script schedule/Queue consumers. After allocation, it verifies the
restored version and script-level resources again, then runs production smoke
and unchanged-domain-data checks.

Rollback changes only Worker version allocation; it does not reverse D1
migrations 0002, 0003, or 0004 and does not mutate R2 objects or queue messages.
The target must therefore pass the compatibility gate against the current
schema. The `Release` workflow automatically restores the starting version if a
failure occurs after promotion begins. A failed or cancelled run is not a
release.

Do not use direct Wrangler rollback or deletion commands. If rollback or its
restored resource readback fails, stop, preserve the workflow evidence and D1
backup, inspect both DLQs, and use the documented forward-fix path.
