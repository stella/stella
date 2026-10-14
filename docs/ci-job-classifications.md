# Workflow job classifications

CI validates every workflow job and its reachable reusable-workflow and composite-action metadata against `.github/ci-job-classification.json`:

- `ordinary`: checks without publication or deployment.
- `support`: prerequisite checks whose release behavior follows the workflow conditions.
- `priority`: publication, tagging or deployment, subject to the workflow conditions.

The check reads an isolated sparse checkout at the workflow revision. Supplier metadata is captured at immutable revisions in `.github/ci-job-classification-sources.json`; validation checks the recorded bytes, full owner/repository/path/commit identity and complete callee job census without fetching suppliers. A shared parser binds each remote reference to its independently recorded source origin; changing a reference cannot reuse metadata from another repository, file or commit.

Workflow, action, reference and job changes require updated declarations and review of the called code. Missing classifications, changed metadata and unresolved callees fail validation. Classification changes follow ordinary pull request review. This metadata check does not execute inspected commands or infer application and shell side effects.
