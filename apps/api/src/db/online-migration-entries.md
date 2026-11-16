# Online migration entries

Add an entry module in `online-migration-entries/`, checked with
`satisfies OnlineMigrationEntry`, and run
`bun scripts/generate-online-migration-entries.ts` from the repository root.
Commit the entry and its generated export. The export index contains no values;
changing an existing entry does not change the index.

Each entry has a stable descriptive id, a unique positive integer revision,
a lifecycle, a phase (`indexes`, `cutovers`, `replacements`, `repairs`, or `constraints`),
and that phase's values. Revisions sort groups within each phase; array order
inside a group preserves its owner's order. The initial revisions preserve the
existing execution sequence. Choose a later revision for new work; do not
renumber existing entries. Migration identities in `introducedBy` and repair
checkpoint names retain their existing meaning independently of these revisions.

The generator writes a deterministic sorted export index, and its checker
requires an exact match. Independent additions at separate positions merge
normally. If adjacent exports conflict, keep both entry modules and regenerate
the index; never resolve generated exports by hand. Execution order always
comes from revisions, independently of export order or filesystem enumeration.
Entry modules must have no side effects; importing them only declares work,
and the runner owns execution.

Use exported constants for unique-index dependencies in entry modules. For
example, a replacement entry imports `ONLINE_UNIQUE_INDEX_NAMES` from
`../online-unique-indexes` and declares its dependency as:

```ts
replacementNames: [ONLINE_UNIQUE_INDEX_NAMES.ACCOUNT_PROVIDER_ACCOUNT_ID_UIDX];
```

`bun scripts/check-online-index-dependencies.ts` checks entry modules along
with other consumers and rejects raw unique-index names. The index generator
only emits module exports; it never copies or rewrites entry values.

A new entry is `lifecycle: "pending"`: its work may still be building after a
rollout. It becomes `"finalized"` once a promoted release carries the entry
unchanged; `bun scripts/check-online-migration-lifecycle.ts` (run by
`scripts/check-migrations.sh`) enforces this against the release in
`apps/landing/src/data/changelog-release-dates.json`. Work that code depends on
in the same release (for example an `ON CONFLICT` arbiter index) may be
finalized early only through a reasoned entry in
`scripts/online-migration-lifecycle-exemptions.json`; the exemption lapses
once the release carries the entry. The check compares the entry module, not
definitions it imports from shared modules: a finalized entry is built by
`migrate` inside the deploy, so a changed definition behind it still runs
before the new release serves.

`migrate` builds every entry by default. `migrate --online=finalized` builds
only finalized entries and leaves pending ones to be built after the rollout.
Startup records an incomplete pending step as pending whatever migration is
newest, and still refuses an incomplete finalized index, cutover or retirement
outside its deploy window; repairs keep their own startup rule.
