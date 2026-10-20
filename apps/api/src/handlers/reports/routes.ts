import Elysia from "elysia";

import cloneBuiltinReportTemplate from "@/api/handlers/reports/builtins/clone";
import readReportExport from "@/api/handlers/reports/exports/get";
import listReportExports from "@/api/handlers/reports/exports/list";
import listReportTemplates from "@/api/handlers/reports/templates/list";
import exportViewReport from "@/api/handlers/reports/views/export";
import { permissionMacro, workspaceAccessMacro } from "@/api/lib/auth";

export const reportsRoute = new Elysia({
  prefix: "/workspaces/:workspaceId/reports",
})
  .use(workspaceAccessMacro)
  .use(permissionMacro)
  .guard({
    validateWorkspaceAccess: true,
  })
  .get(
    "/",
    {
      params: listReportExports.config.params,
      permissions: listReportExports.config.permissions,
      query: listReportExports.config.query,
    },
    listReportExports.handler,
  )
  .get(
    "/templates",
    {
      params: listReportTemplates.config.params,
      permissions: listReportTemplates.config.permissions,
    },
    listReportTemplates.handler,
  )
  .post(
    "/templates/clone-builtin",
    {
      body: cloneBuiltinReportTemplate.config.body,
      params: cloneBuiltinReportTemplate.config.params,
      permissions: cloneBuiltinReportTemplate.config.permissions,
    },
    cloneBuiltinReportTemplate.handler,
  )
  .post(
    "/export",
    {
      body: exportViewReport.config.body,
      params: exportViewReport.config.params,
      permissions: exportViewReport.config.permissions,
    },
    exportViewReport.handler,
  )
  .get(
    "/:exportId",
    {
      params: readReportExport.config.params,
      permissions: readReportExport.config.permissions,
    },
    readReportExport.handler,
  );
