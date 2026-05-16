import Elysia from "elysia";

import readAuditLogs from "@/api/handlers/audit-logs/read";
import { authMacro, permissionMacro } from "@/api/lib/auth";

export const auditLogsRoute = new Elysia({ prefix: "/audit-logs" })
  .use(authMacro)
  .use(permissionMacro)
  .guard({ validateAuth: true })
  .get("/", readAuditLogs.handler, {
    // Compliance readers need organization-wide visibility;
    // this is intentionally scoped by auditLog.read rather
    // than workspace membership.
    permissions: readAuditLogs.config.permissions,
    query: readAuditLogs.config.query,
  });
