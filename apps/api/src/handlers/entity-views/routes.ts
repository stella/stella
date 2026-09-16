import Elysia from "elysia";

import queryWindow from "@/api/handlers/entity-views/query-window";
import create from "@/api/handlers/entity-views/create";
import remove from "@/api/handlers/entity-views/delete";
import list from "@/api/handlers/entity-views/list";
import reorder from "@/api/handlers/entity-views/reorder";
import update from "@/api/handlers/entity-views/update";
import { authMacro, permissionMacro } from "@/api/lib/auth";

export const entityViewsRoute = new Elysia({ prefix: "/entity-views" })
  .use(authMacro)
  .use(permissionMacro)
  .guard({ validateAuth: true })
  .get("/", list.handler, { permissions: list.config.permissions })
  .put("/", create.handler, { body: create.config.body, permissions: create.config.permissions })
  .patch("/:viewId", update.handler, { params: update.config.params, body: update.config.body, permissions: update.config.permissions })
  .delete("/:viewId", remove.handler, { params: remove.config.params, permissions: remove.config.permissions })
  .post("/reorder", reorder.handler, { body: reorder.config.body, permissions: reorder.config.permissions })
  .post("/query-window", queryWindow.handler, {
    body: queryWindow.config.body,
    permissions: queryWindow.config.permissions,
  });
