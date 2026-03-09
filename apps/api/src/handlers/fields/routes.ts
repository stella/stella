import Elysia from "elysia";

import {
  upsertFieldBodySchema,
  upsertFieldHandler,
} from "@/api/handlers/fields/upsert-by-id";
import { permissionMacro, workspaceAccessMacro } from "@/api/lib/auth";
import { invalidateQuery } from "@/api/lib/invalidate-query-macro";

export const fieldsRoute = new Elysia({ prefix: "/fields/:workspaceId" })
  .use(workspaceAccessMacro)
  .use(invalidateQuery)
  .use(permissionMacro)
  .guard({
    validateWorkspaceAccess: true,
  })
  .post(
    "/",
    (ctx) =>
      upsertFieldHandler({
        workspaceId: ctx.workspaceId,
        body: ctx.body,
        scopedDb: ctx.scopedDb,
      }),
    {
      permissions: { entity: ["update"] },
      invalidateQuery: true,
      body: upsertFieldBodySchema,
    },
  );
