import { Result } from "better-result";
import Elysia, { t } from "elysia";

import {
  myTasksHandler,
  myTasksStatusSchema,
  type MyTasksCursor,
} from "@/api/handlers/tasks/my-tasks";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { authMacro } from "@/api/lib/auth";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import {
  decodePaginationCursor,
  isDateOnlyPaginationCursorPart,
  isUuidPaginationCursorPart,
} from "@/api/lib/pagination";
import { brandPersistedEntityId } from "@/api/lib/safe-id-boundaries";

const querySchema = t.Object({
  cursor: t.Optional(t.String({ maxLength: 512 })),
  limit: t.Optional(
    t.Integer({ minimum: 1, maximum: LIMITS.myTasksPageSizeMax }),
  ),
  status: t.Optional(myTasksStatusSchema),
});

const config = {
  permissions: { workspace: ["read"] },
  mcp: { type: "covered", by: "list_tasks" },
  query: querySchema,
} satisfies HandlerConfig;

const decodeCursor = (cursor: string) => {
  const parts = decodePaginationCursor(cursor);
  const sortDate = parts?.at(0);
  const entityId = parts?.at(1);
  if (
    !isDateOnlyPaginationCursorPart(sortDate) ||
    !isUuidPaginationCursorPart(entityId)
  ) {
    return null;
  }
  return {
    entityId: brandPersistedEntityId(entityId),
    sortDate,
  } satisfies MyTasksCursor;
};

const myTasksEndpoint = createSafeRootHandler(
  config,
  async function* ({ getActiveWorkspaceIds, query, scopedDb, user }) {
    const cursor = query.cursor ? decodeCursor(query.cursor) : null;
    if (query.cursor && cursor === null) {
      return Result.err(
        new HandlerError({ status: 400, message: "Invalid cursor" }),
      );
    }

    const activeWorkspaceIds = yield* Result.await(
      Result.tryPromise(async () => await getActiveWorkspaceIds()),
    );

    const response = yield* Result.await(
      Result.tryPromise(
        async () =>
          await myTasksHandler({
            cursor,
            limit: query.limit ?? LIMITS.myTasksPageSizeDefault,
            status: query.status ?? null,
            userId: user.id,
            activeWorkspaceIds,
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
