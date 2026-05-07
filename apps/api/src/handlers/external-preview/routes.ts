import Elysia from "elysia";

import previewExternalSource, {
  previewExternalFile,
} from "@/api/handlers/external-preview/preview";
import { authMacro, permissionMacro } from "@/api/lib/auth";

export const externalPreviewRoute = new Elysia({ prefix: "/external-preview" })
  .use(authMacro)
  .use(permissionMacro)
  .guard({ validateAuth: true })
  .get("/", previewExternalSource.handler, {
    query: previewExternalSource.config.query,
  })
  .get("/file", previewExternalFile.handler, {
    query: previewExternalFile.config.query,
  });
