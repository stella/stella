import Elysia, { t } from "elysia";

import {
  printPdfHandler,
  readFileHandler,
  stampedDownloadHandler,
} from "@/api/handlers/files/read-by-id";
import { workspaceAccessMacro } from "@/api/lib/auth";
import { tSafeId, workspaceParams } from "@/api/lib/custom-schema";

export const filesRoute = new Elysia({
  prefix: "/files/:workspaceId",
})
  .use(workspaceAccessMacro)
  .guard({
    validateWorkspaceAccess: true,
  })
  .get(
    "/url/:fieldId",
    async (ctx) =>
      await readFileHandler({
        fieldId: ctx.params.fieldId,
        organizationId: ctx.session.activeOrganizationId,
        workspaceId: ctx.workspaceId,
        purpose: ctx.query.purpose,
        scopedDb: ctx.scopedDb,
      }),
    {
      query: t.Object({
        purpose: t.UnionEnum(["download", "display", "native-display"]),
      }),
      params: workspaceParams({ fieldId: tSafeId("field") }),
    },
  )
  .get(
    "/print-pdf/:fieldId",
    async (ctx) =>
      await printPdfHandler({
        fieldId: ctx.params.fieldId,
        organizationId: ctx.session.activeOrganizationId,
        workspaceId: ctx.workspaceId,
        scopedDb: ctx.scopedDb,
      }),
    {
      params: workspaceParams({ fieldId: tSafeId("field") }),
    },
  )
  .get(
    "/stamped/:fieldId",
    async (ctx) =>
      await stampedDownloadHandler({
        fieldId: ctx.params.fieldId,
        organizationId: ctx.session.activeOrganizationId,
        workspaceId: ctx.workspaceId,
        scopedDb: ctx.scopedDb,
      }),
    {
      params: workspaceParams({ fieldId: tSafeId("field") }),
    },
  );
