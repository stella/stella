import type { ScopedDb } from "@/api/db/safe-db";
import type { SafeId } from "@/api/lib/branded-types";
import { TASK_STATUS } from "@/api/lib/entity-constants";
import { createCursorPage, encodePaginationCursor } from "@/api/lib/pagination";

type MyTasksProps = {
  cursorEntityId: SafeId<"entity"> | null;
  limit: number;
  userId: SafeId<"user">;
  scopedDb: ScopedDb;
};

export const myTasksHandler = async ({
  cursorEntityId,
  limit,
  userId,
  scopedDb,
}: MyTasksProps) => {
  const assignments = await scopedDb((tx) =>
    tx.query.taskAssignees.findMany({
      where: {
        userId,
        ...(cursorEntityId ? { entityId: { gt: cursorEntityId } } : {}),
      },
      columns: { entityId: true, role: true },
      orderBy: { entityId: "asc" },
      limit: limit + 1,
    }),
  );

  const assignmentPage = createCursorPage({
    rows: assignments,
    limit,
    cursorForItem: ({ entityId }) => encodePaginationCursor([entityId]),
  });

  const entityIds = assignmentPage.items.map(
    (assignment) => assignment.entityId,
  );
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
    nextCursor: assignmentPage.nextCursor,
  };
};
