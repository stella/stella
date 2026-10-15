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

Entire workflow/action documents, jobs and steps are projected in full with recursively sorted mapping keys. Unknown/new keys participate by default, including reusable-workflow caller inputs and all action inputs and environment values. All top-level keys participate, including triggers, workflow-call and dispatch inputs/defaults/secrets/outputs, permissions, environment, defaults, concurrency and action execution metadata. Each workflow job digest binds the full document context as well as its own definition.

The explicit exclusions in `CLASSIFICATION_EXCLUSIONS` are document `name` and `run-name`, job `name` and `timeout-minutes`, and step `name`, `timeout-minutes` and `run`. YAML comments disappear during parsing. Run bodies remain opaque, with their secret references retained separately; step conditions still participate. No nested action or reusable-workflow input keys are excluded, including cache-key inputs. Mapping order and ordinary run-body edits do not invalidate classifications. This projection is a review aid, not shell side-effect analysis.

Changes to this shape fail with the affected job paths and the exact refresh command. Review kind and qualifier before refreshing. Missing classifications and unresolved callees remain hard failures. Classification changes follow ordinary pull request review. This metadata check does not execute inspected commands or infer application and shell side effects.

The parser emits one dependency graph for the generator and verifier: reusable-workflow job `uses` and action-step `uses`, including nested parallel groups and composite actions. These are execution-reference positions, not a filter on digested metadata. Unknown fields and every condition remain in the digest; there is no publication-keyword gate. Shell bodies and opaque executable action entry points are not interpreted as dependency declarations.
