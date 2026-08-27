import { and, asc, eq, gt, inArray, ne, or, sql } from "drizzle-orm";
import { type Static, t } from "elysia";

import type { ScopedDb } from "@/api/db/safe-db";
import { entities, taskAssignees } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import type { TaskStatus } from "@/api/lib/entity-constants";
import { TASK_STATUS } from "@/api/lib/entity-constants";
import { createCursorPage, encodePaginationCursor } from "@/api/lib/pagination";

const MY_TASKS_LAST_SORT_DATE = "9999-12-31";
const myTasksSortDate = sql<string>`COALESCE(${entities.dueDate}, ${MY_TASKS_LAST_SORT_DATE}::date)`;

export type MyTasksStatus = Exclude<TaskStatus, typeof TASK_STATUS.CANCELLED>;

const myTasksStatusSchemas = {
  [TASK_STATUS.OPEN]: t.Literal(TASK_STATUS.OPEN),
  [TASK_STATUS.IN_PROGRESS]: t.Literal(TASK_STATUS.IN_PROGRESS),
  [TASK_STATUS.IN_REVIEW]: t.Literal(TASK_STATUS.IN_REVIEW),
  [TASK_STATUS.DONE]: t.Literal(TASK_STATUS.DONE),
} as const satisfies Record<MyTasksStatus, ReturnType<typeof t.Literal>>;

export const myTasksStatusSchema = t.Union([
  myTasksStatusSchemas[TASK_STATUS.OPEN],
  myTasksStatusSchemas[TASK_STATUS.IN_PROGRESS],
  myTasksStatusSchemas[TASK_STATUS.IN_REVIEW],
  myTasksStatusSchemas[TASK_STATUS.DONE],
]);

type MissingMyTasksStatus = Exclude<
  MyTasksStatus,
  Static<typeof myTasksStatusSchema>
>;
type ExtraMyTasksStatus = Exclude<
  Static<typeof myTasksStatusSchema>,
  MyTasksStatus
>;

true satisfies [MissingMyTasksStatus, ExtraMyTasksStatus] extends [never, never]
  ? true
  : never;

export type MyTasksCursor = {
  entityId: SafeId<"entity">;
  sortDate: string;
};

type MyTasksProps = {
  cursor: MyTasksCursor | null;
  limit: number;
  status: MyTasksStatus | null;
  userId: SafeId<"user">;
  activeWorkspaceIds: SafeId<"workspace">[];
  scopedDb: ScopedDb;
};

export const myTasksHandler = async ({
  cursor,
  limit,
  status,
  userId,
  activeWorkspaceIds,
  scopedDb,
}: MyTasksProps) => {
  const conditions = [
    eq(taskAssignees.userId, userId),
    eq(entities.kind, "task"),
    ne(entities.status, TASK_STATUS.CANCELLED),
    inArray(entities.workspaceId, activeWorkspaceIds),
  ];

  if (status) {
    conditions.push(eq(entities.status, status));
  }

  if (cursor) {
    const cursorCondition = or(
      gt(myTasksSortDate, cursor.sortDate),
      and(
        eq(myTasksSortDate, cursor.sortDate),
        gt(entities.id, cursor.entityId),
      ),
    );
    if (cursorCondition) {
      conditions.push(cursorCondition);
    }
  }

  const visibleTasks = await scopedDb((tx) =>
    tx
      .select({ entityId: entities.id, sortDate: myTasksSortDate })
      .from(taskAssignees)
      .innerJoin(
        entities,
        and(
          eq(entities.id, taskAssignees.entityId),
          eq(entities.workspaceId, taskAssignees.workspaceId),
        ),
      )
      .where(and(...conditions))
      .orderBy(asc(myTasksSortDate), asc(entities.id))
      .limit(limit + 1),
  );

  const visibleTaskPage = createCursorPage({
    rows: visibleTasks,
    limit,
    cursorForItem: ({ entityId, sortDate }) =>
      encodePaginationCursor([sortDate, entityId]),
  });

  const entityIds = visibleTaskPage.items.map(({ entityId }) => entityId);
  if (entityIds.length === 0) {
    return { items: [], limit, nextCursor: null };
  }

  const tasks = await scopedDb((tx) =>
    tx.query.entities.findMany({
      where: {
        id: { in: entityIds },
        kind: { eq: "task" },
        status: { ne: TASK_STATUS.CANCELLED },
      },
      columns: {
        id: true,
        name: true,
        status: true,
        priority: true,
        dueDate: true,
        listItemType: true,
        agendaKind: true,
        startAt: true,
        endAt: true,
        occurredAt: true,
        remindAt: true,
        allDay: true,
        timeZone: true,
        location: true,
        onlineMeetingUrl: true,
        availability: true,
        sensitivity: true,
        organizer: true,
        attendees: true,
        recurrence: true,
        agendaSource: true,
        externalSource: true,
        externalId: true,
        externalChangeKey: true,
        externalICalUid: true,
        readOnly: true,
        workspaceId: true,
        createdAt: true,
      },
      with: {
        workspace: {
          columns: { id: true, name: true },
        },
        assignees: {
          with: {
            user: {
              columns: {
                id: true,
                name: true,
                image: true,
                deletedAt: true,
              },
            },
          },
        },
      },
      limit,
    }),
  );

  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  return {
    items: entityIds.flatMap((entityId) => {
      const task = tasksById.get(entityId);
      return task ? [task] : [];
    }),
    limit,
    nextCursor: visibleTaskPage.nextCursor,
  };
};
