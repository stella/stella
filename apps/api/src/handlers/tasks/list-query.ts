import { Result } from "better-result";
import {
  and,
  asc,
  eq,
  gt,
  gte,
  inArray,
  isNull,
  lte,
  or,
  sql,
} from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import { TASK_ASSIGNEE_FILTER } from "@stll/api-contract/tasks";
import type { TaskAssigneeFilter } from "@stll/api-contract/tasks";

import type { SafeDb } from "@/api/db/safe-db";
import { entities, workspaces } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { LIMITS } from "@/api/lib/limits";
import {
  createCursorPage,
  decodePaginationCursor,
  encodePaginationCursor,
  isDateOnlyPaginationCursorPart,
  isUuidPaginationCursorPart,
} from "@/api/lib/pagination";
import type {
  UnbackedProjectionKeys,
  UnprojectedColumns,
} from "@/api/lib/projection-totality";
import { brandPersistedEntityId } from "@/api/lib/safe-id-boundaries";
import { taskAssigneeCondition } from "@/api/lib/tasks/assigned";

/** Keyset position: the last row's due date (null sorts last) and id. */
type TaskListCursor = {
  dueDate: string | null;
  id: SafeId<"entity">;
};

/** Null when the cursor is not one `listTasksPage` produced. */
export const decodeTaskListCursor = (cursor: string): TaskListCursor | null => {
  const parts = decodePaginationCursor(cursor);
  if (parts?.length !== 2) {
    return null;
  }
  const [dueDate, id] = parts;
  if (dueDate !== null && !isDateOnlyPaginationCursorPart(dueDate)) {
    return null;
  }
  if (!isUuidPaginationCursorPart(id)) {
    return null;
  }
  return { dueDate, id: brandPersistedEntityId(id) };
};

const encodeTaskListCursor = ({ dueDate, id }: TaskListCursor): string =>
  encodePaginationCursor([dueDate, id]);

/** Rows strictly after the cursor in `due_date ASC NULLS LAST, id ASC`. */
const afterCursorCondition = ({
  dueDate,
  id,
}: TaskListCursor): SQL | undefined =>
  dueDate === null
    ? and(isNull(entities.dueDate), gt(entities.id, id))
    : or(
        gt(entities.dueDate, dueDate),
        and(eq(entities.dueDate, dueDate), gt(entities.id, id)),
        isNull(entities.dueDate),
      );

type EntityRow = typeof entities.$inferSelect;

// The entity columns a task-list row carries. `listItemType` is sent as
// `itemType`, the name the list contract already uses.
const TASK_LIST_ENTITY_SELECTION = {
  id: entities.id,
  name: entities.name,
  status: entities.status,
  priority: entities.priority,
  listItemType: entities.listItemType,
  dueDate: entities.dueDate,
} as const;

// Columns a task-list row leaves out. The list is a summary; `list_tasks`
// detail mode and `tasks.get` return the full task.
const UNPROJECTED_TASK_LIST_COLUMNS = [
  // Tenant scope: the row names its matter through the joined workspace.
  "workspaceId",
  // Always "task" here, fixed by the query.
  "kind",
  // Hierarchy, versioning, and ordering are detail and editor concerns.
  "parentId",
  "duplicateSourceEntityId",
  "currentVersionId",
  "docSequence",
  "sortOrder",
  // `name` is the list label; the display name belongs to documents.
  "displayName",
  // Authorship and timestamps are detail-view fields.
  "createdBy",
  "lastEditedBy",
  "createdAt",
  "updatedAt",
  // Agenda scheduling and attendance: the detail read and calendar own them.
  "agendaKind",
  "startAt",
  "endAt",
  "occurredAt",
  "remindAt",
  "allDay",
  "timeZone",
  "location",
  "onlineMeetingUrl",
  "availability",
  "sensitivity",
  "organizer",
  "attendees",
  "recurrence",
  "agendaSource",
  // External-calendar sync plumbing, never shown in a list.
  "externalSource",
  "externalId",
  "externalChangeKey",
  "externalICalUid",
  "externalData",
  "readOnly",
  "metadata",
] as const satisfies readonly (keyof EntityRow)[];

type MissingProjectedTaskListColumn = UnprojectedColumns<
  EntityRow,
  typeof TASK_LIST_ENTITY_SELECTION,
  (typeof UNPROJECTED_TASK_LIST_COLUMNS)[number]
>;
type UnexpectedProjectedTaskListColumn = UnbackedProjectionKeys<
  EntityRow,
  typeof TASK_LIST_ENTITY_SELECTION,
  (typeof UNPROJECTED_TASK_LIST_COLUMNS)[number]
>;

true satisfies MissingProjectedTaskListColumn extends never ? true : never;
true satisfies UnexpectedProjectedTaskListColumn extends never ? true : never;

type ListTasksPageQuery = {
  status?: string | undefined;
  assignee?: TaskAssigneeFilter | undefined;
  dateFrom?: string | undefined;
  dateTo?: string | undefined;
  limit?: number | undefined;
  cursor?: TaskListCursor | null | undefined;
};

type ListTasksPageOptions = {
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  /**
   * The matters to list, each already proven readable by the caller's access
   * map (active, non-deleting workspaces). Pass every such matter for the
   * cross-matter view, or one for a single matter.
   */
  workspaceIds: readonly SafeId<"workspace">[];
  query: ListTasksPageQuery;
};

/**
 * One task-list query shared by the HTTP route and MCP `list_tasks`, for one
 * matter or all of them. Access sits in the SQL itself: the workspace
 * allowlist, the organization predicate on the joined matter, and the RLS
 * policies `safeDb` runs under, so a matter outside the caller's membership
 * or organization cannot contribute a row even if it reached the allowlist.
 */
export const listTasksPage = async ({
  safeDb,
  organizationId,
  userId,
  workspaceIds,
  query,
}: ListTasksPageOptions) => {
  const limit = Math.min(
    query.limit ?? LIMITS.myTasksPageSizeDefault,
    LIMITS.myTasksPageSizeMax,
  );
  const rows = await safeDb((tx) =>
    tx
      .select({
        id: TASK_LIST_ENTITY_SELECTION.id,
        name: TASK_LIST_ENTITY_SELECTION.name,
        status: TASK_LIST_ENTITY_SELECTION.status,
        priority: TASK_LIST_ENTITY_SELECTION.priority,
        itemType: TASK_LIST_ENTITY_SELECTION.listItemType,
        dueDate: TASK_LIST_ENTITY_SELECTION.dueDate,
        matterId: workspaces.id,
        matterName: workspaces.name,
        matterReference: workspaces.reference,
      })
      .from(entities)
      .innerJoin(
        workspaces,
        and(
          eq(workspaces.id, entities.workspaceId),
          eq(workspaces.organizationId, organizationId),
        ),
      )
      .where(
        and(
          inArray(entities.workspaceId, [...workspaceIds]),
          eq(entities.kind, "task"),
          query.status === undefined
            ? undefined
            : eq(entities.status, query.status),
          query.dateFrom === undefined
            ? undefined
            : gte(entities.dueDate, query.dateFrom),
          query.dateTo === undefined
            ? undefined
            : lte(entities.dueDate, query.dateTo),
          taskAssigneeCondition({
            assignee: query.assignee ?? TASK_ASSIGNEE_FILTER.ANY,
            userId,
          }),
          query.cursor ? afterCursorCondition(query.cursor) : undefined,
        ),
      )
      .orderBy(sql`${entities.dueDate} asc nulls last`, asc(entities.id))
      .limit(limit + 1),
  );
  if (Result.isError(rows)) {
    return Result.err(rows.error);
  }

  const page = createCursorPage({
    rows: rows.value,
    limit,
    cursorForItem: (item) =>
      encodeTaskListCursor({ dueDate: item.dueDate, id: item.id }),
  });
  return Result.ok({
    ...page,
    items: page.items.map((item) =>
      Object.assign(item, { itemType: item.itemType ?? "task" }),
    ),
  });
};
