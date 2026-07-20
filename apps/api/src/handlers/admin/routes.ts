import Elysia from "elysia";

import adminDiagnostics from "@/api/handlers/admin/diagnostics";
import { authMacro, permissionMacro } from "@/api/lib/auth";

export const adminRoute = new Elysia({ prefix: "/admin" })
  .use(authMacro)
  .use(permissionMacro)
  .guard({ validateAuth: true })
  .get("/diagnostics", adminDiagnostics.handler, {
    permissions: adminDiagnostics.config.permissions,
  });
