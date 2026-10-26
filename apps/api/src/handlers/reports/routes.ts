import cloneBuiltinReportTemplate from "@/api/handlers/reports/builtins/clone";
import readReportExport from "@/api/handlers/reports/exports/get";
import listReportExports from "@/api/handlers/reports/exports/list";
import listReportTemplates from "@/api/handlers/reports/templates/list";
import exportViewReport from "@/api/handlers/reports/views/export";
import { routes } from "@/api/http/route";

export const reportsRoute = routes(
  {
    "/": { GET: listReportExports },
    "/templates": { GET: listReportTemplates },
    "/templates/clone-builtin": { POST: cloneBuiltinReportTemplate },
    "/export": { POST: exportViewReport },
    "/:exportId": { GET: readReportExport },
  },
  { prefix: "/workspaces/:workspaceId/reports" },
);
