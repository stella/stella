# Dated exceptions

The hourly quarantine maintenance workflow uses the provenance app to propose
changes for every exception due within 72 hours. The inventory derives each
entry from its owning guard parser; unregistered dated policy owners fail.

Each entry has a stable ready proposal, refreshed from main. A successful removal
probe opens and requests automatic maintenance through the existing bot armer.
Release-age exclusions are proposed early but cannot merge before expiry: the
required check compares base and head bunfigs and rejects premature removals.
At expiry the scheduler refreshes the proposal so CI evaluates the eligible head;
a subsequent run requests arming after exact-head CI succeeds. The bot armer
regenerates the complete removal using trusted main code before minting its token.
Every bunfig carrying the same exclusion is included. An empty inventory writes
nothing. Repeated runs retain unchanged proposal heads.

Unresolved exceptions get an extension request with `owner-reason:` in the body
and `.github/dated-exception-proposals/<key>.json`. The placeholder fails CI.
An owner must record a concrete reason in both places and explicitly change the
owning deadline or resolve the cause. Automatic code never advances a date;
refreshes preserve owner edits to extension requests. Persisted review records
remain valid after the exception is removed. A merge hold prevents arming.

Only wall-clock expiry is scoped in pull requests and merge groups: an elapsed
entry fails changes to its owning file; release-age exclusions also cover the
applicable lockfile and manifests pinning that package. Unrelated changes emit a
warning naming the entry and remediation. Main and scheduled checks remain
blocking for all expired entries. Malformed dates, missing annotations, invalid
globs, incomplete exclusions and other structural errors always block.

The existing required expiry check consumes a prepared local context so its
offline phase needs neither network access nor subprocesses. PR and merge-group
contexts use their exact event base commit and fail closed if it cannot be read.

## Inventory JSON contract

Run `bun scripts/dated-waiver-inventory.ts --within 72h --json`.
Omit `--within` for the complete inventory. The horizon includes overdue entries
and the exact boundary. Invalid durations fail; durations use whole hours.

The version 1 envelope is `{schemaVersion: 1, entries: [...]}`. Each entry contains
`kind`, `file`, `entry` (semantic identity), `expiryInstant` (exact UTC instant),
`owner` (the canonical owning registry file), `canRemoveYet`, `removal`, and `probe`
(`command` and required `attempts`). `canRemoveYet` is a boolean for release-age
exclusions: removal becomes eligible exactly at expiry. It is `null` for other
kinds, whose removal needs successful probes; `removal` is respectively
`at-expiry` or `requires-probe`. The inventory never claims a probe passed from
the date alone. Date-only deadlines hold through their entire UTC day.

Consumers must select by `kind`, `file`, and `entry`, never by array position or
line number. The inventory uses the guard parsers and rejects unregistered dated
policy owners. Ratchet allowances currently forbid expiry fields rather than
creating dated exceptions. New dated kinds need an adapter and removal probe;
they cannot silently enter the inventory as ordinary JSON dates.
