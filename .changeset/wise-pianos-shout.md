---
"@stll/cli": patch
---

Rename the workspace-scoping tool input to `workspace_id`, so the generated commands take `--workspace-id` instead of `--matter-id` (matter-entity commands keep `--matter-id`). The MCP surface still accepts `matter_id` as a deprecated alias for one release.
