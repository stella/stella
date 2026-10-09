# Module ownership

One capability, one owning module. Each row is declared in
`scripts/ownership/<id>.ts` and documented in
[`docs/module-ownership/<id>.md`](module-ownership/). Add a new file, then run
`bun scripts/ownership.ts --write`; no shared index needs an edit.

Before adding a helper, module, or schema, search `scripts/ownership/`,
`docs/module-ownership/` and `packages/*`. Print the full table with
`bun scripts/ownership.ts --print`. Extend the owner, or say in the pull request why a second
implementation is correct.

Rows whose enforcement is not `none` are also read by the
`confine-owner/confine-owner` lint rule, which reports any linted file outside
the owner and its `allowed` list. Add a bypass by adding an `allowed` entry with a
reason, in the same row file.

Schema export owners inherit the exact files in `SCHEMA_INTROSPECTION`.
The ownership check follows their runtime dependencies and checks that they
only enumerate schema metadata. The ratchet measures each shared path;
additions require a justified allowance and removals are free.
