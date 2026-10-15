# Workflow job classifications

CI validates every workflow job and its reachable reusable-workflow and composite-action metadata against `.github/ci-job-classification.json`:

- `ordinary`: checks without publication or deployment.
- `support`: prerequisite checks whose release behavior follows the workflow conditions.
- `priority`: publication, tagging or deployment, subject to the workflow conditions.

The check reads an isolated sparse checkout at the workflow revision. Supplier metadata is captured at immutable revisions in `.github/ci-job-classification-sources.json`; validation checks classification-relevant metadata, full owner/repository/path/commit identity and complete callee job census without fetching suppliers. A shared parser binds each remote reference to its independently recorded source origin; changing a reference cannot reuse metadata from another repository, file or commit.

Human decisions live in `.github/ci-job-classification-decisions.json`, keyed by `repository:path/job`: each entry contains only `kind` and `qualifier`. After reviewing a classification change, regenerate the metadata with:

```sh
bun scripts/check-ci-job-classification.ts --write
```

The generator discovers workflows, jobs, references and reachable actions, preserves decisions, and recomputes all classification digests. New jobs fail until a decision exists; the generator never chooses a kind. Repeated generation produces identical output.

Digests cover effective permissions (including workflow defaults), secret references and reusable-workflow secret bindings, environments, action/reusable-workflow references, runner selection and its matrix values, and publication/deployment conditions. Comments, step names, timeouts, cache keys and ordinary command text do not invalidate classifications. Shell publication/deployment conditions are recognized conservatively by `publish`, `deploy`, `release` or `push` in the command; action-step conditions are retained because action behavior is opaque. This projection is a review aid, not shell side-effect analysis.

Changes to this shape fail with the affected job paths and the exact refresh command. Review kind and qualifier before refreshing. Missing classifications and unresolved callees remain hard failures. Classification changes follow ordinary pull request review. This metadata check does not execute inspected commands or infer application and shell side effects.
