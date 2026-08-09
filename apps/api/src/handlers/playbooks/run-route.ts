import Elysia from "elysia";

import { RESOURCE_TYPE } from "@stll/api-contract";

import autoRunPlaybooks from "@/api/handlers/playbooks/auto-run";
import reviewPlaybook from "@/api/handlers/playbooks/review";
import runPlaybook from "@/api/handlers/playbooks/run";
import { permissionMacro, workspaceAccessMacro } from "@/api/lib/auth";
import {
  resourceRealtime,
  workspaceResourceSetUpdates,
} from "@/api/lib/resource-realtime-macro";

const playbookRunRealtimeUpdates = workspaceResourceSetUpdates(
  RESOURCE_TYPE.ENTITY,
);

// Running a playbook is workspace-scoped (it materializes columns where the
// documents live) even though the definition it reads is org-scoped. Mounted
// under `/workspaces/:workspaceId/playbooks` so workspace access is validated
// from the path, separate from the org-scoped definition CRUD in `routes.ts`.
export const playbookRunsRoute = new Elysia({
  prefix: "/workspaces/:workspaceId/playbooks",
})
  .use(workspaceAccessMacro)
  .use(resourceRealtime)
  .use(permissionMacro)
  .guard({
    validateWorkspaceAccess: true,
  })
  .post("/:playbookId/run", runPlaybook.handler, {
    params: runPlaybook.config.params,
    resourceSetUpdated: playbookRunRealtimeUpdates,
    permissions: runPlaybook.config.permissions,
  })
  // Auto-run: materialize every applicable playbook over the files table in one
  // pass (each still gated to its document-type subset). Workspace-scoped, so it
  // lives here alongside the single run rather than the org-scoped definition
  // CRUD in `routes.ts`.
  .post("/auto-run", autoRunPlaybooks.handler, {
    params: autoRunPlaybooks.config.params,
    resourceSetUpdated: playbookRunRealtimeUpdates,
    permissions: autoRunPlaybooks.config.permissions,
  })
  // Single-document review: synchronous, returns Findings inline. No
  // No realtime update: it persists no columns/findings, so there is no
  // server cache to bust.
  .post("/:playbookId/review", reviewPlaybook.handler, {
    body: reviewPlaybook.config.body,
    params: reviewPlaybook.config.params,
    permissions: reviewPlaybook.config.permissions,
  });
