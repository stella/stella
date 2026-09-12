import Elysia from "elysia";

import createPdfAnonymizationRun from "@/api/handlers/pdf-anonymization/create-run";
import readPdfAnonymizationRun from "@/api/handlers/pdf-anonymization/read-run";
import { permissionMacro, workspaceAccessMacro } from "@/api/lib/auth";

export const pdfAnonymizationRoute = new Elysia({
  prefix: "/workspaces/:workspaceId/pdf-anonymization",
})
  .use(workspaceAccessMacro)
  .use(permissionMacro)
  .guard({ validateWorkspaceAccess: true })
  .post("/runs", createPdfAnonymizationRun.handler, {
    body: createPdfAnonymizationRun.config.body,
    params: createPdfAnonymizationRun.config.params,
    permissions: createPdfAnonymizationRun.config.permissions,
  })
  .get("/runs/:runId", readPdfAnonymizationRun.handler, {
    params: readPdfAnonymizationRun.config.params,
    permissions: readPdfAnonymizationRun.config.permissions,
  });
