import Elysia from "elysia";

import createDocumentType from "@/api/handlers/document-types/create";
import deleteDocumentType from "@/api/handlers/document-types/delete";
import listDocumentTypes from "@/api/handlers/document-types/list";
import reorderDocumentTypes from "@/api/handlers/document-types/reorder";
import updateDocumentType from "@/api/handlers/document-types/update";
import { authMacro, permissionMacro } from "@/api/lib/auth";

export const documentTypesRoute = new Elysia({
  prefix: "/document-types",
})
  .use(authMacro)
  .use(permissionMacro)
  .guard({ validateAuth: true })
  .get("/", listDocumentTypes.handler, {
    permissions: listDocumentTypes.config.permissions,
    accountAccess: listDocumentTypes.config.accountAccess,
  })
  .post("/", createDocumentType.handler, {
    body: createDocumentType.config.body,
    permissions: createDocumentType.config.permissions,
    accountAccess: createDocumentType.config.accountAccess,
  })
  .post("/reorder", reorderDocumentTypes.handler, {
    body: reorderDocumentTypes.config.body,
    permissions: reorderDocumentTypes.config.permissions,
    accountAccess: reorderDocumentTypes.config.accountAccess,
  })
  .patch("/:documentTypeId", updateDocumentType.handler, {
    body: updateDocumentType.config.body,
    params: updateDocumentType.config.params,
    permissions: updateDocumentType.config.permissions,
    accountAccess: updateDocumentType.config.accountAccess,
  })
  .delete("/:documentTypeId", deleteDocumentType.handler, {
    params: deleteDocumentType.config.params,
    permissions: deleteDocumentType.config.permissions,
    accountAccess: deleteDocumentType.config.accountAccess,
  });
