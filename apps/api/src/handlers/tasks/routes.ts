import Elysia, { status, t } from "elysia";

import {
  addAssigneeBodySchema,
  addAssigneeHandler,
  removeAssigneeBodySchema,
  removeAssigneeHandler,
} from "@/api/handlers/tasks/assignees";
import {
  createTaskBodySchema,
  createTaskHandler,
} from "@/api/handlers/tasks/create";
import {
  createEntityLinkBodySchema,
  createEntityLinkHandler,
  deleteEntityLinkBodySchema,
  deleteEntityLinkHandler,
  listEntityLinksHandler,
} from "@/api/handlers/tasks/entity-links";
import { readTaskByIdHandler } from "@/api/handlers/tasks/read-by-id";
import {
  updateTaskBodySchema,
  updateTaskHandler,
} from "@/api/handlers/tasks/update";
import { permissionMacro, workspaceAccessMacro } from "@/api/lib/auth";
import { invalidateQuery } from "@/api/lib/invalidate-query-macro";

export const tasksRoute = new Elysia({
  prefix: "/tasks/:workspaceId",
})
  .use(workspaceAccessMacro)
  .use(invalidateQuery)
  .use(permissionMacro)
  .guard({
    validateWorkspaceAccess: true,
  })
  .put(
    "/",
    async (ctx) =>
      await createTaskHandler({
        workspaceId: ctx.workspaceId,
        userId: ctx.user.id,
        body: ctx.body,
        scopedDb: ctx.scopedDb,
      }),
    {
      permissions: { entity: ["create"] },
      invalidateQuery: true,
      body: createTaskBodySchema,
    },
  )
  .patch(
    "/",
    async (ctx) =>
      await updateTaskHandler({
        workspaceId: ctx.workspaceId,
        body: ctx.body,
        scopedDb: ctx.scopedDb,
      }),
    {
      permissions: { entity: ["update"] },
      invalidateQuery: true,
      body: updateTaskBodySchema,
    },
  )
  .get(
    "/:taskId",
    async (ctx) => {
      const result = await readTaskByIdHandler({
        workspaceId: ctx.workspaceId,
        taskId: ctx.params.taskId,
        scopedDb: ctx.scopedDb,
      });
      if (!result) {
        return status(404, { message: "Task not found" });
      }
      return result;
    },
    {
      params: t.Object({
        workspaceId: t.String(),
        taskId: t.String(),
      }),
    },
  )
  .post(
    "/assignees",
    async (ctx) =>
      await addAssigneeHandler({
        workspaceId: ctx.workspaceId,
        body: ctx.body,
        scopedDb: ctx.scopedDb,
      }),
    {
      permissions: { entity: ["update"] },
      invalidateQuery: true,
      body: addAssigneeBodySchema,
    },
  )
  .delete(
    "/assignees",
    async (ctx) =>
      await removeAssigneeHandler({
        workspaceId: ctx.workspaceId,
        body: ctx.body,
        scopedDb: ctx.scopedDb,
      }),
    {
      permissions: { entity: ["update"] },
      invalidateQuery: true,
      body: removeAssigneeBodySchema,
    },
  )
  .post(
    "/links",
    async (ctx) =>
      await createEntityLinkHandler({
        workspaceId: ctx.workspaceId,
        body: ctx.body,
        scopedDb: ctx.scopedDb,
      }),
    {
      permissions: { entity: ["update"] },
      invalidateQuery: true,
      body: createEntityLinkBodySchema,
    },
  )
  .delete(
    "/links",
    async (ctx) =>
      await deleteEntityLinkHandler({
        workspaceId: ctx.workspaceId,
        body: ctx.body,
        scopedDb: ctx.scopedDb,
      }),
    {
      permissions: { entity: ["update"] },
      invalidateQuery: true,
      body: deleteEntityLinkBodySchema,
    },
  )
  .get(
    "/:taskId/links",
    async (ctx) =>
      await listEntityLinksHandler({
        workspaceId: ctx.workspaceId,
        entityId: ctx.params.taskId,
        scopedDb: ctx.scopedDb,
      }),
    {
      params: t.Object({
        workspaceId: t.String(),
        taskId: t.String(),
      }),
    },
  );
