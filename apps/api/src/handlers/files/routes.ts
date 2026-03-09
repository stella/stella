import Elysia, { t } from "elysia";

import {
  readFileHandler,
  stampedDownloadHandler,
} from "@/api/handlers/files/read-by-id";
import { workspaceAccessMacro } from "@/api/lib/auth";

export const filesRoute = new Elysia({
  prefix: "/files/:workspaceId",
})
  .use(workspaceAccessMacro)
  .guard({
    validateWorkspaceAccess: true,
  })
  .get(
    "/url/:fieldId",
    (ctx) =>
      readFileHandler({
        fieldId: ctx.params.fieldId,
        organizationId: ctx.session.activeOrganizationId,
        workspaceId: ctx.workspaceId,
        purpose: ctx.query.purpose,
        scopedDb: ctx.scopedDb,
      }),
    {
      query: t.Object({
        purpose: t.UnionEnum(["download", "display"]),
      }),
    },
  )
  .get("/stamped/:fieldId", (ctx) =>
    stampedDownloadHandler({
      fieldId: ctx.params.fieldId,
      organizationId: ctx.session.activeOrganizationId,
      workspaceId: ctx.workspaceId,
      scopedDb: ctx.scopedDb,
    }),
  );
