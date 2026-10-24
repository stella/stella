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
        accountAccess: latestPersonalDataExport.config.accountAccess,
      })
      .post("/", requestPersonalDataExport.handler, {
        accountAccess: requestPersonalDataExport.config.accountAccess,
      })
      .get("/:exportId", personalDataExportStatus.handler, {
        params: personalDataExportStatus.config.params,
        accountAccess: personalDataExportStatus.config.accountAccess,
      })
      .get("/:exportId/download", downloadPersonalDataExport.handler, {
        params: downloadPersonalDataExport.config.params,
        accountAccess: downloadPersonalDataExport.config.accountAccess,
      }),
);
