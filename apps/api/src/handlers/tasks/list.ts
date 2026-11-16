import { Result } from "better-result";
import * as v from "valibot";

import { apiDateSchema } from "@stll/api-contract/api-date";
import {
  booleanFromString,
  numberFromString,
} from "@stll/api-contract/http-input";

import {
  decodeTaskListCursor,
  listTasksPage,
} from "@/api/handlers/tasks/list-query";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import {
  paginationCursorSchema,
  paginationLimitSchema,
  resourceIdSchema,
} from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import {
  TASK_ASSIGNEE_FILTER,
  TASK_ASSIGNEE_FILTERS,
} from "@/api/lib/tasks/assigned";

const config = {
  contract: "patch",
  description:
    "List tasks across every matter you can open, or in one with matterId, " +
    "soonest due date first and undated tasks last. By default only your " +
    "own open tasks: assignee 'any' lists everyone's and 'unassigned' those " +
    "nobody has, openOnly=false keeps done and cancelled ones, and dateTo " +
    "keeps tasks due on or before that day (with openOnly, the overdue " +
    "ones). Each item names its matter (id, name, reference). Paginate with " +
    "limit and cursor.",
  permissions: { workspace: ["read"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: { type: "covered", by: "list_tasks" },
  access: "read",
  query: v.object({
    limit: v.optional(
      numberFromString(paginationLimitSchema(LIMITS.myTasksPageSizeMax)),
    ),
    cursor: v.optional(paginationCursorSchema()),
    assignee: v.optional(v.picklist(TASK_ASSIGNEE_FILTERS)),
    matterId: v.optional(resourceIdSchema("workspace")),
    openOnly: v.optional(booleanFromString()),
    dateTo: v.optional(apiDateSchema),
  }),
} satisfies HandlerConfig;

const listTasks = createSafeRootHandler(
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
    const accessible = yield* Result.await(
      Result.tryPromise(async () => await getActiveWorkspaceIds()),
    );
    const { matterId } = query;
    const workspaceIds =
      matterId === undefined
        ? accessible
        : accessible.filter((id) => id === matterId);
    if (matterId !== undefined && workspaceIds.length === 0) {
      return Result.err(
        new HandlerError({
          status: 404,
          code: "not_found",
          message: "Matter not found",
        }),
      );
    }
    const page = yield* Result.await(
      listTasksPage({
        safeDb,
        organizationId: session.activeOrganizationId,
        userId: user.id,
        workspaceIds,
        query: {
          assignee: query.assignee ?? TASK_ASSIGNEE_FILTER.ME,
          openOnly: query.openOnly ?? true,
          dateTo: query.dateTo,
          limit: query.limit,
          cursor,
        },
      }),
    );
    return Result.ok(page);
  },
);

export default listTasks;
