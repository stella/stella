import Elysia from "elysia";

import runPlaybook from "@/api/handlers/playbooks/run";
import { permissionMacro, workspaceAccessMacro } from "@/api/lib/auth";
import { invalidateQuery } from "@/api/lib/invalidate-query-macro";

// Running a playbook is workspace-scoped (it materializes columns where the
// documents live) even though the definition it reads is org-scoped. Mounted
// under `/workspaces/:workspaceId/playbooks` so workspace access is validated
// from the path, separate from the org-scoped definition CRUD in `routes.ts`.
export const playbookRunsRoute = new Elysia({
  prefix: "/workspaces/:workspaceId/playbooks",
})
  .use(workspaceAccessMacro)
  .use(invalidateQuery)
  .use(permissionMacro)
  .guard({
    validateWorkspaceAccess: true,
  })
  .post("/:playbookId/run", runPlaybook.handler, {
    params: runPlaybook.config.params,
    invalidateQuery: true,
    permissions: runPlaybook.config.permissions,
  });
