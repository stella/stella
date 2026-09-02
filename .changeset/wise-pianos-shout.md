---
"@stll/cli": minor
---

Rename the workspace-scoping tool input to `workspace_id`. Breaking for the generated commands that scoped to a workspace: they now take `--workspace-id` instead of `--matter-id`, as does `stella upload`. Matter-entity commands (`matter save`, `matter delete`, `matter list`, `matter link-contact`) keep `--matter-id`. `--input` still accepts the deprecated `matter_id` key for one release.
