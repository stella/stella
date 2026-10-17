import Elysia from "elysia";

import updateCellMetadata from "@/api/handlers/fields/cell-metadata/update";
import markColumnFlag from "@/api/handlers/fields/column-flag/update";
import updateKanbanPlacement from "@/api/handlers/fields/kanban-placement/update";
import upsertField from "@/api/handlers/fields/upsert";
import { permissionMacro, workspaceAccessMacro } from "@/api/lib/auth";

export const fieldsRoute = new Elysia({ prefix: "/fields/:workspaceId" })
  .use(workspaceAccessMacro)
  .use(permissionMacro)
  .guard({
    validateWorkspaceAccess: true,
  })
  .post("/", upsertField.handler, {
    body: upsertField.config.body,
    permissions: upsertField.config.permissions,
    accountAccess: upsertField.config.accountAccess,
  })
  .patch("/kanban-placement", updateKanbanPlacement.handler, {
    body: updateKanbanPlacement.config.body,
    permissions: updateKanbanPlacement.config.permissions,
    accountAccess: updateKanbanPlacement.config.accountAccess,
  })
  .patch("/metadata", updateCellMetadata.handler, {
    body: updateCellMetadata.config.body,
    permissions: updateCellMetadata.config.permissions,
    accountAccess: updateCellMetadata.config.accountAccess,
  })
  .patch("/metadata-batch", markColumnFlag.handler, {
    body: markColumnFlag.config.body,
    permissions: markColumnFlag.config.permissions,
    accountAccess: markColumnFlag.config.accountAccess,
  });
