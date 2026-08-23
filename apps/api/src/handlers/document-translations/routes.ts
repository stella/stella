import Elysia from "elysia";

import createDocumentTranslationRun from "@/api/handlers/document-translations/create-run";
import readDocumentTranslationRun from "@/api/handlers/document-translations/read-run";
import { permissionMacro, workspaceAccessMacro } from "@/api/lib/auth";

export const documentTranslationsRoute = new Elysia({
  prefix: "/workspaces/:workspaceId/document-translations",
})
  .use(workspaceAccessMacro)
  .use(permissionMacro)
  .guard({ validateWorkspaceAccess: true })
  .post("/runs", createDocumentTranslationRun.handler, {
    body: createDocumentTranslationRun.config.body,
    params: createDocumentTranslationRun.config.params,
    permissions: createDocumentTranslationRun.config.permissions,
  })
  .get("/runs/:runId", readDocumentTranslationRun.handler, {
    params: readDocumentTranslationRun.config.params,
    permissions: readDocumentTranslationRun.config.permissions,
  });
