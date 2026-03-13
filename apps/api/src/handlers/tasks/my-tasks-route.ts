import Elysia from "elysia";

import { myTasksHandler } from "@/api/handlers/tasks/my-tasks";
import { authMacro } from "@/api/lib/auth";

export const myTasksRoute = new Elysia({ prefix: "/my-tasks" })
  .use(authMacro)
  .guard({ validateAuth: true })
  .get(
    "/",
    async (ctx) =>
      await myTasksHandler({
        userId: ctx.user.id,
        scopedDb: ctx.scopedDb,
      }),
  );
