import Elysia from "elysia";

import addAssignee from "@/api/handlers/tasks/assignees/add";
import moveAssignee from "@/api/handlers/tasks/assignees/move";
import removeAssignee from "@/api/handlers/tasks/assignees/remove";
import calendarTasks from "@/api/handlers/tasks/calendar/list";
import createTask from "@/api/handlers/tasks/create";
import createEntityLink from "@/api/handlers/tasks/entity-links/create";
import deleteEntityLink from "@/api/handlers/tasks/entity-links/delete";
import listEntityLinks from "@/api/handlers/tasks/entity-links/list";
import readTaskById from "@/api/handlers/tasks/get";
import updateTask from "@/api/handlers/tasks/update";
import { permissionMacro, workspaceAccessMacro } from "@/api/lib/auth";

export const tasksRoute = new Elysia({
  prefix: "/tasks/:workspaceId",
})
  .use(workspaceAccessMacro)
  .use(permissionMacro)
  .guard({
    validateWorkspaceAccess: true,
  })
  .put("/", createTask.handler, {
    body: createTask.config.body,
    permissions: createTask.config.permissions,
    accountAccess: createTask.config.accountAccess,
  })
  .patch("/", updateTask.handler, {
    body: updateTask.config.body,
    permissions: updateTask.config.permissions,
    accountAccess: updateTask.config.accountAccess,
  })
  .post("/calendar", calendarTasks.handler, {
    body: calendarTasks.config.body,
    permissions: calendarTasks.config.permissions,
    accountAccess: calendarTasks.config.accountAccess,
  })
  .get("/:taskId", readTaskById.handler, {
    params: readTaskById.config.params,
    permissions: readTaskById.config.permissions,
    accountAccess: readTaskById.config.accountAccess,
  })
  .post("/assignees", addAssignee.handler, {
    body: addAssignee.config.body,
    permissions: addAssignee.config.permissions,
    accountAccess: addAssignee.config.accountAccess,
  })
  .delete("/assignees", removeAssignee.handler, {
    body: removeAssignee.config.body,
    permissions: removeAssignee.config.permissions,
    accountAccess: removeAssignee.config.accountAccess,
  })
  .post("/assignees/move", moveAssignee.handler, {
    body: moveAssignee.config.body,
    permissions: moveAssignee.config.permissions,
    accountAccess: moveAssignee.config.accountAccess,
  })
  .post("/links", createEntityLink.handler, {
    body: createEntityLink.config.body,
    permissions: createEntityLink.config.permissions,
    accountAccess: createEntityLink.config.accountAccess,
  })
  .delete("/links", deleteEntityLink.handler, {
    body: deleteEntityLink.config.body,
    permissions: deleteEntityLink.config.permissions,
    accountAccess: deleteEntityLink.config.accountAccess,
  })
  .get("/:taskId/links", listEntityLinks.handler, {
    params: listEntityLinks.config.params,
    permissions: listEntityLinks.config.permissions,
    accountAccess: listEntityLinks.config.accountAccess,
  });
