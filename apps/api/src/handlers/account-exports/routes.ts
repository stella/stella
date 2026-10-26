import requestPersonalDataExport from "@/api/handlers/account-exports/create";
import downloadPersonalDataExport from "@/api/handlers/account-exports/download";
import latestPersonalDataExport from "@/api/handlers/account-exports/get";
import personalDataExportStatus from "@/api/handlers/account-exports/status/get";
import { mount, routes } from "@/api/http/route";

export const accountExportsRoute = mount(
  [
    routes(
      {
        "/": { GET: latestPersonalDataExport, POST: requestPersonalDataExport },
        "/:exportId": { GET: personalDataExportStatus },
        "/:exportId/download": { GET: downloadPersonalDataExport },
      },
      { prefix: "/data-exports" },
    ),
  ],
  { prefix: "/me" },
);
