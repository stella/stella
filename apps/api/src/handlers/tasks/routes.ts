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
  .put(
    "/",
    {
      body: createTask.config.body,
      permissions: createTask.config.permissions,
    },
    createTask.handler,
  )
  .patch(
    "/",
    {
      body: updateTask.config.body,
      permissions: updateTask.config.permissions,
    },
    updateTask.handler,
  )
  .post(
    "/calendar",
    {
      body: calendarTasks.config.body,
      permissions: calendarTasks.config.permissions,
    },
    calendarTasks.handler,
  )
  .get(
    "/:taskId",
    {
      params: readTaskById.config.params,
      permissions: readTaskById.config.permissions,
    },
    readTaskById.handler,
  )
  .post(
    "/assignees",
    {
      body: addAssignee.config.body,
      permissions: addAssignee.config.permissions,
    },
    addAssignee.handler,
  )
  .delete(
    "/assignees",
    {
      body: removeAssignee.config.body,
      permissions: removeAssignee.config.permissions,
    },
    removeAssignee.handler,
  )
  .post(
    "/assignees/move",
    {
      body: moveAssignee.config.body,
      permissions: moveAssignee.config.permissions,
    },
    moveAssignee.handler,
  )
  .post(
    "/links",
    {
      body: createEntityLink.config.body,
      permissions: createEntityLink.config.permissions,
    },
    createEntityLink.handler,
  )
  .delete(
    "/links",
    {
      body: deleteEntityLink.config.body,
      permissions: deleteEntityLink.config.permissions,
    },
    deleteEntityLink.handler,
  )
  .get(
    "/:taskId/links",
    {
      params: listEntityLinks.config.params,
      permissions: listEntityLinks.config.permissions,
    },
    listEntityLinks.handler,
  );
