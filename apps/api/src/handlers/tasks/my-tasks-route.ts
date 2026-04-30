import { Result } from "better-result";
import Elysia from "elysia";

import { myTasksHandler } from "@/api/handlers/tasks/my-tasks";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { authMacro } from "@/api/lib/auth";

const myTasksEndpoint = createSafeRootHandler(
  {
    permissions: { workspace: ["read"] },
  } satisfies HandlerConfig,
  async function* ({ scopedDb, user }) {
    const response = yield* Result.await(
      Result.tryPromise(
        async () =>
          await myTasksHandler({
            userId: user.id,
            scopedDb,
          }),
      ),
    );

    return Result.ok(response);
  },
);

export const myTasksRoute = new Elysia({ prefix: "/my-tasks" })
  .use(authMacro)
  .guard({ validateAuth: true })
  .get("/", myTasksEndpoint.handler);
