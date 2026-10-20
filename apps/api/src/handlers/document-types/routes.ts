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
  .get(
    "/",
    {
      permissions: listDocumentTypes.config.permissions,
    },
    listDocumentTypes.handler,
  )
  .post(
    "/",
    {
      body: createDocumentType.config.body,
      permissions: createDocumentType.config.permissions,
    },
    createDocumentType.handler,
  )
  .post(
    "/reorder",
    {
      body: reorderDocumentTypes.config.body,
      permissions: reorderDocumentTypes.config.permissions,
    },
    reorderDocumentTypes.handler,
  )
  .patch(
    "/:documentTypeId",
    {
      body: updateDocumentType.config.body,
      params: updateDocumentType.config.params,
      permissions: updateDocumentType.config.permissions,
    },
    updateDocumentType.handler,
  )
  .delete(
    "/:documentTypeId",
    {
      params: deleteDocumentType.config.params,
      permissions: deleteDocumentType.config.permissions,
    },
    deleteDocumentType.handler,
  );
