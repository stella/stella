import Elysia from "elysia";

import createDataExport from "@/api/handlers/data-exports/create";
import downloadDataExport from "@/api/handlers/data-exports/download";
import readDataExport from "@/api/handlers/data-exports/get";
import listDataExports from "@/api/handlers/data-exports/list";
import { authMacro, permissionMacro } from "@/api/lib/auth";

// Organisation-wide, not matter-scoped: gated by dataExport permissions,
// which only organisation owners and admins hold.
export const dataExportsRoute = new Elysia({ prefix: "/data-exports" })
  .use(authMacro)
  .use(permissionMacro)
  .guard({ validateAuth: true })
  .get("/", listDataExports.handler, {
    permissions: listDataExports.config.permissions,
    accountAccess: listDataExports.config.accountAccess,
    query: listDataExports.config.query,
  })
  .post("/", createDataExport.handler, {
    body: createDataExport.config.body,
    permissions: createDataExport.config.permissions,
    accountAccess: createDataExport.config.accountAccess,
  })
  .get("/:exportId", readDataExport.handler, {
    params: readDataExport.config.params,
    permissions: readDataExport.config.permissions,
    accountAccess: readDataExport.config.accountAccess,
  })
  .post("/:exportId/download", downloadDataExport.handler, {
    body: downloadDataExport.config.body,
    params: downloadDataExport.config.params,
    permissions: downloadDataExport.config.permissions,
    accountAccess: downloadDataExport.config.accountAccess,
  });
