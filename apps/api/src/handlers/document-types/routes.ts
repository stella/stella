import Elysia from "elysia";

import listDocumentTypes from "@/api/handlers/document-types/read-list";
import { authMacro, permissionMacro } from "@/api/lib/auth";

export const documentTypesRoute = new Elysia({
  prefix: "/document-types",
})
  .use(authMacro)
  .use(permissionMacro)
  .guard({ validateAuth: true })
  .get("/", listDocumentTypes.handler, {
    permissions: listDocumentTypes.config.permissions,
  });
