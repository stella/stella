import Elysia from "elysia";

import previewExternalSource, {
  previewExternalFile,
} from "@/api/handlers/external-preview/preview";
import { authMacro, permissionMacro } from "@/api/lib/auth";

export const externalPreviewRoute = new Elysia({ prefix: "/external-preview" })
  .use(authMacro)
  .use(permissionMacro)
  .guard({ validateAuth: true })
  .get(
    "/",
    {
      permissions: previewExternalSource.config.permissions,
      query: previewExternalSource.config.query,
    },
    previewExternalSource.handler,
  )
  .get(
    "/file",
    {
      permissions: previewExternalFile.config.permissions,
      query: previewExternalFile.config.query,
    },
    previewExternalFile.handler,
  );
