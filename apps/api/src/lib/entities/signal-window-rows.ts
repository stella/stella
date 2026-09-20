import { getColumns, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import { TASK_STATUS } from "@stll/api-contract/entity-options";
import { ENTITY_VIEW_ROW_KIND } from "@stll/api-contract/entity-views";
import type { EntityViewRowKind } from "@stll/api-contract/entity-views";
import { SIGNAL_STATUS, SUGGESTION_KIND } from "@stll/api-contract/signals";

import { entities, signals } from "@/api/db/schema";
import { AGENDA_ITEM_KIND } from "@/api/lib/entity-constants";

type EntityColumnKey = keyof typeof entities.$inferSelect;

const ENTITY_COLUMNS = getColumns(entities);
const ENTITY_COLUMN_KEYS = Object.keys(ENTITY_COLUMNS).filter(
  (key): key is EntityColumnKey => Object.hasOwn(ENTITY_COLUMNS, key),
);

/** The discriminator column the union adds beside the entity columns. */
const WINDOW_ROW_KIND_COLUMN = "row_kind";

const PROPOSAL = sql.identifier("signal_proposal");
const proposalKind = sql`${PROPOSAL}.kind`;
const proposalDueAt = sql`left(${PROPOSAL}.due_at, 10)`;

/**
 * The first suggestion that would become a task or deadline, in the order the
 * scout listed them: the same one the card offers to accept.
 */
const proposalJoin = sql`LEFT JOIN LATERAL (
  SELECT suggestion.elem->>'kind' AS kind, suggestion.elem->>'dueAt' AS due_at
  FROM jsonb_array_elements(${signals.suggestions}) WITH ORDINALITY
    AS suggestion(elem, ord)
  WHERE suggestion.elem->>'kind' IN (
    ${SUGGESTION_KIND.CREATE_TASK}::text,
    ${SUGGESTION_KIND.CREATE_DEADLINE}::text
  )
  ORDER BY suggestion.ord
  LIMIT 1
) AS ${PROPOSAL} ON true`;

/**
 * A signal read as an entity-shaped row, so the view filters, sorts and
 * keyset cursor compile once and apply to both kinds unchanged. The record is
 * total over the entity columns: a new entity column fails to compile here
 * until it decides what a signal holds for it.
 *
 * Columns a signal has no meaning for are NULL, which every sort key already
 * orders last (ascending) or first (descending) through its sentinel, and
 * which no filter value matches. The ones that carry meaning:
 * - `kind` is `task` when the signal proposes a task or deadline, else NULL,
 *   so a kind filter keeps the proposals that would become tasks.
 * - `agenda_kind` and `due_date` come from that proposal; an unparseable
 *   `dueAt` reads as no date rather than failing the page.
 * - `status` maps the signal lifecycle onto the task statuses: open while new
 *   or snoozed, done once accepted, cancelled once dismissed.
 * - `name`/`display_name` are the title, `created_by` the author.
 * - `current_version_id` is NULL, so property filters and sorts find no field
 *   value, exactly as for an entity whose property is unset.
 */
const SIGNAL_ENTITY_COLUMNS = {
  id: sql`${signals.id}`,
  workspaceId: sql`${signals.workspaceId}`,
  kind: sql`CASE WHEN ${proposalKind} IS NOT NULL THEN 'task'::text END`,
  listItemType: sql`NULL`,
  parentId: sql`NULL`,
  name: sql`${signals.title}::text`,
  duplicateSourceEntityId: sql`NULL`,
  displayName: sql`${signals.title}`,
  createdBy: sql`${signals.createdByUserId}`,
  lastEditedBy: sql`NULL`,
  currentVersionId: sql`NULL`,
  docSequence: sql`NULL`,
  status: sql`(CASE ${signals.status}
    WHEN ${SIGNAL_STATUS.ACCEPTED}::text THEN ${TASK_STATUS.DONE}::text
    WHEN ${SIGNAL_STATUS.DISMISSED}::text THEN ${TASK_STATUS.CANCELLED}::text
    ELSE ${TASK_STATUS.OPEN}::text
  END)::varchar`,
  priority: sql`NULL`,
  dueDate: sql`CASE WHEN pg_input_is_valid(${proposalDueAt}, 'date')
    THEN ${proposalDueAt}::date END`,
  agendaKind: sql`CASE ${proposalKind}
    WHEN ${SUGGESTION_KIND.CREATE_DEADLINE}::text THEN ${AGENDA_ITEM_KIND.DEADLINE}::text
    WHEN ${SUGGESTION_KIND.CREATE_TASK}::text THEN ${AGENDA_ITEM_KIND.TASK}::text
  END`,
  startAt: sql`NULL`,
  endAt: sql`NULL`,
  occurredAt: sql`NULL`,
  remindAt: sql`NULL`,
  allDay: sql`false`,
  timeZone: sql`NULL`,
  location: sql`NULL`,
  onlineMeetingUrl: sql`NULL`,
  availability: sql`NULL`,
  sensitivity: sql`NULL`,
  organizer: sql`NULL`,
  attendees: sql`NULL`,
  recurrence: sql`NULL`,
  agendaSource: sql`NULL`,
  externalSource: sql`NULL`,
  externalId: sql`NULL`,
  externalChangeKey: sql`NULL`,
  externalICalUid: sql`NULL`,
  externalData: sql`NULL`,
  // A signal is changed through its own transitions, never as an entity.
  readOnly: sql`true`,
  sortOrder: sql`NULL`,
  metadata: sql`NULL`,
  createdAt: sql`${signals.createdAt}`,
  updatedAt: sql`${signals.updatedAt}`,
} as const satisfies Record<EntityColumnKey, SQL>;

const rowKindSql = (kind: EntityViewRowKind): SQL =>
  sql`${kind}::text AS ${sql.identifier(WINDOW_ROW_KIND_COLUMN)}`;

const columnAlias = (key: EntityColumnKey) =>
  sql.identifier(ENTITY_COLUMNS[key].name);

type EntityWindowUnionOptions = {
  /** Access for stored rows: the window's scope plus any lifecycle slice. */
  entityConditions: SQL;
  /** Access for signals: the signal list's own predicate, composed by its slice. */
  signalConditions: SQL;
};

/**
 * One row source for the window: stored entities UNION ALL signals, each
 * branch filtered by its own access predicate, exposed under the `entities`
 * name so every filter, sort key and cursor condition built against
 * `entities.*` applies to the union as a whole. Postgres pushes those outer
 * conditions into both branches.
 */
export const entityWindowUnionSource = ({
  entityConditions,
  signalConditions,
}: EntityWindowUnionOptions): SQL => {
  const entityBranch = sql.join(
    [
      rowKindSql(ENTITY_VIEW_ROW_KIND.ENTITY),
      ...ENTITY_COLUMN_KEYS.map(
        (key) => sql`${ENTITY_COLUMNS[key]} AS ${columnAlias(key)}`,
      ),
    ],
    sql`, `,
  );
  const signalBranch = sql.join(
    [
      rowKindSql(ENTITY_VIEW_ROW_KIND.SIGNAL),
      ...ENTITY_COLUMN_KEYS.map(
        (key) => sql`${SIGNAL_ENTITY_COLUMNS[key]} AS ${columnAlias(key)}`,
      ),
    ],
    sql`, `,
  );
  return sql`(
    SELECT ${entityBranch} FROM ${entities} WHERE ${entityConditions}
    UNION ALL
    SELECT ${signalBranch} FROM ${signals} ${proposalJoin}
    WHERE ${signalConditions}
  ) AS ${sql.identifier("entities")}`;
};

/** The union's discriminator, read in the outer query. */
export const windowRowKindColumn = sql`${sql.identifier("entities")}.${sql.identifier(WINDOW_ROW_KIND_COLUMN)}`;
