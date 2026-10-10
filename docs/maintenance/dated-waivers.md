# Dated waivers

`scripts/dated-waivers.ts` derives the dated inventory from each owning registry.
CI validates dates and rejects expired entries. Dates never advance automatically.

The daily `dated-waiver-healing.yml` workflow checks entries during the five days
before expiry. Each kind declares its probe and stress count alongside its owner.
Probe commands run with the individual entry removed, using the owning check.
Every required run must pass before a removal proposal is published. A failed run
requires a root-cause fix; subsequent runs cannot turn that failure into a pass.

Removal proposals include the successful run count, command, runner, source commit
and workflow run link. Each entry has one stable proposal branch, refreshed from
current main. Already removed entries produce no proposal. Commits are signed
through the GitHub API; proposals use `scripts/merge-bar.ts` and respect
`STELLA_MERGE_HOLD`.

Failed probes create or refresh one task per entry in a separate repository whose
privacy is checked before publication. Failure evidence stays local until it is
attached to that private task. It is never uploaded as a public workflow artifact
or written to a public issue, proposal or step summary. The task requires fixing
the root cause without retries, date extensions or weakened checks.
Tasks carry the consumer label `dated-waiver-failure`, declared once as
`DATED_WAIVER_AUTOFIX_LABEL`; labels are provisioned idempotently before use.
Successful removal evidence closes an earlier task so it cannot emit a stale
expiry alert.

Configure the repository variable `DATED_WAIVER_FIX_REPOSITORY` with the private
companion repository's name (without its owner). Install the existing provenance
app on both repositories with contents, pull request and issue write permissions.
The workflow mints its app token only after probes establish a publication need.
Package installation and probe execution receive no write credential.

An unresolved fix task at one day before expiry receives the distinct label
`dated-waiver-expiry-alert`. That label is the machine-readable escalation signal
for the external watcher. The workflow sends no mail; the watcher routes this
signal to its designated recipient. Repeated runs reuse the task and label.

At expiry the waiver lapses and the owning check blocks again. Healing does not
extend dates or grant a grace period after expiry.

An adjacent `test-quarantine-expires: <exact UTC timestamp>` comment owns a
literal `test.skip` or `it.skip` declaration. Its probe unmasks that declaration
and runs the owning test command twenty times; zero-test and skipped-test
receipts cannot pass. Unregistered dated owners fail the inventory census.
