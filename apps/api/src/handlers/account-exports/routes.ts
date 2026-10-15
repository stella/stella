import Elysia from "elysia";

import requestPersonalDataExport from "@/api/handlers/account-exports/create";
import downloadPersonalDataExport from "@/api/handlers/account-exports/download";
import personalDataExportDownloadLink from "@/api/handlers/account-exports/download/get";
import latestPersonalDataExport from "@/api/handlers/account-exports/get";
import personalDataExportStatus from "@/api/handlers/account-exports/status/get";
import { accountExportAuthMacro } from "@/api/lib/auth";

export const accountExportsRoute = new Elysia({ prefix: "/me" }).group(
  "/data-exports",
  (app) =>
    app
      .use(accountExportAuthMacro)
      .get("/", latestPersonalDataExport.handler, {
        validateAccountExport: "read",
      })
      .post("/", requestPersonalDataExport.handler, {
        validateAccountExport: "write",
      })
      .get("/:exportId", personalDataExportStatus.handler, {
        validateAccountExport: "read",
        params: personalDataExportStatus.config.params,
      })
      .get("/:exportId/download-link", personalDataExportDownloadLink.handler, {
        validateAccountExport: "read",
        params: personalDataExportDownloadLink.config.params,
      })
      .get("/:exportId/download", downloadPersonalDataExport.handler, {
        validateAccountExport: "read",
        params: downloadPersonalDataExport.config.params,
      }),
);
