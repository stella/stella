import Elysia from "elysia";

import addAssignee from "@/api/handlers/tasks/assignees-add";
import removeAssignee from "@/api/handlers/tasks/assignees-remove";
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
    invalidateQuery: true,
    body: createTask.config.body,
  })
  .patch("/", updateTask.handler, {
    invalidateQuery: true,
    body: updateTask.config.body,
  })
  .get("/:taskId", readTaskById.handler, {
    params: readTaskById.config.params,
  })
  .post("/assignees", addAssignee.handler, {
    invalidateQuery: true,
    body: addAssignee.config.body,
  })
  .delete("/assignees", removeAssignee.handler, {
    invalidateQuery: true,
    body: removeAssignee.config.body,
  })
  .post("/links", createEntityLink.handler, {
    invalidateQuery: true,
    body: createEntityLink.config.body,
  })
  .delete("/links", deleteEntityLink.handler, {
    invalidateQuery: true,
    body: deleteEntityLink.config.body,
  })
  .get("/:taskId/links", listEntityLinks.handler, {
    params: listEntityLinks.config.params,
  });
