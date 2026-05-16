import Elysia from "elysia";

import convertView from "@/api/handlers/views/convert";
import createView from "@/api/handlers/views/create";
import deleteView from "@/api/handlers/views/delete";
import readViews from "@/api/handlers/views/read";
import reorderViews from "@/api/handlers/views/reorder";
import exportTableView from "@/api/handlers/views/table-export";
import updateView from "@/api/handlers/views/update";
import { permissionMacro, workspaceAccessMacro } from "@/api/lib/auth";

export const viewsRoute = new Elysia({
  prefix: "/views/:workspaceId",
})
  .use(workspaceAccessMacro)
  .use(permissionMacro)
  .guard({
    validateWorkspaceAccess: true,
  })
  .get("/", readViews.handler, {
    permissions: readViews.config.permissions,
  })
  .put("/", createView.handler, {
    body: createView.config.body,
    permissions: createView.config.permissions,
  })
  .post("/reorder", reorderViews.handler, {
    body: reorderViews.config.body,
    permissions: reorderViews.config.permissions,
  })
  .group("/view/:viewId", (app) =>
    app
      .post("/", updateView.handler, {
        body: updateView.config.body,
        params: updateView.config.params,
        permissions: updateView.config.permissions,
      })
      .post("/convert", convertView.handler, {
        body: convertView.config.body,
        params: convertView.config.params,
        permissions: convertView.config.permissions,
      })
      .get("/export", exportTableView.handler, {
        params: exportTableView.config.params,
        permissions: exportTableView.config.permissions,
        query: exportTableView.config.query,
      })
      .delete("/", deleteView.handler, {
        params: deleteView.config.params,
        permissions: deleteView.config.permissions,
      }),
  );
