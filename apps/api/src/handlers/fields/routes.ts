import Elysia from "elysia";

import {
  upsertFieldBodySchema,
  upsertFieldHandler,
} from "@/api/handlers/fields/upsert-by-id";
import { workspaceAccessMacro } from "@/api/lib/auth";
import { invalidateQuery } from "@/api/lib/invalidate-query-macro";

export const fieldsRoute = new Elysia({ prefix: "/fields/:workspaceId" })
  .use(workspaceAccessMacro)
  .use(invalidateQuery)
  .guard({
    validateWorkspaceAccess: true,
  })
  .post(
    "/",
    (ctx) =>
      upsertFieldHandler({
        workspaceId: ctx.workspaceId,
        body: ctx.body,
      }),
    {
      invalidateQuery: true,
      body: upsertFieldBodySchema,
    },
  );
