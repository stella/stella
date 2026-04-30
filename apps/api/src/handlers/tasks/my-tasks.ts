import type { ScopedDb } from "@/api/db";
import type { SafeId } from "@/api/lib/branded-types";
import { TASK_STATUS } from "@/api/lib/entity-constants";

type MyTasksProps = {
  userId: SafeId<"user">;
  scopedDb: ScopedDb;
};

export const myTasksHandler = async ({ userId, scopedDb }: MyTasksProps) => {
  const assignments = await scopedDb((tx) =>
    tx.query.taskAssignees.findMany({
      where: { userId },
      columns: { entityId: true, role: true },
      limit: 500,
    }),
  );

  if (assignments.length === 0) {
    return [];
  }

  const entityIds = assignments.map((a) => a.entityId);

  return scopedDb((tx) =>
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
              },
            },
          },
        },
      },
      orderBy: {
        dueDate: "asc",
      },
      limit: 200,
    }),
  );
};
