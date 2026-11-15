# Workflow job classifications

CI derives every workflow job, with the reusable workflows and composite actions it reaches, and requires a reviewed decision for each privileged job. A job that is not privileged needs no decision and keeps none.

## Privileged jobs

A job is privileged when any of these holds:

- Its effective token permissions contain `write` or are `write-all`, including `id-token: write`. An unset permission is the read-only repository default.
- It reads a secret other than `secrets.GITHUB_TOKEN`, passes `secrets: inherit`, or uses an app-token action or its output.
- It declares `environment`.
- Its workflow runs on a base-branch event: `pull_request_target`, `workflow_run`, `issue_comment`, `pull_request_review`, `pull_request_review_comment` or `discussion_comment`.
- `runs-on` selects `self-hosted`, a runner group, or a label that is not GitHub-hosted, including literal matrix values.
- It checks out or fetches an untrusted event ref.
- It writes the repository: `contents: write`, an app token that requests it, or the shared signed-commit action, in the job or in an action it reaches.
- It reaches a reusable workflow or composite action whose metadata holds a secret reference, a write permission, a `self-hosted` label or a publication keyword (`publish`, `deploy`, `release`, or `push` in a run command).
- A privileged job calls its workflow. A callee job that declares its own permissions is exempt, unless the caller's workflow runs on a base-branch event.
- Its decision has kind `priority`.

`jobIsPrivileged` in `scripts/ci-job-classification/yaml.ts` owns the rules about the job itself; `deriveJobPrivileges` in `scripts/ci-job-classification/job-digests.ts` adds reachable metadata, callers and decisions. The rules read workflow metadata only. They are a review aid, not shell side-effect analysis: the check does not execute inspected commands or infer what an application or a script does.

## Decisions

Decisions live in `.github/ci-job-classification-decisions/`, one directory per privileged job. The directory name is the job key `repository:path/job` encoded with JavaScript's `encodeURIComponent`; decoding it recovers the key without collisions. A directory holds:

- `decision.json`, with exactly `kind` and `qualifier`.
- One `<digest>.json` per approved digest, with the same `kind` and `qualifier` and `reviewedDigest`, the digest in its name.

The kinds are:

- `ordinary`: checks without publication or deployment.
- `support`: prerequisite checks whose release behavior follows the workflow conditions.
- `priority`: publication, tagging or deployment, subject to the workflow conditions. A job that writes the repository must be `priority`.

Approvals are add-only. Two pull requests that change the same job each add a file, so they merge without a conflict, and a job that returns to an approved shape needs no new review. The check passes when one approval names the job's current digest and does not ask for the others to be removed.

`scripts/ci-job-classification/inputs.ts` owns the paths and `scripts/ci-job-classification/decisions.ts` the reads, which are the same for the working tree and for a Git revision. Nothing else may live under the directory: a file that is neither a `decision.json` nor an approval, or approvals without their `decision.json`, fail the read.

`.github/ci-event-policy.json` also lists every job, to assign its event tier. `scripts/check-ci-event-policy.ts` checks it independently of these decisions.

## The check

`bun scripts/check-ci-job-classification.ts` runs in the `ci-quick-checks` job, in queue admission and in the pre-push hook. The default `--check` mode fails when:

- A privileged job has no decision, or no approval of its current digest. The message lists the `decision.json` and approval paths with the content to write. A job that was not privileged before is no exception: gaining a secret, a write permission or a publication step fails the check until the job is classified, whether or not it ever had a decision.
- A decision exists for a job that is not privileged or no longer exists. Such a decision is stale, and the message lists the directories to remove.
- A job that writes the repository is approved under a kind other than `priority`.
- A reusable-workflow callee is unresolved, or the derived metadata does not verify.

The checker discovers workflows, jobs, references and reachable actions. It never chooses a kind or qualifier and never writes an approval: review the classification before writing the digest the message supplies. Classification changes follow ordinary pull request review.

`--write` removes stale decisions and nothing else, which needs no reviewer: a job that is not privileged owes no review, and a `priority` decision is never stale while its job exists. `--pre-push` runs only when the pushed commits touch a classification input; it removes stale decisions, asks for a commit when the decisions directory has uncommitted changes, and then runs the check. The `ci-job-classification-decisions` generator in `scripts/generated-files.ts` runs `--write`; CI autofix does not, because it may not modify `.github/`.

Every check writes `privileged_classification_change=true` or `false` to `GITHUB_OUTPUT`. It is `true` when the check fails, and when a job that is privileged at the merge base or at the head appeared, disappeared, or changed its digest or decision. Those jobs are also emitted as `::error title=Sensitive classification change::<job keys>`. A job that loses its privilege passes once its decision is removed, and is still reported this way.

An approval covers one exact digest, so approvals from separate pull requests never combine. When a merge group's combined tree needs review, the check also emits `::error title=Classification refusal::classification needs re-approval after #<number>`, naming the pull request at the head of the group.

`--json` prints one report instead of annotations: `{"status":"ok","privileged":[...]}`, `{"status":"stale","stale":[...],"mechanical":[...],"privileged":[...]}` (with `refusal` in a merge group) or `{"status":"error","message":...}`. `stale` lists every key the check rejects and `mechanical` the stale decisions among them, which `--write` removes. The exit code is 0 when the tree is admissible, 1 when a review or a removal is needed and 2 when the check could not run.

## Inputs

The check reads an isolated sparse checkout at the workflow revision, holding exactly the paths in `CLASSIFICATION_INPUT_PATHS`. Supplier metadata is captured at immutable revisions in `.github/ci-job-classification-sources.json`; validation checks classification-relevant metadata, full owner/repository/path/commit identity and complete callee job census without fetching suppliers. A shared parser binds each remote reference to its independently recorded source origin; changing a reference cannot reuse metadata from another repository, file or commit. `scripts/ci-job-classification/snapshots.ts --write` refreshes the snapshots, moves the decisions of a supplier whose pin moved, and removes the decisions that became stale.

The parser emits one dependency graph for the generator and verifier: reusable-workflow job `uses` and action-step `uses`, including nested parallel groups and composite actions. Shell bodies and opaque executable action entry points are not interpreted as dependency declarations. Every job is listed in the derived metadata with its digest, so a callee cannot hide a job; only privileged jobs carry a decision there.

## Digests

The digest of a privileged job binds:

- The workflow trigger (`on`) and the workflow-level `permissions`, `env` and `defaults`.
- The job's `permissions`, `secrets`, `uses`, `env`, `with`, `if`, `environment`, `needs`, `runs-on`, `concurrency`, `container`, `services`, `defaults` and `strategy`.
- Every step in full, run commands included, except `name` and `timeout-minutes`.
- The token grant it inherits from each privileged caller.
- The digest of every composite action it uses, which in turn binds the actions that action reaches.

A job that calls a reusable workflow binds its call surface instead of steps: `uses`, `with`, `secrets`, `permissions`, `runs-on`, `environment`, `if`, `concurrency`, `needs`, `strategy`, the workflow permissions and whether the trigger is a base-branch event. It does not bind the callee's content, whose jobs are reviewed under their own keys.

An action document is digested in full with recursively sorted mapping keys, so unknown and new keys participate by default. The exclusions in `CLASSIFICATION_EXCLUSIONS` are document `name` and `run-name` and composite step `name`, `timeout-minutes` and `run`; a run body keeps its secret references and a marker when it matches `publish|deploy|release|push` (case-insensitively). YAML comments disappear during parsing, and mapping order does not change a digest.
