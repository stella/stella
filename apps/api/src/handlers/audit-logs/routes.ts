import exportAuditLogs from "@/api/handlers/audit-logs/export";
import readAuditLogs from "@/api/handlers/audit-logs/list";
import { routes } from "@/api/http/route";

export const auditLogsRoute = routes(
  {
    "/": { GET: readAuditLogs },
    "/export": { GET: exportAuditLogs },
  },
  { prefix: "/audit-logs" },
);
