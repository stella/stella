# Better Auth 1.7.3 account cutover

This procedure covers upgrading an instance already running Better Auth
1.7.0–1.7.2 with the issuer backfill and constraints applied. Confirm the
running image digest, package version, and migration receipts before using it.
An older instance must first complete the historical identity migration; this
procedure does not replace Microsoft subject-to-object-ID verification.

Better Auth 1.7.3 writes accounts without `issuer` and identifies them by
`(provider_id, account_id)`. Keeping historical issuer values preserves data;
it does not make new accounts readable by the old runtime. Do not use an
ordinary rolling deployment or automatic application rollback across this
boundary once new account writes are possible.

Upstream reference: [Better Auth 1.7 upgrade guide](https://better-auth.com/docs/guides/1-7-upgrade-guide).

## Rehearse before scheduling the cutover

1. Record the currently running image digest, the candidate image digest, and
   the configuration versions. Keep the auth secret, public origins, provider
   client IDs, session storage, and cookie settings unchanged for this upgrade.
2. Verify a recoverable database backup by restoring it into an isolated
   environment. Keep restored data private. Disable outgoing email, webhooks,
   ingestion, and other external side effects there. Use test provider
   credentials for actual provider sign-ins; never redirect production
   callbacks to the rehearsal.
3. Use the candidate's `pre-account-key` audit to capture the frozen baseline,
   then run its shipped `db:migrate` entrypoint on the restored copy. Require a successful exit, all migration receipts, online index
   validation, and schema parity. Require `post-account-key` to confirm every
   auth row and current policy survived. Run the migrator again and repeat
   that audit to confirm the retry preserves the same baseline.
4. Exercise existing sign-in identities for every enabled provider, account
   linking, new registration, an existing session, session renewal, logout,
   and the OAuth/MCP refresh flow if enabled. Confirm existing identities keep
   their original user IDs and matter access. Provider exchange, Redis,
   cookies, and deployed configuration require environment tests; SQL tests
   alone cannot establish them.
5. Rehearse a failed migration and recovery before admitting new account
   writes. Also rehearse a forward fix after new account writes. Record the
   results against the exact image digests; a different build needs new
   evidence.

The repository's fresh-Postgres CI runs
`scripts/rehearse-better-auth-constraint-retry.sh --local-test-database`.
It checks collision rejection, preservation of the old constraints on that
failure, retry of an invalid concurrent index, and enforcement of the new key.
This fixture is not evidence about the identities in a deployed database.

## Preflight on the target database

Use a restricted operational session. Return aggregate counts only; do not
copy account identifiers or tokens into deployment logs or public artifacts.

```sql
SELECT count(*) AS duplicate_account_keys
FROM (
  SELECT 1
  FROM account
  GROUP BY provider_id, account_id
  HAVING count(*) > 1
) duplicates;

SELECT count(*) AS accounts_without_issuer
FROM account
WHERE issuer IS NULL;
```

For the stated 1.7.0–1.7.2 baseline, require both counts to be zero. Stop on a
collision; resolve it from trusted provider identity evidence, never by
deleting or automatically merging rows. The count is a readiness check, not
a concurrency barrier. The migration's unique index build enforces the key
against writes racing the preflight.

## Cutover with auth traffic paused

1. Pause automatic rollout and rollback for this release. Establish a brief
   maintenance window at the ingress for every auth entry point, including
   callbacks and direct API origins. Drain in-flight requests and stop old
   API instances and any other account writers. Merely hiding sign-in buttons
   does not freeze writes. Session-dependent requests may be temporarily
   unavailable during this window.
2. Re-run preflight after draining writers and take a recoverable checkpoint.
   Run `pre-account-key` below. Keep traffic paused through migration and smoke
   tests. Do not rerun the historical 1.6 identity/OAuth backfill: its legacy
   client fields can be stale after the 1.7 runtime has accepted new clients.
3. Run the candidate image's shipped migration command. It builds and repairs
   the provider/account unique index before making issuer nullable. The online
   migration phase verifies the replacement's definition, readiness, and
   validity before dropping the issuer index. Require the entire command to
   succeed, not just a migration receipt. Run `post-account-key` against the
   saved baseline before any runtime smoke test can create or update rows.
4. Start only the candidate API instances behind the maintenance boundary.
   Require startup checks and verify that no old image remains routable.
   Use an operator-only route for smoke tests with dedicated test accounts.
   Run the read-only health command below and require exit code zero.
5. Verify an existing session and an existing account first; then verify new
   registration/linking and subsequent sign-in. Confirm stable user IDs,
   correct access, and no duplicate account keys. Creating a new account marks
   the rollback boundary described below.
6. Reopen traffic only after every required check passes. Monitor auth error
   rates and new-account failures. Keep the maintenance control available for
   a forward fix.

## Failure and recovery boundaries

- **Migration fails before cutover:** keep traffic paused and inspect the
  failed step. A duplicate-key failure keeps rows, the issuer index, and
  issuer's `NOT NULL` intact. An invalid concurrent index may remain; after
  trusted resolution, rerun the same migration to repair it. Do not mark the
  receipt manually or bypass validation.
- **Migration succeeds, no new auth writes have occurred:** the old image may
  be a recovery candidate only if the rehearsal proved it accepts the changed
  schema and every account still has its trusted issuer. Otherwise restore
  the verified checkpoint while writers remain stopped. Do not assume an
  application-only rollback will pass startup migration checks.
- **New auth writes have occurred:** treat the release as forward-only.
  Old code cannot resolve NULL-issuer accounts through its issuer lookup.
  Pause traffic and repair the candidate. Restoring a pre-cutover backup
  discards subsequent writes and requires an explicit recovery decision;
  it is not a lossless rollback. Never invent issuers to make old constraints
  pass.

## Frozen account-key migration audit

Run these commands in the candidate image, before and after migration:

```sh
bun /app/better-auth-migration-audit.js pre-account-key \
  --baseline /private/auth-account-key-baseline.json \
  --oauth-base-url "${PUBLIC_URL:-$BETTER_AUTH_URL}"

# Run the shipped migration command while all writers remain stopped.

bun /app/better-auth-migration-audit.js post-account-key \
  --baseline /private/auth-account-key-baseline.json \
  --oauth-base-url "${PUBLIC_URL:-$BETTER_AUTH_URL}"
```

Keep the baseline in private ephemeral storage; never publish it as an
artifact. These modes compare the current auth data without applying the
historical issuer or OAuth projections. They are for the frozen transition;
use health mode once writes resume.

## Recurring database health check

```sh
bun --filter @stll/api db:audit-better-auth health \
  --oauth-base-url https://api.example.invalid
```

Use the configured MCP origin (`PUBLIC_URL` when set, otherwise
`BETTER_AUTH_URL`). In a release image, invoke:

```sh
bun /app/better-auth-migration-audit.js health \
  --oauth-base-url "${PUBLIC_URL:-$BETTER_AUTH_URL}"
```

Health mode needs no baseline or identity map and writes neither files nor
database rows. It uses a repeatable-read, read-only transaction with timeouts.
Output contains named checks and statuses; exit codes are `0` for passed,
`1` for an invariant failure, and `2` for invalid configuration or a failed
query. A timeout is a failed check invocation, never a healthy result.

The checks cover the current table/column inventory, provider/account key
completeness and uniqueness, required account constraints, foreign keys and
orphans, structural auth access boundaries, and the configured OAuth resource
policy. NULL issuers and account/session growth are valid. This database
check does not prove provider availability, cookie handling, Redis behavior,
or end-to-end authorization; keep environment smoke tests alongside it.

The same command's migration modes still verify the frozen 1.7 backfill
against its saved baseline, including trusted issuer projections. Use those
only during that migration, with writes frozen. Run `health` after normal
traffic resumes.
