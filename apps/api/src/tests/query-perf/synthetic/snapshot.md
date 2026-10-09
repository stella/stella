# Query performance fixture snapshots

The perf job seeds a profile-specific PostgreSQL database on a cache miss, then saves a custom-format archive with `apps/api/scripts/query-perf-snapshot.ts`. The CLI requires the profile ID and an explicit loopback fixture URL; it never reads `DATABASE_URL`. Install PostgreSQL client binaries matching the server major before invoking it.

Generate the exact key from the repository root (replace the settings and seed paths with the harness owners):

```sh
bun apps/api/scripts/query-perf-snapshot.ts key \
  --root "$PWD" --profile-id small --pg-major 18 \
  --seed-entry apps/api/src/tests/query-perf/seed.ts \
  --settings apps/api/src/tests/query-perf/planner-settings.json
```

The key includes the required profile ID (`small` or `growth`) and hashes the complete migration tree (including metadata), all synthetic files (including the profile), the seed's transitive imports, lockfile, snapshot wrapper, explicit settings file and PostgreSQL major. The profile ID appears in the returned key and hash input, so profiles cannot share a snapshot. No prefix restore keys are permitted: a changed migration, distribution or setting rebuilds the fixture.

The workflow can use the repository's pinned cache action:

```yaml
- uses: actions/cache/restore@55cc8345863c7cc4c66a329aec7e433d2d1c52a9 # v6.1.0
  id: perf-snapshot
  with:
    path: .cache/query-perf.dump
    key: ${{ steps.snapshot-key.outputs.key }}
    # Deliberately no restore-keys.
```

On a miss, create the fixture, migrate, seed and `ANALYZE` through the harness. Report the generator's seed duration, then save:

```sh
bun apps/api/scripts/query-perf-snapshot.ts save \
  --database-url "$QUERY_PERF_DATABASE_URL" --profile-id small --pg-major 18 \
  --archive .cache/query-perf.dump
```

Save only successful fixtures, using `actions/cache/save` at the same SHA with the identical path and key. The save command reports `saveMs` and `archiveBytes`; replacement of the archive is atomic.

On a hit, create a fresh fixture database, provision the application role and run the same migrations as on a miss, then restore:

```sh
bun apps/api/scripts/query-perf-snapshot.ts restore \
  --database-url "$QUERY_PERF_DATABASE_URL" --profile-id small --pg-major 18 \
  --archive .cache/query-perf.dump
```

The archive contains data only for `SYNTHETIC_TABLES` in `tables.ts`, the same table inventory used by the generator; migration/configuration rows stay outside the archive. Restore refuses any populated synthetic table. It uses `pg_restore --exit-on-error --single-transaction --data-only --disable-triggers --no-owner`, followed by `ANALYZE`, and reports `restoreMs` and `archiveBytes`. Migrations establish schema, policies and role grants on both hit and miss paths. Run restoration as the fixture superuser: temporarily disabling triggers handles cyclic foreign keys inside the atomic restore. A restore failure rolls back its data changes; do not measure a failed fixture.

The workflow measures cache download wall time separately. Fixture preparation reports `archiveRestoreMilliseconds` from `restoreMs`, plus full `restoreMilliseconds` including connection checks, empty-table validation, and reading restored identities and counts. `totalRestoreMilliseconds` adds download to full preparation time. The one-minute target is measured on the selected CI runner; archive restore alone does not establish it. Actions cache storage is bounded by repository cache limits: record archive size and eviction frequency before considering another storage backend.
