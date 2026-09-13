import Elysia from "elysia";

import { RESOURCE_TYPE } from "@stll/api-contract";

import compareDocumentVersions from "@/api/handlers/documents/compare";
import { permissionMacro, workspaceAccessMacro } from "@/api/lib/auth";
import {
  resourceRealtime,
  workspaceResourceSetUpdates,
} from "@/api/lib/resource-realtime-macro";

const documentVersionRealtimeUpdates = workspaceResourceSetUpdates([
  RESOURCE_TYPE.ENTITY,
  RESOURCE_TYPE.ENTITY_VERSION,
  RESOURCE_TYPE.USER_FILE,
]);

export const documentsRoute = new Elysia({
  prefix: "/documents/:workspaceId",
})
  .use(workspaceAccessMacro)
  .use(resourceRealtime)
  .use(permissionMacro)
  .guard({ validateWorkspaceAccess: true })
  .post("/document/:documentId/compare", compareDocumentVersions.handler, {
    body: compareDocumentVersions.config.body,
    params: compareDocumentVersions.config.params,
    permissions: compareDocumentVersions.config.permissions,
    resourceSetUpdated: documentVersionRealtimeUpdates,
  });
