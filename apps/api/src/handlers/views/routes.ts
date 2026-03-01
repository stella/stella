import Elysia from "elysia";

import {
  createViewBodySchema,
  createViewHandler,
} from "@/api/handlers/views/create";
import { deleteViewHandler } from "@/api/handlers/views/delete-by-id";
import { readViewsHandler } from "@/api/handlers/views/read";
import {
  reorderViewsBodySchema,
  reorderViewsHandler,
} from "@/api/handlers/views/reorder";
import {
  updateViewBodySchema,
  updateViewHandler,
} from "@/api/handlers/views/update-by-id";
import { workspaceAccessMacro } from "@/api/lib/auth";
import { invalidateQuery } from "@/api/lib/invalidate-query-macro";

export const viewsRoute = new Elysia({
  prefix: "/views/:workspaceId",
})
  .use(workspaceAccessMacro)
  .use(invalidateQuery)
  .guard({
    validateWorkspaceAccess: true,
  })
  .put(
    "/",
    (ctx) =>
      createViewHandler({
        workspaceId: ctx.workspaceId,
        body: ctx.body,
      }),
    {
      invalidateQuery: true,
      body: createViewBodySchema,
    },
  )
  .get("/", (ctx) =>
    readViewsHandler({
      workspaceId: ctx.workspaceId,
    }),
  )
  .patch(
    "/reorder",
    (ctx) =>
      reorderViewsHandler({
        workspaceId: ctx.workspaceId,
        body: ctx.body,
      }),
    {
      invalidateQuery: true,
      body: reorderViewsBodySchema,
    },
  )
  .group("/view/:viewId", (app) =>
    app
      .post(
        "/",
        (ctx) =>
          updateViewHandler({
            viewId: ctx.params.viewId,
            workspaceId: ctx.workspaceId,
            body: ctx.body,
          }),
        {
          invalidateQuery: true,
          body: updateViewBodySchema,
        },
      )
      .delete(
        "/",
        (ctx) =>
          deleteViewHandler({
            viewId: ctx.params.viewId,
            workspaceId: ctx.workspaceId,
          }),
        {
          invalidateQuery: true,
        },
      ),
  );
