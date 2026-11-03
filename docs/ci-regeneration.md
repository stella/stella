# Regenerate pull request outputs

Merge current main into the pull request branch before using this workflow.
Dispatch on that branch: the workflow verifies that its run SHA is the current
head of the selected open, same-repository pull request.

```sh
gh workflow run autofix.yml --repo stella/stella --ref <branch> \
  -f pr=<number> -f generator=<generator-id>
```

The registry in `scripts/pr-regeneration.ts` declares each command, required
services and allowed output paths. Supported IDs:

- `query-plan-contracts`: runs the complete owning query-plan test with
  `STELLA_UPDATE_PLAN_CONTRACTS=1`. It uses the existing PGlite fixture and updates
  both the contracts and workspace RLS plan fixture.

The workflow rejects changes outside the selected generator's outputs, verifies
the head again before handoff, and uses the existing autofix App to sign and push
the generated commit. This generator requires no external services.

Repository-wide rule inputs are declared in
`.github/global-rule-inputs.json`. Keep its sorted globs and change-scoped script
exceptions current when changing lint configuration, classification policy, or a
static-check guard; the declaration lets the merge queue require those changes to
be tested against a fresh main branch.

## Resolve derived-file merge conflicts locally

From a clean pull request checkout with its existing dependencies available:

```sh
git fetch origin main
bun run resolve-derived
# Or choose a fetched base explicitly:
# bun run resolve-derived --main <ref>
git diff --cached
git commit -S -m "chore: merge main and regenerate derived files"
```

The command uses `scripts/generated-conflicts.ts`, the same planner and
`scripts/generated-files.ts` registry as the generated-conflict CI workflows.
It starts a normal merge, regenerates eligible outputs from the merged sources,
and stages the result without committing or pushing. Humans and automation use
the same command; normal commit hooks and signing still apply. Repository rerere
settings remain active, and regeneration replaces any replayed output resolution.
No merge driver setup or dependency installation is required by this command.

Source conflicts, reviewed translations, ratchet allowances, classification
policy, snapshots and competing lockfile pins require a deliberate resolution.
The planner refuses a merge containing any unsupported conflict before changing
the checkout. Independent `bun.lock` changes preserve both parents' existing pins
through the existing three-way lockfile resolver.

A generator failure or an edit outside its declared outputs stops the command
with the merge pending for inspection. Use `git merge --abort` to restore tracked
files; inspect newly generated untracked files separately. A successful run also
leaves the merge pending until its staged diff is reviewed and committed.
