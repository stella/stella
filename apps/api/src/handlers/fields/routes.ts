import Elysia from "elysia";

import { RESOURCE_TYPE } from "@stll/api-contract";

import markColumnFlag from "@/api/handlers/fields/mark-column-flag";
import updateCellMetadata from "@/api/handlers/fields/update-cell-metadata";
import updateKanbanPlacement from "@/api/handlers/fields/update-kanban-placement";
import upsertField from "@/api/handlers/fields/upsert-by-id";
import { permissionMacro, workspaceAccessMacro } from "@/api/lib/auth";
import {
  resourceRealtime,
  workspaceResourceSetUpdates,
} from "@/api/lib/resource-realtime-macro";

const fieldRealtimeUpdates = workspaceResourceSetUpdates(RESOURCE_TYPE.FIELD);
const kanbanPlacementRealtimeUpdates = workspaceResourceSetUpdates([
  RESOURCE_TYPE.ENTITY,
  RESOURCE_TYPE.FIELD,
]);

export const fieldsRoute = new Elysia({ prefix: "/fields/:workspaceId" })
  .use(workspaceAccessMacro)
  .use(resourceRealtime)
  .use(permissionMacro)
  .guard({
    validateWorkspaceAccess: true,
  })
  .post("/", upsertField.handler, {
    body: upsertField.config.body,
    resourceSetUpdated: fieldRealtimeUpdates,
    permissions: upsertField.config.permissions,
  })
  .patch("/kanban-placement", updateKanbanPlacement.handler, {
    body: updateKanbanPlacement.config.body,
    resourceSetUpdated: kanbanPlacementRealtimeUpdates,
    permissions: updateKanbanPlacement.config.permissions,
  })
  .patch("/metadata", updateCellMetadata.handler, {
    body: updateCellMetadata.config.body,
    resourceSetUpdated: fieldRealtimeUpdates,
    permissions: updateCellMetadata.config.permissions,
  })
  .patch("/metadata-batch", markColumnFlag.handler, {
    body: markColumnFlag.config.body,
    resourceSetUpdated: fieldRealtimeUpdates,
    permissions: markColumnFlag.config.permissions,
  });
