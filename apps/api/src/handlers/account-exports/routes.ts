import Elysia from "elysia";

import requestPersonalDataExport from "@/api/handlers/account-exports/create";
import downloadPersonalDataExport from "@/api/handlers/account-exports/download";
import latestPersonalDataExport from "@/api/handlers/account-exports/get";
import personalDataExportStatus from "@/api/handlers/account-exports/status/get";
import { sessionAuthMacro } from "@/api/lib/auth";

export const accountExportsRoute = new Elysia({ prefix: "/me" }).group(
  "/data-exports",
  (app) =>
    app
      .use(sessionAuthMacro)
      .guard({ validateSession: true })
      .get("/", latestPersonalDataExport.handler, {
        response: latestPersonalDataExport.config.response,
      })
      .post("/", requestPersonalDataExport.handler, {
        response: requestPersonalDataExport.config.response,
      })
      .get("/:exportId", personalDataExportStatus.handler, {
        response: personalDataExportStatus.config.response,
        params: personalDataExportStatus.config.params,
      })
      .get("/:exportId/download", downloadPersonalDataExport.handler, {
        response: downloadPersonalDataExport.config.response,
        params: downloadPersonalDataExport.config.params,
      }),
);
