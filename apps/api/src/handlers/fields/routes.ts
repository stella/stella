import Elysia from "elysia";

import updateCellMetadata from "@/api/handlers/fields/update-cell-metadata";
import upsertField from "@/api/handlers/fields/upsert-by-id";
import { permissionMacro, workspaceAccessMacro } from "@/api/lib/auth";
import { invalidateQuery } from "@/api/lib/invalidate-query-macro";

export const fieldsRoute = new Elysia({ prefix: "/fields/:workspaceId" })
  .use(workspaceAccessMacro)
  .use(invalidateQuery)
  .use(permissionMacro)
  .guard({
    validateWorkspaceAccess: true,
  })
  .post("/", upsertField.handler, {
    body: upsertField.config.body,
    invalidateQuery: true,
    permissions: upsertField.config.permissions,
  })
  .patch("/metadata", updateCellMetadata.handler, {
    body: updateCellMetadata.config.body,
    invalidateQuery: true,
    permissions: updateCellMetadata.config.permissions,
  });
