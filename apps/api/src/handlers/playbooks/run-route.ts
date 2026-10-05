import Elysia from "elysia";

import autoRunPlaybooks from "@/api/handlers/playbooks/applicable/run";
import runPlaybook from "@/api/handlers/playbooks/run";
import { permissionMacro, workspaceAccessMacro } from "@/api/lib/auth";

// Running a playbook is workspace-scoped (it materializes columns where the
// documents live) even though the definition it reads is org-scoped. Mounted
// under `/workspaces/:workspaceId/playbooks` so workspace access is validated
// from the path, separate from the org-scoped definition CRUD in `routes.ts`.
export const playbookRunsRoute = new Elysia({
  prefix: "/workspaces/:workspaceId/playbooks",
})
  .use(workspaceAccessMacro)
  .use(permissionMacro)
  .guard({
    validateWorkspaceAccess: true,
  })
  .post("/:playbookId/run", runPlaybook.handler, {
    body: runPlaybook.config.body,
    params: runPlaybook.config.params,
    permissions: runPlaybook.config.permissions,
  })
  // Auto-run: materialize every applicable playbook over the files table in one
  // pass (each still gated to its document-type subset). Workspace-scoped, so it
  // lives here alongside the single run rather than the org-scoped definition
  // CRUD in `routes.ts`.
  .post("/auto-run", autoRunPlaybooks.handler, {
    params: autoRunPlaybooks.config.params,
    permissions: autoRunPlaybooks.config.permissions,
  });
