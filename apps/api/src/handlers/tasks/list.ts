import type { TSchema } from "@sinclair/typebox";
import { Result } from "better-result";
import { t } from "elysia";

import { TASK_ASSIGNEE_FILTER } from "@stll/api-contract/tasks";
import type { TaskAssigneeFilter } from "@stll/api-contract/tasks";

import {
  decodeTaskListCursor,
  listTasksPage,
} from "@/api/handlers/tasks/list-query";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import type { SafeId } from "@/api/lib/branded-types";
import {
  tPaginationCursor,
  tPaginationLimit,
  tSafeId,
} from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";

const TASK_ASSIGNEE_FILTER_SCHEMAS = {
  [TASK_ASSIGNEE_FILTER.ME]: t.Literal(TASK_ASSIGNEE_FILTER.ME),
  [TASK_ASSIGNEE_FILTER.ANY]: t.Literal(TASK_ASSIGNEE_FILTER.ANY),
} as const satisfies Record<TaskAssigneeFilter, TSchema>;

const listTasksQuerySchema = t.Object({
  matterId: t.Optional(tSafeId("workspace")),
  status: t.Optional(
    t.String({
      minLength: 1,
      maxLength: 32,
      description: "List only tasks with this status",
    }),
  ),
  assignee: t.Optional(
    t.Union(
      [
        TASK_ASSIGNEE_FILTER_SCHEMAS[TASK_ASSIGNEE_FILTER.ME],
        TASK_ASSIGNEE_FILTER_SCHEMAS[TASK_ASSIGNEE_FILTER.ANY],
      ],
      {
        description:
          "`me` lists only tasks assigned to the caller; `any` (default) lists every task",
      },
    ),
  ),
  dateFrom: t.Optional(
    t.String({
      format: "date",
      description: "List only tasks due on or after this ISO date (YYYY-MM-DD)",
    }),
  ),
  dateTo: t.Optional(
    t.String({
      format: "date",
      description:
        "List only tasks due on or before this ISO date (YYYY-MM-DD)",
    }),
  ),
  limit: t.Optional(tPaginationLimit(LIMITS.myTasksPageSizeMax)),
  cursor: t.Optional(tPaginationCursor()),
});

const config = {
  description:
    "List tasks across every matter the caller can read, soonest due first " +
    "and undated last; each task names its matter. Narrow to one matter with " +
    "matterId, to the caller's own assignments with assignee=me, or by " +
    "status or a due-date range.",
  permissions: { workspace: ["read"] },
  mcp: { type: "covered", by: "list_tasks" },
  access: "read",
  query: listTasksQuerySchema,
} satisfies HandlerConfig;

const listTasks = createSafeRootHandler(
  config,
  async function* ({
    safeDb,
    session,
    user,
    query: { matterId, cursor, ...query },
    getActiveWorkspaceIds,
    getWorkspaceAccess,
  }) {
    const decodedCursor =
      cursor === undefined ? null : decodeTaskListCursor(cursor);
    if (cursor !== undefined && decodedCursor === null) {
      return Result.err(
        new HandlerError({ status: 400, message: "Invalid cursor" }),
      );
    }

    let workspaceIds: SafeId<"workspace">[];
    if (matterId === undefined) {
      workspaceIds = yield* Result.await(
        Result.tryPromise(async () => await getActiveWorkspaceIds()),
      );
    } else {
      const access = yield* Result.await(
        Result.tryPromise(async () => await getWorkspaceAccess(matterId)),
      );
      // A deleting matter is outside the active set the cross-matter view
      // lists, so it is not readable here either.
      if (!access || access.status === "deleting") {
        return Result.err(
          new HandlerError({ status: 404, message: "Matter not found" }),
        );
      }
      workspaceIds = [access.id];
    }

    const page = yield* Result.await(
      listTasksPage({
        safeDb,
        organizationId: session.activeOrganizationId,
        userId: user.id,
        workspaceIds,
        query: { ...query, cursor: decodedCursor },
      }),
    );
    return Result.ok(page);
  },
);

export default listTasks;
