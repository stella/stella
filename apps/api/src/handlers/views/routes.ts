import Elysia from "elysia";

import convertView from "@/api/handlers/views/convert";
import createView from "@/api/handlers/views/create";
import deleteView from "@/api/handlers/views/delete";
import readViews from "@/api/handlers/views/list";
import reorderViews from "@/api/handlers/views/reorder";
import exportTableView from "@/api/handlers/views/table/export";
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
  .get(
    "/",
    {
      permissions: readViews.config.permissions,
    },
    readViews.handler,
  )
  .put(
    "/",
    {
      body: createView.config.body,
      permissions: createView.config.permissions,
    },
    createView.handler,
  )
  .post(
    "/reorder",
    {
      body: reorderViews.config.body,
      permissions: reorderViews.config.permissions,
    },
    reorderViews.handler,
  )
  .group("/view/:viewId", (app) =>
    app
      .post(
        "/",
        {
          body: updateView.config.body,
          params: updateView.config.params,
          permissions: updateView.config.permissions,
        },
        updateView.handler,
      )
      .post(
        "/convert",
        {
          body: convertView.config.body,
          params: convertView.config.params,
          permissions: convertView.config.permissions,
        },
        convertView.handler,
      )
      .get(
        "/export",
        {
          params: exportTableView.config.params,
          permissions: exportTableView.config.permissions,
          query: exportTableView.config.query,
        },
        exportTableView.handler,
      )
      .delete(
        "/",
        {
          params: deleteView.config.params,
          permissions: deleteView.config.permissions,
        },
        deleteView.handler,
      ),
  );
