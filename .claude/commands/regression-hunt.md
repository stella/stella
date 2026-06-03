# Regression Hunt

Track down a behavior that used to work and now fails, changed, or
regressed. Use this when a bug report points to a recent breakage,
especially when the cause is not obvious yet.

## Arguments

$ARGUMENTS — A short description of what regressed.

Helpful extras when available:
- failing test name or file
- error message or log line
- expected vs actual behavior
- suspect PR, branch, commit, or file
- reproduction command, input, route, or endpoint

A plain-English bug report is enough to start.

## Instructions

### 1. Restate the regression clearly

- what used to work?
- what is broken now?
- what is expected instead?

### 2. Build a feedback loop (this is the skill)

Everything else is mechanical. With a fast, deterministic, agent-runnable
pass/fail signal, bisection and hypothesis testing all just consume it.
Without one, no amount of staring at code will save you. Spend
disproportionate effort here. Be aggressive. Be creative. Refuse to give up.

Try these in roughly this order:

1. Run the failing test via the package's test script — e.g.
   `bun run test -- --bail -t "<pattern>"` — so flags wired into the
   script (`--preload`, custom setup) are preserved; calling `bun test`
   directly bypasses them. Avoid `bun --bun test` from a worktree root.
   Note that `bun test` positional arguments are **file path patterns**,
   not test names; use `-t "<pattern>"` to filter by test name and
   `--bail` to fast-fail.
2. Curl / HTTP script against the backend dev server. Wrap fetches in
   `AbortSignal.timeout(10_000)` so a hung request does not rot the loop.
3. CLI invocation diffing stdout against a known-good snapshot.
4. Headless browser (Chrome DevTools MCP, Playwright, or similar) against
   the frontend dev server.
5. Replay a captured trace (saved payload, event log) through the code path
   in isolation.
6. Throwaway harness exercising just the bug code path with a single
   function call. For DB-touching code, a fresh test database per loop is
   usually faster and more honest than mocking.
7. Differential loop: same input through old-commit vs new-commit, diff
   outputs.
8. Bisection harness against the loop above. Drive it through the
   package script so wired flags survive, e.g.:
   `git bisect run bun run test -- --bail -t "<test-name>"`.
   Verify the harness actually fails on a known-bad commit before
   starting — `bun test` exits 0 when no test names match, which would
   silently mark every commit as good and produce the wrong culprit.
9. Property / fuzz loop if the bug is "sometimes wrong output".

Then treat the loop as a product. Iterate on it:

- **Faster?** Cache setup, skip unrelated init, narrow scope.
- **Sharper signal?** Assert on the specific symptom, not "didn't crash".
- **More deterministic?** Pin time, seed RNG, isolate filesystem, freeze
  network.

A 30-second flaky loop is barely better than no loop. A 2-second
deterministic loop is a debugging superpower.

For non-deterministic bugs the goal is a **higher reproduction rate**, not a
clean repro. Loop the trigger 100×, parallelise, narrow timing windows,
inject sleeps. A 50%-flake bug is debuggable; 1% is not — keep raising the
rate until it is.

If you genuinely cannot build a loop, stop and say so explicitly. List what
you tried. Ask the user for: environment access, a captured artifact (HAR,
log dump, screen recording with timestamps), or permission to add temporary
instrumentation. Do **not** proceed to hypothesise without a loop.

### 3. Encode the regression in a test before fixing it

Only if a **correct seam** exists — one where the test exercises the real
bug pattern as it occurs at the call site. A test at the wrong seam (too
shallow, single-caller test when the bug needs multiple callers, unit test
that cannot replicate the trigger chain) gives false confidence.

If no correct seam exists, that itself is the finding. Note it and flag the
architectural gap for step 10. The codebase is preventing the bug from
being locked down.

Prefer focused integration tests over deep unit tests when the regression
crosses layers. If the area has no automated harness, build the smallest
reproducible check and say why a proper regression test was not added yet.

### 4. Generate 3–5 ranked hypotheses before instrumenting

Single-hypothesis generation anchors on the first plausible idea. Each
hypothesis must be **falsifiable** — state its prediction:

> If <X> is the cause, then <changing Y> will make it disappear /
> <changing Z> will make it worse.

If you cannot state a prediction, the hypothesis is a vibe — sharpen or
discard. Show the ranked list to the user before testing; domain knowledge
often re-ranks instantly ("we just deployed a change to #3"). Don't block
on it if the user is AFK; proceed with your own ranking.

### 5. Inspect recent change history

- current diff
- recent commits touching the area
- suspect PRs or refactors
- **React Compiler:** if the regression is a re-render / stale-closure /
  perf shift in the frontend, check whether the compiler's output for the
  affected component changed. A lot of "this used to memoize and now it
  doesn't" bugs live here, not in your hand-written code.

Use git history when helpful, but do not stop at blame; verify the actual
cause. For regressions specifically, `git bisect run` against your step 2
loop is often the fastest path to the offending commit.

### 6. Instrument

Each probe must map to a specific prediction from step 4. Change one
variable at a time.

Preference:

1. **Bun inspector.** `bun --inspect-brk` is a runtime flag that must
   attach to the process actually running the code, which means wrapping
   it in `bun run <script>` will not propagate to the spawned child.
   Either prepend `--inspect-brk` to the test command inside your
   package script temporarily, or invoke directly while replicating the
   flags the script wires — e.g. `bun --inspect-brk test --preload
   ./setup.ts <file-path>`. Open the printed `devtools://` URL in
   Chrome, set one breakpoint at the suspected fault. One breakpoint
   beats ten logs.
2. Targeted logs at the boundaries that distinguish hypotheses.
3. Never "log everything and grep".

Tag every debug log with a unique prefix, e.g. `[DEBUG-a4f2]`. Cleanup at
the end becomes a single grep — untagged logs survive; tagged logs die.

For performance regressions, logs are usually wrong. Establish a baseline
measurement first — prefer `Bun.nanoseconds()` over `performance.now()` on
the backend (sharper resolution, no Node-portability tax), or a query plan
for DB regressions — then bisect. Measure first, fix second.

### 7. Fix it minimally

- preserve intended newer behavior where possible
- do not revert unrelated improvements just to make the symptom disappear
- identify the exact logic, assumption, or edge case that changed, not just
  the line that surfaces it

### 8. Verify

- regression test now passes (or absence of correct seam is documented)
- original repro from step 2 no longer reproduces
- relevant wider checks pass (lint / typecheck / scoped tests)

### 9. Cleanup

- [ ] All `[DEBUG-...]` instrumentation removed (`grep` the prefix)
- [ ] Throwaway harnesses deleted or moved to a clearly-marked debug
      location
- [ ] The hypothesis that turned out correct is stated in the commit / PR
      message — so the next debugger learns

### 10. Post-mortem

Ask: **what would have prevented this regression?** Make this
recommendation *after* the fix is in — you have more information now than
when you started.

Lenses to apply:

- **Type system could have caught it?** Lift the constraint into types
  (branded types, discriminated unions, exhaustive checks). Patching the
  finding without lifting the constraint invites the same bug class back.
- **Missing test seam?** Note the architectural gap; flag it for a separate
  refactor.
- **Convention violation?** Update the repo's AGENTS.md / conventions so
  the next agent does not repeat it.
- **Lint could catch it?** Consider a custom lint rule for a class of bug
  that humans and bots keep re-flagging.

## Report back with

- reproduction
- regression test added (or why no correct seam exists)
- ranked hypotheses + which one was right
- root cause
- fix
- verification
- prevention recommendation
- any remaining uncertainty
