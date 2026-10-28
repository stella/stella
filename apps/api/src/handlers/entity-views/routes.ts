import create from "@/api/handlers/entity-views/create";
import remove from "@/api/handlers/entity-views/delete";
import list from "@/api/handlers/entity-views/list";
import reorder from "@/api/handlers/entity-views/reorder";
import listRows from "@/api/handlers/entity-views/rows/list";
import update from "@/api/handlers/entity-views/update";
import { routes } from "@/api/http/route";

export const entityViewsRoute = routes(
  {
    "/": { GET: list, PUT: create },
    "/:viewId": { PATCH: update, DELETE: remove },
    "/reorder": { POST: reorder },
    "/query-window": { POST: listRows },
  },
  { prefix: "/entity-views" },
);
