# CI job classification report

PROOF_BASE: d15c1c00de745425d0827317c8541957002ac93f

## Result

The classification parser now has one privilege owner and one privileged-surface builder. Add-only approvals were generated for every changed job digest without changing kinds or qualifiers.

## Privilege sources

| Source             | Complete rule                                                                                                                                                                                                                  |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Token permissions  | Effective job or workflow permissions contain a write scope or `write-all`; an unset value resolves to the read-only repository default, and `id-token: write` is a write scope.                                               |
| Credentials        | Non-default `secrets.*`, `secrets: inherit`, and app-token action outputs are privileged. `secrets.GITHUB_TOKEN` and `github.token` count only with write permissions.                                                         |
| Environment        | Any declared deployment `environment` is privileged.                                                                                                                                                                           |
| Trigger            | `pull_request_target`, `workflow_run`, `issue_comment`, `pull_request_review`, `pull_request_review_comment`, and `discussion_comment` are privileged; reusable dependencies inherit privilege through closure classification. |
| Runner             | Parsed `runs-on` values are privileged for `self-hosted`, any runner group, or any label that is not a GitHub-hosted image, including literal matrix expansion.                                                                |
| Untrusted checkout | Checkout or fetch operations using pull-request heads, `github.head_ref`, workflow-run heads, issue values, or comment-derived values are privileged.                                                                          |

## 164-commit measurement

The range is the 164 first-parent commits ending at the starting revision. Original approvals are commits touching each decision directory; final-definition approvals are digest changes measured by parsing each historical workflow with the final classifier.

| Job                        | Original whole-text approvals | Final-definition approvals |
| -------------------------- | ----------------------------: | -------------------------: |
| `main-heavy.yml/suites`    |                             2 |                          0 |
| `main-pr-depth.yml/suites` |                             2 |                          0 |

## Mutation checks

MUTATION: replace the permissions source in `jobIsPrivileged` with `false`, then run `bun test ./scripts/check-ci-job-classification.test.ts -t 'privilege source: write permissions'`
EXIT: 1
Failing test: `privilege source: write permissions requires approval for an ordinary run change`.

MUTATION: replace the credential source in `jobIsPrivileged` with `false`, then run `bun test ./scripts/check-ci-job-classification.test.ts -t 'privilege source: credentials'`
EXIT: 1
Failing test: `privilege source: credentials requires approval for an ordinary run change`.

MUTATION: replace the environment source in `jobIsPrivileged` with `false`, then run `bun test ./scripts/check-ci-job-classification.test.ts -t 'privilege source: deployment environments'`
EXIT: 1
Failing test: `privilege source: deployment environments requires approval for an ordinary run change`.

MUTATION: replace the trigger source in `jobIsPrivileged` with `false`, then run `bun test ./scripts/check-ci-job-classification.test.ts -t 'privilege source: base-branch triggers'`
EXIT: 1
Failing test: `privilege source: base-branch triggers requires approval for an ordinary run change`.

MUTATION: replace the runner source in `jobIsPrivileged` with `false`, then run `bun test ./scripts/check-ci-job-classification.test.ts -t 'privilege source: self-hosted runners'`
EXIT: 1
Failing test: `privilege source: self-hosted runners requires approval for an ordinary run change`.

MUTATION: replace the untrusted-checkout source in `jobIsPrivileged` with `false`, then run `bun test ./scripts/check-ci-job-classification.test.ts -t 'privilege source: untrusted checkouts'`
EXIT: 1
Failing test: `privilege source: untrusted checkouts requires approval for an ordinary run change`.

The original file was restored byte-for-byte after every mutation batch.

MUTATION_RESULT: green

## Proof gate

PROOF: bunx lefthook run pre-commit
EXIT: 0
Output tail: all dependency, format, lint, lockfile, secret, and tracked-symlink hooks passed.

PROOF: bun scripts/changeset-guard.ts --base 5820eb2775a5a013412781dcbab7df316f3dbe72
EXIT: 0
Output tail: `changeset-guard: no release-gated changes.`

PROOF: bash -c 'set -euo pipefail; mapfile -d "" changed < <(git diff -z --name-only --diff-filter=ACMR "5820eb2775a5a013412781dcbab7df316f3dbe72" -- "_.ts" "_.tsx" "_.mts" "_.cts"); mapfile -d "" added < <(git ls-files -z --others --exclude-standard -- "_.ts" "_.tsx" "_.mts" "_.cts"); files=("${changed[@]}" "${added[@]}"); (( ${#files[@]} )) || exit 0; bun scripts/ci-generated-sources.ts prepare; bun --bun oxlint -c oxlint.config.ts --no-error-on-unmatched-pattern --type-aware "${files[@]}"; bun scripts/typecheck-coverage.ts --autofix "${files[@]}"'
EXIT: 0
Output tail: generated sources prepared; type-aware lint passed; `scripts/tsconfig.json` checked four targets.

PROOF: bun test ./scripts/check-ci-job-classification.test.ts
EXIT: 0
Output tail: 35 passed, 0 failed, 186 assertions.

PROOF: bun test ./scripts/ci-job-classification/snapshots.test.ts
EXIT: 0
Output tail: 11 passed, 0 failed, 30 assertions.

PROOF: bun scripts/check-ci-job-classification.ts --check
EXIT: 0
Output tail: `Classified 78 workflows`.

CLOUD_RESULT: green

PR_TITLE: ci: make job classification approvals composable
PR_SUMMARY: Define the complete privileged job surface in one parser-owned decision, preserve minimal non-privileged projections, add regression and mutation coverage for every privilege source, and record add-only approvals for changed digests.

SETUP_LOG:
`git remote -v` produced no output.
`git rev-parse refs/remotes/origin/main`:
`d15c1c00de745425d0827317c8541957002ac93f`
SETUP_EXIT: repository inspection 0
