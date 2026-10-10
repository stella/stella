import Elysia from "elysia";

import compareDocumentVersions from "@/api/handlers/documents/compare";
import { permissionMacro, workspaceAccessMacro } from "@/api/lib/auth";

export const documentsRoute = new Elysia({
  prefix: "/documents/:workspaceId",
})
  .use(workspaceAccessMacro)
  .use(permissionMacro)
  .guard({ validateWorkspaceAccess: true })
  .post("/document/:documentId/compare", compareDocumentVersions.handler, {
    body: compareDocumentVersions.config.body,
    params: compareDocumentVersions.config.params,
    permissions: compareDocumentVersions.config.permissions,
  });
