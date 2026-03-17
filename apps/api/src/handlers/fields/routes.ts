import Elysia from "elysia";

import upsertField from "@/api/handlers/fields/upsert-by-id";
import { workspaceAccessMacro } from "@/api/lib/auth";
import { invalidateQuery } from "@/api/lib/invalidate-query-macro";

export const fieldsRoute = new Elysia({ prefix: "/fields/:workspaceId" })
  .use(workspaceAccessMacro)
  .use(invalidateQuery)
  .guard({
    validateWorkspaceAccess: true,
  })
  .post("/", upsertField.handler, {
    body: upsertField.config.body,
    invalidateQuery: true,
  });
