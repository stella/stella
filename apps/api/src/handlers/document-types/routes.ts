import Elysia from "elysia";

import createDocumentType from "@/api/handlers/document-types/create";
import deleteDocumentType from "@/api/handlers/document-types/delete-by-id";
import listDocumentTypes from "@/api/handlers/document-types/read-list";
import reorderDocumentTypes from "@/api/handlers/document-types/reorder";
import updateDocumentType from "@/api/handlers/document-types/update-by-id";
import { authMacro, permissionMacro } from "@/api/lib/auth";

export const documentTypesRoute = new Elysia({
  prefix: "/document-types",
})
  .use(authMacro)
  .use(permissionMacro)
  .guard({ validateAuth: true })
  .get("/", listDocumentTypes.handler, {
    permissions: listDocumentTypes.config.permissions,
  })
  .post("/", createDocumentType.handler, {
    body: createDocumentType.config.body,
    permissions: createDocumentType.config.permissions,
  })
  .post("/reorder", reorderDocumentTypes.handler, {
    body: reorderDocumentTypes.config.body,
    permissions: reorderDocumentTypes.config.permissions,
  })
  .patch("/:documentTypeId", updateDocumentType.handler, {
    body: updateDocumentType.config.body,
    params: updateDocumentType.config.params,
    permissions: updateDocumentType.config.permissions,
  })
  .delete("/:documentTypeId", deleteDocumentType.handler, {
    params: deleteDocumentType.config.params,
    permissions: deleteDocumentType.config.permissions,
  });
