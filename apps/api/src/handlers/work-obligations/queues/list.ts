import { Result } from "better-result";
import { and, asc, eq, gt, inArray, lte, or, sql } from "drizzle-orm";
import { t } from "elysia";

import {
  entities,
  WORK_OBLIGATION_STATUS,
  workObligations,
  workspaces,
} from "@/api/db/schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import {
  createCursorPage,
  decodePaginationCursor,
  encodePaginationCursor,
  isDateOnlyPaginationCursorPart,
  isUuidPaginationCursorPart,
} from "@/api/lib/pagination";
import { brandPersistedEntityId } from "@/api/lib/safe-id-boundaries";

const WORK_QUEUE_PAGE_SIZE_DEFAULT = 50;
const WORK_QUEUE_PAGE_SIZE_MAX = 100;
const LAST_SORT_DATE = "9999-12-31";

const MY_WORK_QUEUE = {
  INBOX: "inbox",
  UPCOMING: "upcoming",
  AT_RISK: "at_risk",
  COMPLETED: "completed",
} as const;

const MY_WORK_QUEUES = [
  MY_WORK_QUEUE.INBOX,
  MY_WORK_QUEUE.UPCOMING,
  MY_WORK_QUEUE.AT_RISK,
  MY_WORK_QUEUE.COMPLETED,
] as const;

const myWorkQuery = t.Object({
  queue: t.Optional(t.UnionEnum(MY_WORK_QUEUES)),
  asOf: t.Optional(t.String({ format: "date" })),
  limit: t.Optional(
    t.Integer({ minimum: 1, maximum: WORK_QUEUE_PAGE_SIZE_MAX }),
  ),
  cursor: t.Optional(t.String({ maxLength: 512 })),
});

const config = {
  permissions: { workspace: ["read"] },
  mcp: { type: "capability", reason: "workflow_orchestration" },
  access: "read",
  query: myWorkQuery,
} satisfies HandlerConfig;

const sortDate = sql<string>`COALESCE(${workObligations.hardDeadlineDate}, ${workObligations.workingTargetDate}, ${LAST_SORT_DATE}::date)`;

const myWork = createSafeRootHandler(
  config,
  async function* ({ scopedDb, user, query }) {
    const queue = query.queue ?? MY_WORK_QUEUE.UPCOMING;
    const asOf = query.asOf ?? new Date().toISOString().slice(0, 10);
    const limit = query.limit ?? WORK_QUEUE_PAGE_SIZE_DEFAULT;
    const conditions = [eq(workObligations.ownerUserId, user.id)];

    switch (queue) {
      case MY_WORK_QUEUE.INBOX:
        conditions.push(
          eq(
            workObligations.status,
            WORK_OBLIGATION_STATUS.AWAITING_ACKNOWLEDGEMENT,
          ),
        );
        break;
      case MY_WORK_QUEUE.UPCOMING:
        conditions.push(
          inArray(workObligations.status, [
            WORK_OBLIGATION_STATUS.AWAITING_ACKNOWLEDGEMENT,
            WORK_OBLIGATION_STATUS.ACTIVE,
          ]),
        );
        break;
      case MY_WORK_QUEUE.AT_RISK:
        conditions.push(
          inArray(workObligations.status, [
            WORK_OBLIGATION_STATUS.AWAITING_ACKNOWLEDGEMENT,
            WORK_OBLIGATION_STATUS.ACTIVE,
          ]),
          lte(sortDate, asOf),
        );
        break;
      case MY_WORK_QUEUE.COMPLETED:
        conditions.push(
          eq(workObligations.status, WORK_OBLIGATION_STATUS.COMPLETED),
        );
        break;
      default: {
        const exhaustive: never = queue;
        return exhaustive;
      }
    }

    if (query.cursor) {
      const parts = decodePaginationCursor(query.cursor);
      const cursorDate = parts?.at(0);
      const cursorEntityId = parts?.at(1);
      if (
        !isDateOnlyPaginationCursorPart(cursorDate) ||
        !isUuidPaginationCursorPart(cursorEntityId)
      ) {
        return Result.err(
          new HandlerError({ status: 400, message: "Invalid cursor" }),
        );
      }
      const entityId = brandPersistedEntityId(cursorEntityId);
      const cursorCondition = or(
        gt(sortDate, cursorDate),
        and(eq(sortDate, cursorDate), gt(workObligations.entityId, entityId)),
      );
      if (cursorCondition) {
        conditions.push(cursorCondition);
      }
    }

    const rows = yield* Result.await(
      scopedDb((tx) =>
        tx
          .select({
            entityId: workObligations.entityId,
            workspaceId: workObligations.workspaceId,
            workspaceName: workspaces.name,
            type: workObligations.type,
            workflowStatus: workObligations.status,
            acknowledgedAt: workObligations.acknowledgedAt,
            workingTargetDate: workObligations.workingTargetDate,
            hardDeadlineDate: workObligations.hardDeadlineDate,
            sourceType: workObligations.sourceType,
            sourceDescription: workObligations.sourceDescription,
            name: entities.name,
            taskStatus: entities.status,
            priority: entities.priority,
            sortDate,
          })
          .from(workObligations)
          .innerJoin(
            entities,
            and(
              eq(entities.id, workObligations.entityId),
              eq(entities.workspaceId, workObligations.workspaceId),
              eq(entities.kind, "task"),
            ),
          )
          .innerJoin(workspaces, eq(workspaces.id, workObligations.workspaceId))
          .where(and(...conditions))
          .orderBy(asc(sortDate), asc(workObligations.entityId))
          .limit(limit + 1),
      ),
    );

    const page = createCursorPage({
      rows,
      limit,
      cursorForItem: ({ sortDate: date, entityId }) =>
        encodePaginationCursor([date, entityId]),
    });

    return Result.ok({
      ...page,
      items: page.items.map(({ sortDate: _sortDate, ...item }) => ({
        ...item,
        acknowledgedAt: item.acknowledgedAt?.toISOString() ?? null,
        attention:
          item.workflowStatus ===
          WORK_OBLIGATION_STATUS.AWAITING_ACKNOWLEDGEMENT
            ? "acknowledgement_required"
            : item.hardDeadlineDate !== null && item.hardDeadlineDate <= asOf
              ? "hard_deadline_due"
              : item.workingTargetDate !== null &&
                  item.workingTargetDate <= asOf
                ? "working_target_due"
                : "none",
      })),
    });
  },
);

export default myWork;
