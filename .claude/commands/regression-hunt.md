# Regression Hunt

Track down a behavior that used to work and now fails, changed, or
regressed. Use this when a bug report points to a recent breakage,
especially when the cause is not obvious yet.

## Arguments

$ARGUMENTS — A short description of what regressed.

Helpful extras when available:
- failing test name or file
- error message or log line
- expected behavior
- actual behavior
- suspect PR, branch, commit, or file
- reproduction command, input, route, or endpoint

A plain-English bug report is enough to start. The rest are accelerators,
not requirements.

## Instructions

1. **Restate the regression clearly**:
   - what used to work?
   - what is broken now?
   - what is expected instead?

2. **Reproduce it first**:
   - run the failing test if one exists
   - otherwise use the provided command, input, endpoint, or scenario
   - if no reproduction exists, build the smallest one you can

3. **Encode the regression in a test before fixing it**:
   - prefer a focused unit or integration test that fails for the current bug
   - if a nearby test file already exists, add the failing case there
   - if the repo has no practical automated test harness for this area, create the
     smallest reproducible check you can and say why a proper regression test was not added yet

4. **Bound the problem**:
   - identify where the behavior lives
   - narrow the suspect files, modules, or commits
   - compare against the last known good behavior if possible

5. **Inspect recent change history**:
   - current diff
   - recent commits touching the area
   - suspect PRs or refactors

   Use git history when helpful, but do not stop at blame; verify the actual cause.

6. **Find the root cause**:
   - avoid fixing only the symptom
   - identify the exact logic, assumption, or edge case that changed

7. **Fix it minimally**:
   - preserve intended newer behavior where possible
   - do not revert unrelated improvements just to make the symptom disappear

8. **Verify**:
   - make sure the new regression test now passes
   - rerun the focused regression check first
   - then run the relevant wider checks for confidence

9. **Report back with**:
   - reproduction
   - regression test added
   - root cause
   - fix
   - verification
   - any remaining uncertainty
