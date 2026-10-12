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

- `api-typecheck-projects`: invokes the owning API program generator on branches
  containing it. Its declaration must match the approved output surface.
- `query-plan-contracts`: runs the complete owning query-plan test with
  `STELLA_UPDATE_PLAN_CONTRACTS=1`. It uses the existing PGlite fixture and updates
  both the contracts and workspace RLS plan fixture.

The workflow rejects changes outside the selected generator's outputs, verifies
the head again before handoff, and uses the existing autofix App to sign and push
the generated commit. Both initial generators require no external services.
