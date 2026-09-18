import Elysia from "elysia";

import { RESOURCE_TYPE } from "@stll/api-contract";

import addAssignee from "@/api/handlers/tasks/assignees-add";
import removeAssignee from "@/api/handlers/tasks/assignees-remove";
import moveAssignee from "@/api/handlers/tasks/assignees/move";
import calendarTasks from "@/api/handlers/tasks/calendar";
import createTask from "@/api/handlers/tasks/create";
import createEntityLink from "@/api/handlers/tasks/entity-links-create";
import deleteEntityLink from "@/api/handlers/tasks/entity-links-delete";
import listEntityLinks from "@/api/handlers/tasks/entity-links-read";
import readTaskById from "@/api/handlers/tasks/get";
import updateTask from "@/api/handlers/tasks/update";
import { permissionMacro, workspaceAccessMacro } from "@/api/lib/auth";
import {
  resourceRealtime,
  workspaceResourceSetUpdates,
} from "@/api/lib/resource-realtime-macro";

const taskRealtimeUpdates = workspaceResourceSetUpdates(RESOURCE_TYPE.ENTITY);
const taskCreateRealtimeUpdates = workspaceResourceSetUpdates([
  RESOURCE_TYPE.ENTITY,
  RESOURCE_TYPE.LEGAL_LIST,
]);

export const tasksRoute = new Elysia({
  prefix: "/tasks/:workspaceId",
})
  .use(workspaceAccessMacro)
  .use(resourceRealtime)
  .use(permissionMacro)
  .guard({
    validateWorkspaceAccess: true,
  })
  .put("/", createTask.handler, {
    body: createTask.config.body,
    resourceSetUpdated: taskCreateRealtimeUpdates,
    permissions: createTask.config.permissions,
  })
  .patch("/", updateTask.handler, {
    body: updateTask.config.body,
    resourceSetUpdated: taskRealtimeUpdates,
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
    resourceSetUpdated: taskRealtimeUpdates,
    permissions: addAssignee.config.permissions,
  })
  .delete("/assignees", removeAssignee.handler, {
    body: removeAssignee.config.body,
    resourceSetUpdated: taskRealtimeUpdates,
    permissions: removeAssignee.config.permissions,
  })
  .post("/assignees/move", moveAssignee.handler, {
    body: moveAssignee.config.body,
    resourceSetUpdated: taskRealtimeUpdates,
    permissions: moveAssignee.config.permissions,
  })
  .post("/links", createEntityLink.handler, {
    body: createEntityLink.config.body,
    resourceSetUpdated: taskRealtimeUpdates,
    permissions: createEntityLink.config.permissions,
  })
  .delete("/links", deleteEntityLink.handler, {
    body: deleteEntityLink.config.body,
    resourceSetUpdated: taskRealtimeUpdates,
    permissions: deleteEntityLink.config.permissions,
  })
  .get("/:taskId/links", listEntityLinks.handler, {
    params: listEntityLinks.config.params,
    permissions: listEntityLinks.config.permissions,
  });
