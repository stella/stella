import Elysia from "elysia";

import readUserFileContent from "@/api/handlers/user-files/read-content";
import readUserFileThumbnail from "@/api/handlers/user-files/read-thumbnail";
import readUserFileVisual from "@/api/handlers/user-files/read-visual";
import { authMacro, permissionMacro } from "@/api/lib/auth";

export const userFilesRoute = new Elysia({ prefix: "/user-files" })
  .use(authMacro)
  .use(permissionMacro)
  .guard({ validateAuth: true })
  .get("/:fileId/visual", readUserFileVisual.handler, {
    params: readUserFileVisual.config.params,
    permissions: readUserFileVisual.config.permissions,
    accountAccess: readUserFileVisual.config.accountAccess,
  })
  .get("/:fileId/content", readUserFileContent.handler, {
    params: readUserFileContent.config.params,
    permissions: readUserFileContent.config.permissions,
    accountAccess: readUserFileContent.config.accountAccess,
  })
  .get("/:fileId/thumbnail", readUserFileThumbnail.handler, {
    params: readUserFileThumbnail.config.params,
    permissions: readUserFileThumbnail.config.permissions,
    accountAccess: readUserFileThumbnail.config.accountAccess,
  });
