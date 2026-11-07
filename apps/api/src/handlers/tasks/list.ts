import { Result } from "better-result";
import * as v from "valibot";

import { numberFromString } from "@stll/api-contract/http-input";

import {
  decodeTaskListCursor,
  listTasksPage,
} from "@/api/handlers/tasks/list-query";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import {
  paginationCursorSchema,
  paginationLimitSchema,
} from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { TASK_ASSIGNEE_FILTER } from "@/api/lib/tasks/assigned";

const config = {
  contract: "patch",
  description:
    "List your open tasks across every matter you can open: the tasks you " +
    "are assigned to that are not done or cancelled, soonest due date " +
    "first and undated tasks last. Each item names its matter (id, name, " +
    "reference). Paginate with limit and cursor.",
  permissions: { workspace: ["read"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: { type: "covered", by: "list_tasks" },
  access: "read",
  query: v.object({
    limit: v.optional(
      numberFromString(paginationLimitSchema(LIMITS.myTasksPageSizeMax)),
    ),
    cursor: v.optional(paginationCursorSchema()),
  }),
} satisfies HandlerConfig;

const listMyOpenTasks = createSafeRootHandler(
  config,
  async function* ({ getActiveWorkspaceIds, query, safeDb, session, user }) {
    const cursor =
      query.cursor === undefined ? null : decodeTaskListCursor(query.cursor);
    if (query.cursor !== undefined && cursor === null) {
      return Result.err(
        new HandlerError({
          status: 400,
          code: "invalid_cursor",
          message: "Invalid cursor",
          hint: "Restart the list without a cursor.",
        }),
      );
    }
    // The same access map the MCP cross-matter list reads: every matter the
    // caller can open that is not being deleted. RLS narrows it again inside
    // the query.
    const workspaceIds = yield* Result.await(
      Result.tryPromise(async () => await getActiveWorkspaceIds()),
    );
    const page = yield* Result.await(
      listTasksPage({
        safeDb,
        organizationId: session.activeOrganizationId,
        userId: user.id,
        workspaceIds,
        query: {
          assignee: TASK_ASSIGNEE_FILTER.ME,
          openOnly: true,
          limit: query.limit,
          cursor,
        },
      }),
    );
    return Result.ok(page);
  },
);

export default listMyOpenTasks;
