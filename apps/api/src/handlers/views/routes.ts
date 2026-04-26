import Elysia from "elysia";

import convertView from "@/api/handlers/views/convert";
import createView from "@/api/handlers/views/create";
import deleteView from "@/api/handlers/views/delete";
import readViews from "@/api/handlers/views/read";
import reorderViews from "@/api/handlers/views/reorder";
import updateView from "@/api/handlers/views/update";
import { workspaceAccessMacro } from "@/api/lib/auth";

export const viewsRoute = new Elysia({
  prefix: "/views/:workspaceId",
})
  .use(workspaceAccessMacro)
  .guard({
    validateWorkspaceAccess: true,
  })
  .get("/", readViews.handler)
  .put("/", createView.handler, {
    body: createView.config.body,
  })
  .post("/reorder", reorderViews.handler, {
    body: reorderViews.config.body,
  })
  .group("/view/:viewId", (app) =>
    app
      .post("/", updateView.handler, {
        params: updateView.config.params,
        body: updateView.config.body,
      })
      .post("/convert", convertView.handler, {
        params: convertView.config.params,
        body: convertView.config.body,
      })
      .delete("/", deleteView.handler, {
        params: deleteView.config.params,
      }),
  );
