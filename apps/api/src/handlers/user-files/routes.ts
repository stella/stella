import Elysia from "elysia";

import readUserFileContent from "@/api/handlers/user-files/read-content";
import readUserFileThumbnail from "@/api/handlers/user-files/read-thumbnail";
import readUserFileVisual from "@/api/handlers/user-files/read-visual";
import { authMacro, permissionMacro } from "@/api/lib/auth";

export const userFilesRoute = new Elysia({ prefix: "/user-files" })
  .use(authMacro)
  .use(permissionMacro)
  .guard({ validateAuth: true })
  .get(
    "/:fileId/visual",
    {
      params: readUserFileVisual.config.params,
      permissions: readUserFileVisual.config.permissions,
    },
    readUserFileVisual.handler,
  )
  .get(
    "/:fileId/content",
    {
      params: readUserFileContent.config.params,
      permissions: readUserFileContent.config.permissions,
    },
    readUserFileContent.handler,
  )
  .get(
    "/:fileId/thumbnail",
    {
      params: readUserFileThumbnail.config.params,
      permissions: readUserFileThumbnail.config.permissions,
    },
    readUserFileThumbnail.handler,
  );
