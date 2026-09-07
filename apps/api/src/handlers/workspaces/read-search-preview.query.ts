import { panic } from "better-result";
import {
  and,
  asc,
  desc,
  eq,
  gte,
  isNotNull,
  isNull,
  notInArray,
  or,
  sql,
} from "drizzle-orm";

import { TASK_STATUS } from "@stll/api-contract";

import type { ScopedDb } from "@/api/db/safe-db";
import { entities } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { LIMITS } from "@/api/lib/limits";
import type {
  UnbackedProjectionKeys,
  UnprojectedColumns,
} from "@/api/lib/projection-totality";

type PreviewItemRow = typeof entities.$inferSelect;

const AGENDA_COLUMNS = {
  id: entities.id,
  name: entities.name,
  dueDate: entities.dueDate,
};
const DOCUMENT_COLUMNS = {
  id: entities.id,
  name: entities.name,
  updatedAt: entities.updatedAt,
};
const LEGACY_DOCUMENT_COLUMNS = {
  id: entities.id,
  name: entities.name,
  createdAt: entities.createdAt,
};

// These three projections jointly supply the preview; legacy creation dates
// become document activity dates only at the response boundary below.
type PreviewSourceColumns = typeof AGENDA_COLUMNS &
  typeof DOCUMENT_COLUMNS &
  typeof LEGACY_DOCUMENT_COLUMNS;

const UNPROJECTED_PREVIEW_COLUMNS = [
  "workspaceId", // Already supplied by the authorized route.
  "kind", // Each query fixes the kind; the response groups identify it.
  "listItemType", // Task-list presentation is not part of a deadline highlight.
  "parentId", // Folder hierarchy belongs to document navigation.
  "displayName", // The highlight uses the same name as search results.
  "createdBy", // Actor profiles are not included in compact highlights.
  "lastEditedBy", // Actor profiles are not included in compact highlights.
  "currentVersionId", // Opening the document resolves its current version.
  "docSequence", // Document numbering is not displayed in highlights.
  "status", // Used only to exclude completed or cancelled tasks.
  "priority", // Highlights are ordered by deadline, not priority.
  "agendaKind", // This preview includes dated tasks, not calendar details.
  "startAt", // Calendar start times are outside deadline highlights.
  "endAt", // Calendar end times are outside deadline highlights.
  "occurredAt", // Historical calendar events are not projected.
  "remindAt", // Reminder configuration belongs to the task detail.
  "allDay", // Date-only deadlines need no calendar duration semantics.
  "timeZone", // Date-only deadlines are not converted between time zones.
  "location", // Meeting details are not part of the preview.
  "onlineMeetingUrl", // Meeting links are not part of the preview.
  "availability", // Calendar availability is not part of the preview.
  "sensitivity", // Calendar sensitivity metadata is not displayed here.
  "organizer", // Meeting participants are not part of the preview.
  "attendees", // Meeting participants are not part of the preview.
  "recurrence", // Recurrence rules belong to agenda detail.
  "agendaSource", // Calendar connector provenance is not displayed here.
  "externalSource", // External connector metadata stays on the detail path.
  "externalId", // External connector identifiers are not exposed here.
  "externalChangeKey", // Connector concurrency tokens are internal.
  "externalICalUid", // Calendar synchronization identifiers are internal.
  "externalData", // Raw connector metadata is not needed for highlights.
  "readOnly", // The preview has no editing actions.
  "sortOrder", // Highlight ordering is fixed by date and identifier.
  "metadata", // Link metadata is unrelated to task/document highlights.
] as const satisfies readonly (keyof PreviewItemRow)[];

type MissingPreviewColumn = UnprojectedColumns<
  PreviewItemRow,
  PreviewSourceColumns,
  (typeof UNPROJECTED_PREVIEW_COLUMNS)[number]
>;
type UnexpectedPreviewColumn = UnbackedProjectionKeys<
  PreviewItemRow,
  PreviewSourceColumns,
  (typeof UNPROJECTED_PREVIEW_COLUMNS)[number]
>;

true satisfies MissingPreviewColumn extends never ? true : never;
true satisfies UnexpectedPreviewColumn extends never ? true : never;

type ReadSearchPreviewOptions = {
  scopedDb: ScopedDb;
  workspaceId: SafeId<"workspace">;
};

export const readSearchPreviewHandler = async ({
  scopedDb,
  workspaceId,
}: ReadSearchPreviewOptions) =>
  await scopedDb(async (tx) => {
    const [upcomingAgenda, updatedDocuments, legacyDocuments] =
      await Promise.all([
        tx
          .select(AGENDA_COLUMNS)
          .from(entities)
          .where(
            and(
              eq(entities.workspaceId, workspaceId),
              eq(entities.kind, "task"),
              isNotNull(entities.dueDate),
              gte(entities.dueDate, sql`CURRENT_DATE`),
              or(
                isNull(entities.status),
                notInArray(entities.status, [
                  TASK_STATUS.DONE,
                  TASK_STATUS.CANCELLED,
                ]),
              ),
            ),
          )
          .orderBy(asc(entities.dueDate), asc(entities.id))
          .limit(LIMITS.matterSearchPreviewAgendaItems),
        tx
          .select(DOCUMENT_COLUMNS)
          .from(entities)
          .where(
            and(
              eq(entities.workspaceId, workspaceId),
              eq(entities.kind, "document"),
              isNotNull(entities.updatedAt),
            ),
          )
          .orderBy(desc(entities.updatedAt), desc(entities.id))
          .limit(LIMITS.matterSearchPreviewDocuments),
        tx
          .select(LEGACY_DOCUMENT_COLUMNS)
          .from(entities)
          .where(
            and(
              eq(entities.workspaceId, workspaceId),
              eq(entities.kind, "document"),
              isNull(entities.updatedAt),
            ),
          )
          .orderBy(desc(entities.createdAt), desc(entities.id))
          .limit(LIMITS.matterSearchPreviewDocuments),
      ]);

    const recentDocuments = [
      ...updatedDocuments,
      ...legacyDocuments.map(({ id, name, createdAt }) => ({
        id,
        name,
        updatedAt: createdAt,
      })),
    ]
      .map((document) => ({
        id: document.id,
        name: document.name,
        updatedAt:
          document.updatedAt ??
          panic("Matter preview document has no activity timestamp"),
      }))
      .sort((left, right) => {
        const dateOrder = right.updatedAt.getTime() - left.updatedAt.getTime();
        if (dateOrder !== 0 || left.id === right.id) {
          return dateOrder;
        }
        return left.id < right.id ? 1 : -1;
      })
      .slice(0, LIMITS.matterSearchPreviewDocuments);

    return {
      upcomingAgenda: upcomingAgenda.map((item) => ({
        id: item.id,
        name: item.name,
        dueDate:
          item.dueDate ?? panic("Dated matter preview item has no due date"),
      })),
      recentDocuments: recentDocuments.map((document) => ({
        id: document.id,
        name: document.name,
        updatedAt: document.updatedAt.toISOString(),
      })),
    };
  });
