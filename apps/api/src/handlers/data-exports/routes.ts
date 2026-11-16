import createDataExport from "@/api/handlers/data-exports/create";
import downloadDataExport from "@/api/handlers/data-exports/download";
import readDataExport from "@/api/handlers/data-exports/get";
import listDataExports from "@/api/handlers/data-exports/list";
import { routes } from "@/api/http/route";

// Organization-wide permissions are enforced by each safe root handler.
export const dataExportsRoute = routes(
  {
    "/": { GET: listDataExports, POST: createDataExport },
    "/:exportId": { GET: readDataExport },
    "/:exportId/download": { POST: downloadDataExport },
  },
  { prefix: "/data-exports" },
);
