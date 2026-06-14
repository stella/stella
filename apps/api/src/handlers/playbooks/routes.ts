import Elysia from "elysia";

import applyPlaybook from "@/api/handlers/playbooks/apply";
import createPlaybook from "@/api/handlers/playbooks/create";
import deletePlaybookById from "@/api/handlers/playbooks/delete-by-id";
import readPlaybooks from "@/api/handlers/playbooks/read";
import updatePlaybookById from "@/api/handlers/playbooks/update-by-id";
import { permissionMacro, workspaceAccessMacro } from "@/api/lib/auth";
import { invalidateQuery } from "@/api/lib/invalidate-query-macro";

export const playbooksRoute = new Elysia({
  prefix: "/playbooks/:workspaceId",
})
  .use(workspaceAccessMacro)
  .use(invalidateQuery)
  .use(permissionMacro)
  .guard({
    validateWorkspaceAccess: true,
  })
  .get("/", readPlaybooks.handler, {
    permissions: readPlaybooks.config.permissions,
    query: readPlaybooks.config.query,
  })
  .put("/", createPlaybook.handler, {
    body: createPlaybook.config.body,
    invalidateQuery: true,
    permissions: createPlaybook.config.permissions,
  })
  .group("/playbook/:playbookId", (app) =>
    app
      .post("/", updatePlaybookById.handler, {
        body: updatePlaybookById.config.body,
        invalidateQuery: true,
        params: updatePlaybookById.config.params,
        permissions: updatePlaybookById.config.permissions,
      })
      .delete("/", deletePlaybookById.handler, {
        invalidateQuery: true,
        params: deletePlaybookById.config.params,
        permissions: deletePlaybookById.config.permissions,
      })
      .post("/apply", applyPlaybook.handler, {
        invalidateQuery: true,
        params: applyPlaybook.config.params,
        permissions: applyPlaybook.config.permissions,
      }),
  );
