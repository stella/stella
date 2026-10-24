import { panic } from "better-result";
import { and, isNull, or } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import type { entities } from "@/api/db/schema";
import {
  dueFromReaderDate,
  openAgendaTask,
} from "@/api/handlers/workspaces/agenda-conditions";
import type { SafeId } from "@/api/lib/branded-types";
import { LIMITS } from "@/api/lib/limits";
import type {
  UnbackedProjectionKeys,
  UnprojectedColumns,
} from "@/api/lib/projection-totality";

type AgendaTaskRow = typeof entities.$inferSelect;

/** The task columns the agenda sends: what a row on the overview shows. */
const AGENDA_TASK_COLUMNS = {
  id: true,
  name: true,
  status: true,
  dueDate: true,
} as const;

const UNPROJECTED_AGENDA_COLUMNS = [
  "entityFeatureGate", // RLS state is internal to the gate.
  "workspaceId", // Already supplied by the authorized route.
  "kind", // The query fixes the kind to tasks.
  "listItemType", // Only filters agenda rows; never returned.
  "parentId", // Folder hierarchy belongs to document navigation.
  "displayName", // The agenda shows the task's own name.
  "createdBy", // The agenda names the assignee, not the author.
  "lastEditedBy", // Edit history is not part of the agenda.
  "currentVersionId", // Tasks carry no document versions here.
  "docSequence", // Document numbering is not displayed on the agenda.
  "priority", // The agenda is ordered by deadline, not priority.
  "agendaKind", // The agenda lists tasks, not calendar details.
  "startAt", // Calendar start times are outside task deadlines.
  "endAt", // Calendar end times are outside task deadlines.
  "occurredAt", // Historical calendar events are not projected.
  "remindAt", // Reminder configuration belongs to the task detail.
  "allDay", // Date-only deadlines need no calendar duration semantics.
  "timeZone", // Date-only deadlines are not converted between time zones.
  "location", // Meeting details are not part of the agenda.
  "onlineMeetingUrl", // Meeting links are not part of the agenda.
  "availability", // Calendar availability is not part of the agenda.
  "sensitivity", // Calendar sensitivity metadata is not displayed here.
  "organizer", // Meeting participants are not part of the agenda.
  "attendees", // Meeting participants are not part of the agenda.
  "recurrence", // Recurrence rules belong to agenda detail.
  "agendaSource", // Calendar connector provenance is not displayed here.
  "externalSource", // External connector metadata stays on the detail path.
  "externalId", // External connector identifiers are not exposed here.
  "externalChangeKey", // Connector concurrency tokens are internal.
  "externalICalUid", // Calendar synchronization identifiers are internal.
  "externalData", // Raw connector metadata is not needed on the agenda.
  "duplicateSourceEntityId", // Copy provenance is internal to replay handling.
  "readOnly", // The agenda has no editing actions.
  "sortOrder", // Agenda ordering is fixed by deadline and identifier.
  "metadata", // Link metadata is unrelated to tasks.
  "createdAt", // The agenda orders by deadline, not creation.
  "updatedAt", // Recent edits are the activity feed's concern.
] as const satisfies readonly (keyof AgendaTaskRow)[];

type MissingAgendaColumn = UnprojectedColumns<
  AgendaTaskRow,
  typeof AGENDA_TASK_COLUMNS,
  (typeof UNPROJECTED_AGENDA_COLUMNS)[number]
>;
type UnexpectedAgendaColumn = UnbackedProjectionKeys<
  AgendaTaskRow,
  typeof AGENDA_TASK_COLUMNS,
  (typeof UNPROJECTED_AGENDA_COLUMNS)[number]
>;

true satisfies MissingAgendaColumn extends never ? true : never;
true satisfies UnexpectedAgendaColumn extends never ? true : never;

type ReadOverviewAgendaOptions = {
  tx: Transaction;
  workspaceId: SafeId<"workspace">;
  /** The reader's local date (ISO); the database's today when absent. */
  agendaFrom: string | undefined;
};

/**
 * The matter's upcoming agenda, read on its own rather than filtered from
 * recent activity, so an older open task is not pushed out by newer edits.
 * Nearest due date first; undated open tasks follow. The reader's own date
 * bounds the deadlines before the limit applies.
 */
export const readOverviewAgenda = async ({
  tx,
  workspaceId,
  agendaFrom,
}: ReadOverviewAgendaOptions) => {
  const rows = await tx.query.entities.findMany({
    where: {
      workspaceId: { eq: workspaceId },
      RAW: (table) =>
        and(
          openAgendaTask(table),
          or(isNull(table.dueDate), dueFromReaderDate(table, agendaFrom)),
        ) ?? panic("Agenda condition is never empty"),
    },
    columns: AGENDA_TASK_COLUMNS,
    with: {
      assignees: {
        columns: {},
        orderBy: { createdAt: "asc" },
        limit: 1,
        with: {
          user: {
            columns: {
              name: true,
              email: true,
              image: true,
              deletedAt: true,
            },
          },
        },
      },
    },
    // Ascending due dates put undated tasks last.
    orderBy: { dueDate: "asc", id: "asc" },
    limit: LIMITS.overviewUpcomingAgenda,
  });
  return rows.map((task) => {
    const assignee = task.assignees.at(0)?.user;
    return {
      entityId: task.id,
      name: task.name,
      status: task.status,
      dueDate: task.dueDate,
      assignedTo: assignee ? assignee.name || assignee.email : null,
      assignedToImage: assignee?.image ?? null,
      assignedToDeletedAt: assignee?.deletedAt?.toISOString() ?? null,
    };
  });
};
