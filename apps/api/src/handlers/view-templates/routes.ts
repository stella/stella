import createViewTemplate from "@/api/handlers/view-templates/create";
import deleteViewTemplate from "@/api/handlers/view-templates/delete";
import listViewTemplates from "@/api/handlers/view-templates/list";
import { routes } from "@/api/http/route";

export const viewTemplatesRoute = routes(
  {
    "/": { GET: listViewTemplates, PUT: createViewTemplate },
    "/:templateId": { DELETE: deleteViewTemplate },
  },
  { prefix: "/view-templates/:workspaceId" },
);
