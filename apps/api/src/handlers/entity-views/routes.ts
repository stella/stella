import Elysia from "elysia";

import create from "@/api/handlers/entity-views/create";
import remove from "@/api/handlers/entity-views/delete";
import list from "@/api/handlers/entity-views/list";
import reorder from "@/api/handlers/entity-views/reorder";
import listRows from "@/api/handlers/entity-views/rows/list";
import update from "@/api/handlers/entity-views/update";
import { authMacro, permissionMacro } from "@/api/lib/auth";

export const entityViewsRoute = new Elysia({ prefix: "/entity-views" })
  .use(authMacro)
  .use(permissionMacro)
  .guard({ validateAuth: true })
  .get("/", { permissions: list.config.permissions }, list.handler)
  .put(
    "/",
    {
      body: create.config.body,
      permissions: create.config.permissions,
    },
    create.handler,
  )
  .patch(
    "/:viewId",
    {
      params: update.config.params,
      body: update.config.body,
      permissions: update.config.permissions,
    },
    update.handler,
  )
  .delete(
    "/:viewId",
    {
      params: remove.config.params,
      permissions: remove.config.permissions,
    },
    remove.handler,
  )
  .post(
    "/reorder",
    {
      body: reorder.config.body,
      permissions: reorder.config.permissions,
    },
    reorder.handler,
  )
  .post(
    "/query-window",
    {
      body: listRows.config.body,
      permissions: listRows.config.permissions,
    },
    listRows.handler,
  );
