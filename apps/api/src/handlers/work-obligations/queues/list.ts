import { Result } from "better-result";
import { and, asc, eq, gt, inArray, or, sql } from "drizzle-orm";
import { t } from "elysia";

import type { WorkObligationStatus } from "@stll/api-contract/workflow-status";

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
import { workObligationEligibleEntity } from "@/api/lib/work-obligations/eligibility";

const WORK_QUEUE_PAGE_SIZE_DEFAULT = 50;
const WORK_QUEUE_PAGE_SIZE_MAX = 100;
const LAST_SORT_DATE = "9999-12-31";

const MY_WORK_QUEUE = {
  INBOX: "inbox",
  UPCOMING: "upcoming",
  AT_RISK: "at_risk",
  COMPLETED: "completed",
} as const;

const myWorkQuery = t.Object({
  queue: t.Optional(
    t.Union([
      t.Literal(MY_WORK_QUEUE.INBOX),
      t.Literal(MY_WORK_QUEUE.UPCOMING),
      t.Literal(MY_WORK_QUEUE.AT_RISK),
      t.Literal(MY_WORK_QUEUE.COMPLETED),
    ]),
  ),
  asOf: t.Optional(t.String({ format: "date" })),
  limit: t.Optional(
    t.Integer({ minimum: 1, maximum: WORK_QUEUE_PAGE_SIZE_MAX }),
  ),
  cursor: t.Optional(t.String({ maxLength: 512 })),
});

const config = {
  description:
    "List the signed-in user's governed work with cursor pagination. The queues partition the work: at-risk holds every open obligation already due, inbox the rest awaiting acknowledgement, upcoming the rest already acknowledged, and completed the finished work.",
  permissions: { workspace: ["read"] },
  mcp: { type: "capability", reason: "workflow_orchestration" },
  access: "read",
  query: myWorkQuery,
} satisfies HandlerConfig;

const sortDate = sql<string>`COALESCE(${workObligations.hardDeadlineDate}, ${workObligations.workingTargetDate}, ${LAST_SORT_DATE}::date)`;

/**
 * The one boundary the three open queues partition on. `COALESCE` keeps a
 * dateless obligation out of at-risk and, negated, inside its status queue:
 * plain three-valued logic would drop it from both.
 */
const isOverdue = (asOf: string) =>
  sql`COALESCE(${workObligations.hardDeadlineDate} <= ${asOf}::date OR ${workObligations.workingTargetDate} <= ${asOf}::date, false)`;

type QueueRow = {
  workflowStatus: WorkObligationStatus;
  hardDeadlineDate: string | null;
  workingTargetDate: string | null;
};

const getAttention = (
  { workflowStatus, hardDeadlineDate, workingTargetDate }: QueueRow,
  asOf: string,
) => {
  if (workflowStatus === WORK_OBLIGATION_STATUS.AWAITING_ACKNOWLEDGEMENT) {
    return "acknowledgement_required" as const;
  }
  if (hardDeadlineDate !== null && hardDeadlineDate <= asOf) {
    return "hard_deadline_due" as const;
  }
  if (workingTargetDate !== null && workingTargetDate <= asOf) {
    return "working_target_due" as const;
  }
  return "none" as const;
};

const myWork = createSafeRootHandler(
  config,
  async function* ({ scopedDb, user, query }) {
    // No queue is a superset of the others any more, so the default is the one
    // that needs an answer from the owner rather than the widest slice.
    const queue = query.queue ?? MY_WORK_QUEUE.INBOX;
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
          sql`NOT ${isOverdue(asOf)}`,
        );
        break;
      case MY_WORK_QUEUE.UPCOMING:
        conditions.push(
          eq(workObligations.status, WORK_OBLIGATION_STATUS.ACTIVE),
          sql`NOT ${isOverdue(asOf)}`,
        );
        break;
      case MY_WORK_QUEUE.AT_RISK:
        conditions.push(
          inArray(workObligations.status, [
            WORK_OBLIGATION_STATUS.AWAITING_ACKNOWLEDGEMENT,
            WORK_OBLIGATION_STATUS.ACTIVE,
          ]),
          isOverdue(asOf),
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
      Result.tryPromise({
        try: async () =>
          await scopedDb((tx) =>
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
                  workObligationEligibleEntity,
                ),
              )
              .innerJoin(
                workspaces,
                eq(workspaces.id, workObligations.workspaceId),
              )
              .where(and(...conditions))
              .orderBy(asc(sortDate), asc(workObligations.entityId))
              .limit(limit + 1),
          ),
        catch: (cause) =>
          new HandlerError({
            status: 500,
            message: "Could not load work queue",
            cause,
          }),
      }),
    );

    const page = createCursorPage({
      rows,
      limit,
      cursorForItem: ({ sortDate: date, entityId }) =>
        encodePaginationCursor([date, entityId]),
    });

    return Result.ok({
      ...page,
      items: page.items.map((item) => ({
        entityId: item.entityId,
        workspaceId: item.workspaceId,
        workspaceName: item.workspaceName,
        type: item.type,
        workflowStatus: item.workflowStatus,
        acknowledgedAt: item.acknowledgedAt?.toISOString() ?? null,
        workingTargetDate: item.workingTargetDate,
        hardDeadlineDate: item.hardDeadlineDate,
        sourceType: item.sourceType,
        sourceDescription: item.sourceDescription,
        name: item.name,
        taskStatus: item.taskStatus,
        priority: item.priority,
        attention: getAttention(item, asOf),
      })),
    });
  },
);

export default myWork;
