# Dated waivers

`scripts/dated-waivers.ts` derives the dated inventory from each owning registry
and is the only check that compares an expiry with the clock. Owning checks
validate the shape of their dates, never their expiry. CI validates dates for
every merge candidate, including changes that do not select package checks. An
expired entry fails a pull request or merge group only when the change touches
the file that declares it; time alone never fails an unrelated change. The
daily `dated-waiver-healing.yml` run checks every entry on the default branch,
so an expiry nobody touches still fails there and alerts its owner. Dates
never advance automatically, with one exception: a documentation waiver whose
recheck confirms its premise (see below).

A `no-llms-txt` waiver asserts that a dependency publishes no llms.txt. When
every sample of its probe receives HTTP 404 or 410, healing records it as
absent and renews it on main: `checkedAt` becomes the start of the UTC day and
`expiresAt` follows 30 days later. All renewals of a run go into one proposal
on the reserved `chore/dated-waiver-renewal` branch, published and armed like
removal proposals; a run with nothing to renew closes an open one. Read-only
discovery checks that branch every run, so an open renewal proposal needs a
write even when no entry is due. Entries that
share one date constant renew only when every entry sharing it was confirmed
absent; the others are held and named in the `dated-waiver-renewal` signal.
A network error, timeout, redirect or any other status stays red and opens the
private task, so an unconfirmed premise is reported, never renewed. A 200
response publishes the removal proposal that registers the source.
Dispatching the workflow with `dry_run` probes and prints the planned renewal
without minting a write token.

The daily `dated-waiver-healing.yml` workflow checks entries during the five days
before expiry. Each kind declares its probe and stress count alongside its owner.
Probe commands run with the individual entry removed, using the owning check.
Every required run must pass before a removal proposal is published. A failed run
requires resolution evidence before a removal proposal can be published.
An empty inventory completes successfully with exit code zero when no outstanding
removal proposals need retirement. No probes or fix tasks run. Read-only discovery
checks outstanding reserved-branch proposals against the full inventory each run,
including entries outside the grace window. Proposals whose identity disappeared
are disarmed and closed with a neutral note, with failures collected alongside
other entry operations. A write token is minted only when entry work or proposal
retirement is needed.
All entries share a 45-minute probe-phase budget. Remaining time is divided
among remaining samples, with a ten-minute ceiling per command. Exhaustion is
recorded as red timeout evidence, leaving the workflow time to publish fix tasks.

Removal proposals include the successful run count, command, runner, source commit
and workflow run link. Each entry has one stable proposal branch, refreshed from
current main. Already removed entries produce no proposal; an existing proposal
is closed with a neutral note.
Commits are signed through the GitHub API; proposals are queued with
`gh pr merge --auto`, pinned to the published head with `--match-head-commit`.
When `STELLA_MERGE_HOLD` is set, an existing proposal is disarmed before either
reserved branch is refreshed, and arming is skipped.
Removal commits are always rebuilt from the probed base; only the PR number is
reused. The reserved branch is force-updated to the freshly signed commit, then
its head and complete tree are verified against the generated commit before
publication can arm it. Existing proposal contents never enter the new tree.
Any failed arm or disarm fails the scheduled publication run.
A red probe, blocked resolution or lapsed entry retires its pending removal
proposal: `gh pr merge --disable-auto` disarms it before it is closed with a
neutral note. A later eligible green run creates a fresh proposal. Failure evidence
remains private,
and a disarm failure propagates so publication cannot report success.
Entries complete independently: red task evidence is published first; retirement
and expiry signals are attempted even when another action fails. Green actions
retain their prerequisites before arming. Every entry is processed, then the run
fails once with a typed list of failed operations. Public output exposes only
opaque entry keys and operation names in the `dated-waiver-failed` signal;
captured diagnostics stay private. Probe setup failures and invalid evidence
records are carried to the publication boundary so valid siblings still finish.
Independent module validation aggregates failures before any dependent
publication write.

Waiver keys combine kind, owner file and semantic identity; line numbers are edit
locators only. Release-age exceptions use their covered zero-age command, so
unrelated line shifts or sibling removals retain task and proposal history.
Two entries with the same identity in one owner file fail as ambiguous.

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

At expiry the waiver lapses. Kinds that fail the gate (`EXPIRY_AT_CHANGE_GATE`)
fail the default-branch check and every change that touches their owner file
until the entry is removed or renewed. An elapsed temporary release-age
exclusion only annotates; `quarantine-prune.yml` proposes its removal, and the
lockfile release-age guard stops exempting new pins of its package. Healing
never renews a lapsed entry or grants a grace period after expiry.

An adjacent `test-quarantine-expires: <exact UTC timestamp>` comment owns a
literal `test.skip` or `it.skip` declaration. Its probe unmasks that declaration
and runs the owning test command twenty times; zero-test and skipped-test
receipts cannot pass. Unregistered dated owners fail the inventory census.

Entries in `scripts/flaky-test-quarantine.json` are inventoried as
`flaky-test-quarantine`. Their probe runs the test without its entry; an
elapsed entry only annotates pull requests and merge groups, because the
scheduled flaky-test quarantine workflow enforces it on main (see
[flaky-test-quarantine.md](flaky-test-quarantine.md)).
