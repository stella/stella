# Dated waivers

`scripts/dated-waivers.ts` derives the dated inventory from each owning registry.
CI validates dates and rejects expired entries for every merge candidate,
including changes that do not select package checks. Dates never advance
automatically.

The daily `dated-waiver-healing.yml` workflow checks entries during the five days
before expiry. Each kind declares its probe and stress count alongside its owner.
Probe commands run with the individual entry removed, using the owning check.
Every required run must pass before a removal proposal is published. A failed run
requires resolution evidence before a removal proposal can be published.
All entries share a 45-minute probe-phase budget. Remaining time is divided
among remaining samples, with a ten-minute ceiling per command. Exhaustion is
recorded as red timeout evidence, leaving the workflow time to publish fix tasks.

Removal proposals include the successful run count, command, runner, source commit
and workflow run link. Each entry has one stable proposal branch, refreshed from
current main. Already removed entries produce no proposal; an existing proposal
is closed with a neutral note.
Matching files are reused only when the proposal commit is based directly on the
probed main commit; otherwise the proposal is rebuilt from that commit.
Commits are signed through the GitHub API; proposals use `scripts/merge-bar.ts` and respect
`STELLA_MERGE_HOLD`.
Any merge-bar refusal or execution failure fails the scheduled publication run.
A red probe, blocked resolution or lapsed entry retires its pending removal
proposal: merge-bar disarms it before it is closed with a neutral note. A later
eligible green run creates a fresh proposal. Failure evidence remains private,
and a disarm failure propagates so publication cannot report success.
Entries complete independently: red task evidence is published first; retirement
and expiry signals are attempted even when another action fails. Green actions
retain their prerequisites before arming. Every entry is processed, then the run
fails once with a typed list of failed operations. Public output exposes only
opaque entry keys and operation names in the `dated-waiver-failed` signal;
captured diagnostics stay private. Probe setup failures and invalid evidence
records are carried to the publication boundary so valid siblings still finish.
Independent module validation and proposal-content reads also aggregate failures
before any dependent publication write.

Failed probes create or refresh one task per entry in a separate repository whose
privacy is checked before publication. Failure evidence stays local until it is
attached to that private task. It is never uploaded as a public workflow artifact
or written to a public issue, proposal or step summary. The task requires fixing
the root cause without retries, date extensions or weakened checks.
Tasks carry the consumer label `dated-waiver-failure`, declared once as
`DATED_WAIVER_AUTOFIX_LABEL`; labels are provisioned idempotently before use.
An earlier failure also requires resolution evidence before removal. Repository
probes (suppression waivers and quarantined tests) require a changed commit and
source fingerprint, or a closed task linked to a merged change included in the
probe commit. URL, release-age and dependency-audit probes can recover as their
external state changes: a later full N/N green observation qualifies even on the
same source. Completion timestamps are recorded with both failure and green
evidence. The total per-kind policy is declared in the private task sink.
Fingerprints cover sources with the waiver removed and pinned dependency
lockfiles; changing the target deadline does not qualify. Eligible evidence
closes an earlier task so it cannot emit a stale expiry alert.

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
