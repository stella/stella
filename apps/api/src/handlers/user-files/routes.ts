import Elysia from "elysia";

import readUserFileContent from "@/api/handlers/user-files/read-content";
import { authMacro, permissionMacro } from "@/api/lib/auth";

export const userFilesRoute = new Elysia({ prefix: "/user-files" })
  .use(authMacro)
  .use(permissionMacro)
  .guard({ validateAuth: true })
  .get("/:fileId/content", readUserFileContent.handler, {
    params: readUserFileContent.config.params,
    permissions: readUserFileContent.config.permissions,
  });
