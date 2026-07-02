import Elysia from "elysia";

import exportViewReport from "@/api/handlers/reports/export-view";
import listReportTemplates from "@/api/handlers/reports/list-templates";
import readReportExport from "@/api/handlers/reports/read-export";
import { permissionMacro, workspaceAccessMacro } from "@/api/lib/auth";

export const reportsRoute = new Elysia({
  prefix: "/workspaces/:workspaceId/reports",
})
  .use(workspaceAccessMacro)
  .use(permissionMacro)
  .guard({
    validateWorkspaceAccess: true,
  })
  .get("/templates", listReportTemplates.handler, {
    params: listReportTemplates.config.params,
    permissions: listReportTemplates.config.permissions,
  })
  .post("/export", exportViewReport.handler, {
    body: exportViewReport.config.body,
    params: exportViewReport.config.params,
    permissions: exportViewReport.config.permissions,
  })
  .get("/:exportId", readReportExport.handler, {
    params: readReportExport.config.params,
    permissions: readReportExport.config.permissions,
  });
