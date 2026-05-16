import Elysia from "elysia";

import addAssignee from "@/api/handlers/tasks/assignees-add";
import removeAssignee from "@/api/handlers/tasks/assignees-remove";
import calendarTasks from "@/api/handlers/tasks/calendar";
import createTask from "@/api/handlers/tasks/create";
import createEntityLink from "@/api/handlers/tasks/entity-links-create";
import deleteEntityLink from "@/api/handlers/tasks/entity-links-delete";
import listEntityLinks from "@/api/handlers/tasks/entity-links-read";
import readTaskById from "@/api/handlers/tasks/read-by-id";
import updateTask from "@/api/handlers/tasks/update";
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
  .put("/", createTask.handler, {
    body: createTask.config.body,
    invalidateQuery: true,
    permissions: createTask.config.permissions,
  })
  .patch("/", updateTask.handler, {
    body: updateTask.config.body,
    invalidateQuery: true,
    permissions: updateTask.config.permissions,
  })
  .post("/calendar", calendarTasks.handler, {
    body: calendarTasks.config.body,
    permissions: calendarTasks.config.permissions,
  })
  .get("/:taskId", readTaskById.handler, {
    params: readTaskById.config.params,
    permissions: readTaskById.config.permissions,
  })
  .post("/assignees", addAssignee.handler, {
    body: addAssignee.config.body,
    invalidateQuery: true,
    permissions: addAssignee.config.permissions,
  })
  .delete("/assignees", removeAssignee.handler, {
    body: removeAssignee.config.body,
    invalidateQuery: true,
    permissions: removeAssignee.config.permissions,
  })
  .post("/links", createEntityLink.handler, {
    body: createEntityLink.config.body,
    invalidateQuery: true,
    permissions: createEntityLink.config.permissions,
  })
  .delete("/links", deleteEntityLink.handler, {
    body: deleteEntityLink.config.body,
    invalidateQuery: true,
    permissions: deleteEntityLink.config.permissions,
  })
  .get("/:taskId/links", listEntityLinks.handler, {
    params: listEntityLinks.config.params,
    permissions: listEntityLinks.config.permissions,
  });
