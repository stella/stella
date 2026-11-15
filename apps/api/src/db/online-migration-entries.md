# Online migration entries

Add an entry module in `online-migration-entries/`, checked with
`satisfies OnlineMigrationEntry`, and run
`bun scripts/generate-online-migration-entries.ts` from the repository root.
Commit the entry and its generated export. The export index contains no values;
changing an existing entry does not change the index.

Each entry has a stable descriptive id, a unique positive integer revision,
a phase (`indexes`, `cutovers`, `replacements`, `repairs`, or `constraints`),
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
