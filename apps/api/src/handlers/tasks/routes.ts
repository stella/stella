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
import { routes } from "@/api/http/route";

export const tasksRoute = routes(
  {
    "/": { PUT: createTask, PATCH: updateTask },
    "/calendar": { POST: calendarTasks },
    "/:taskId": { GET: readTaskById },
    "/assignees": { POST: addAssignee, DELETE: removeAssignee },
    "/assignees/move": { POST: moveAssignee },
    "/links": { POST: createEntityLink, DELETE: deleteEntityLink },
    "/:taskId/links": { GET: listEntityLinks },
  },
  { prefix: "/tasks/:workspaceId" },
);
