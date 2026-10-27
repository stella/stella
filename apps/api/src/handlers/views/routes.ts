import convertView from "@/api/handlers/views/convert";
import createView from "@/api/handlers/views/create";
import deleteView from "@/api/handlers/views/delete";
import readViews from "@/api/handlers/views/list";
import reorderViews from "@/api/handlers/views/reorder";
import exportTableView from "@/api/handlers/views/table/export";
import updateView from "@/api/handlers/views/update";
import { mount, routes } from "@/api/http/route";

export const viewsRoute = mount(
  [
    routes({
      "/": { GET: readViews, PUT: createView },
      "/reorder": { POST: reorderViews },
    }),
    routes(
      {
        "/": { POST: updateView, DELETE: deleteView },
        "/convert": { POST: convertView },
        "/export": { GET: exportTableView },
      },
      { prefix: "/view/:viewId" },
    ),
  ],
  { prefix: "/views/:workspaceId" },
);
