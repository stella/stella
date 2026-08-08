import { Result } from "better-result";
import Elysia, { t } from "elysia";

import { myTasksHandler } from "@/api/handlers/tasks/my-tasks";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { authMacro } from "@/api/lib/auth";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import {
  decodePaginationCursor,
  isUuidPaginationCursorPart,
} from "@/api/lib/pagination";
import { brandPersistedEntityId } from "@/api/lib/safe-id-boundaries";

const querySchema = t.Object({
  cursor: t.Optional(t.String({ maxLength: 512 })),
  limit: t.Optional(
    t.Integer({ minimum: 1, maximum: LIMITS.myTasksPageSizeMax }),
  ),
});

const config = {
  permissions: { workspace: ["read"] },
  mcp: { type: "covered", by: "list_tasks" },
  query: querySchema,
} satisfies HandlerConfig;

const decodeCursor = (cursor: string) => {
  const entityId = decodePaginationCursor(cursor)?.at(0);
  return isUuidPaginationCursorPart(entityId)
    ? brandPersistedEntityId(entityId)
    : null;
};

const myTasksEndpoint = createSafeRootHandler(
  config,
  async function* ({ query, scopedDb, user }) {
    const cursorEntityId = query.cursor ? decodeCursor(query.cursor) : null;
    if (query.cursor && cursorEntityId === null) {
      return Result.err(
        new HandlerError({ status: 400, message: "Invalid cursor" }),
      );
    }

    const response = yield* Result.await(
      Result.tryPromise(
        async () =>
          await myTasksHandler({
            cursorEntityId,
            limit: query.limit ?? LIMITS.myTasksPageSizeDefault,
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
  .get("/", myTasksEndpoint.handler, {
    permissions: myTasksEndpoint.config.permissions,
    query: myTasksEndpoint.config.query,
  });
