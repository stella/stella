import { Result, panic } from "better-result";
import { and, count, eq, inArray, notInArray, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import type { SafeDb, Transaction } from "@/api/db";
import { member, user } from "@/api/db/auth-schema";
import {
  cellMetadata,
  desktopEditSessions,
  entities,
  entityVersions,
  fields,
  searchDocuments,
} from "@/api/db/schema";
import type {
  CellMetadata,
  EntityKind,
  FieldContent,
} from "@/api/db/schema-validators";
import {
  isValidDateCursorValue,
  isValidTimestampCursorValue,
} from "@/api/handlers/entities/cursor-validation";
import type {
  EntitiesWindowCursorValue,
  EntitiesWindowCursorValues,
} from "@/api/handlers/entities/window-cursor";
import type { SafeId } from "@/api/lib/branded-types";
import {
  AGENDA_ITEM_KIND,
  AGENDA_ITEM_SOURCE,
} from "@/api/lib/entity-constants";
import type {
  AgendaItemKind,
  AgendaItemSource,
} from "@/api/lib/entity-constants";
import { buildFilterConditions } from "@/api/lib/entity-filters";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import type { ViewFilterCondition, ViewSort } from "@/api/lib/views-schema";
import { PDF_MIME_TYPE } from "@/api/mime-types";

export type QueryEntitiesFieldMode = "full" | "visible";

type CellMetadataFlagProvenanceResult = {
  addedBy: string;
  addedAt: string;
  addedByName: string | null;
  addedByImage: string | null;
};

type CellMetadataResult = Omit<CellMetadata, "flagProvenance"> & {
  flagProvenance?: Record<string, CellMetadataFlagProvenanceResult>;
};

export type QueryEntityResult = {
  entityId: string;
  kind: EntityKind;
  name: string | null;
  parentId: string | null;
  createdAt: string;
  createdBy: string | null;
  createdByImage: string | null;
  version: number;
  updatedAt: string | null;
  status: string | null;
  priority: string | null;
  dueDate: string | null;
  agendaKind: AgendaItemKind;
  startAt: string | null;
  endAt: string | null;
  occurredAt: string | null;
  remindAt: string | null;
  allDay: boolean;
  timeZone: string | null;
  location: string | null;
  onlineMeetingUrl: string | null;
  availability: string | null;
  sensitivity: string | null;
  organizer: unknown;
  attendees: unknown;
  recurrence: unknown;
  agendaSource: AgendaItemSource;
  externalSource: string | null;
  externalId: string | null;
  externalChangeKey: string | null;
  externalICalUid: string | null;
  readOnly: boolean;
  sortOrder: string | null;
  activeEditBy: { name: string; image: string | null; isMe: boolean } | null;
  fields: {
    id: string;
    propertyId: string;
    entityId: string;
    content: FieldContent;
  }[];
  cellMetadata: {
    propertyId: string;
    metadata: CellMetadataResult;
  }[];
};

type QueryEntitiesProps = {
  safeDb: SafeDb;
  workspaceId: SafeId<"workspace">;
  currentUserId: string;
  currentOrganizationId: SafeId<"organization">;
  filters: ViewFilterCondition[];
  sorts: ViewSort[];
  search?: string | undefined;
  cursor?: EntitiesWindowCursorValues | null | undefined;
  offset?: number | undefined;
  limit: number;
  fieldMode: QueryEntitiesFieldMode;
  fieldIds: SafeId<"property">[];
  excludedKinds?: EntityKind[];
  previewableForAi?: boolean;
  extraConditions?: SQL[];
  includeTotalCount: boolean;
};

const organizationMemberIdsSubquery = (
  tx: Transaction,
  organizationId: SafeId<"organization">,
  aliasName: string,
) =>
  tx
    .select({ userId: member.userId })
    .from(member)
    .where(eq(member.organizationId, organizationId))
    .groupBy(member.userId)
    .as(aliasName);

type VersionScopedRow = {
  entityVersionId: string;
};

const groupByEntityVersionId = <TRow extends VersionScopedRow>(
  rows: TRow[],
) => {
  const byVersionId = new Map<string, TRow[]>();
  for (const row of rows) {
    const list = byVersionId.get(row.entityVersionId);
    if (list) {
      list.push(row);
    } else {
      byVersionId.set(row.entityVersionId, [row]);
    }
  }
  return byVersionId;
};

const getCellMetadataActorIds = (
  rows: { metadata: CellMetadata }[],
): string[] => {
  const userIds = new Set<string>();
  for (const row of rows) {
    for (const provenance of Object.values(row.metadata.flagProvenance ?? {})) {
      userIds.add(provenance.addedBy);
    }
  }
  return [...userIds];
};

type CellMetadataActor = {
  id: string;
  name: string | null;
  image: string | null;
};

const enrichCellMetadata = (
  metadata: CellMetadata,
  actorMap: Map<string, CellMetadataActor>,
): CellMetadataResult => {
  const provenanceEntries = Object.entries(metadata.flagProvenance ?? {});
  if (provenanceEntries.length === 0) {
    return {
      manualFlags: metadata.manualFlags,
      version: metadata.version,
    };
  }

  return {
    ...metadata,
    flagProvenance: Object.fromEntries(
      provenanceEntries.map(([flag, provenance]) => {
        const actor = actorMap.get(provenance.addedBy);
        return [
          flag,
          {
            ...provenance,
            addedByName: actor?.name ?? null,
            addedByImage: actor?.image ?? null,
          },
        ];
      }),
    ),
  };
};

const buildCellMetadataPredicates = ({
  fieldIds,
  fieldMode,
  idFilter,
}: {
  fieldIds: SafeId<"property">[];
  fieldMode: QueryEntitiesFieldMode;
  idFilter: SQL;
}) => {
  const predicates = [
    eq(cellMetadata.entityVersionId, entities.currentVersionId),
    idFilter,
  ];
  if (fieldMode !== "visible") {
    return predicates;
  }

  const uniqueFieldIds = [...new Set(fieldIds)];
  if (uniqueFieldIds.length === 0) {
    predicates.push(sql`false`);
    return predicates;
  }

  predicates.push(inArray(cellMetadata.propertyId, uniqueFieldIds));
  return predicates;
};

type SortValueType = "date" | "number" | "string" | "timestamp";
type SortDirection = "asc" | "desc";

type EntitySortKey = {
  expr: SQL;
  cursorExpr: SQL;
  direction: SortDirection;
  type: SortValueType;
};

const HIGH_TEXT_SENTINEL = "\uffff";
const LOW_DATE_SENTINEL = "0001-01-01";
const HIGH_DATE_SENTINEL = "9999-12-31";
const LOW_TIMESTAMP_SENTINEL = new Date("0001-01-01T00:00:00.000Z");

const orderSortKey = ({ direction, expr }: EntitySortKey): SQL =>
  direction === "desc" ? sql`${expr} DESC` : sql`${expr} ASC`;

const timestampCursorExpr = (expr: SQL): SQL =>
  sql`to_char(${expr}, 'YYYY-MM-DD"T"HH24:MI:SS.US')`;

const textSortKey = ({
  direction,
  expr,
}: {
  direction: SortDirection;
  expr: SQL;
}): EntitySortKey => ({
  expr,
  cursorExpr: expr,
  direction,
  type: "string",
});

const numberSortKey = ({
  direction,
  expr,
}: {
  direction: SortDirection;
  expr: SQL;
}): EntitySortKey => ({
  expr,
  cursorExpr: expr,
  direction,
  type: "number",
});

const defaultNullableTextSortKey = ({
  direction,
  expr,
}: {
  direction: SortDirection;
  expr: SQL;
}): EntitySortKey =>
  textSortKey({
    direction,
    expr: sql`COALESCE(${expr}, ${HIGH_TEXT_SENTINEL})`,
  });

const legacyNullableTextSortKey = ({
  direction,
  expr,
}: {
  direction: SortDirection;
  expr: SQL;
}): EntitySortKey =>
  textSortKey({
    direction,
    expr: sql`COALESCE(${expr}, '')`,
  });

const timestampSortKey = ({
  direction,
  expr,
}: {
  direction: SortDirection;
  expr: SQL;
}): EntitySortKey => ({
  expr,
  cursorExpr: timestampCursorExpr(expr),
  direction,
  type: "timestamp",
});

const dateSortKey = ({
  direction,
  expr,
}: {
  direction: SortDirection;
  expr: SQL;
}): EntitySortKey => ({
  expr,
  cursorExpr: expr,
  direction,
  type: "date",
});

const displayedNameExpr = (): SQL => sql`${entities.displayName}`;

const propertySortValueExpr = (propertyId: string): SQL => sql`(
  SELECT COALESCE(
    ${fields.content}->>'value',
    ${fields.content}->>'fileName',
    ''
  )
  FROM ${fields}
  WHERE ${fields.workspaceId} = ${entities.workspaceId}
    AND ${fields.entityVersionId} = ${entities.currentVersionId}
    AND ${fields.propertyId} = ${propertyId}
  LIMIT 1
)`;

const internalSortKey = ({
  desc,
  propertyId,
}: {
  desc: boolean;
  propertyId: string;
}): EntitySortKey | null => {
  const direction: SortDirection = desc ? "desc" : "asc";
  switch (propertyId) {
    case "_name":
      return textSortKey({ direction, expr: displayedNameExpr() });
    case "_created-by":
      return defaultNullableTextSortKey({
        direction,
        expr: sql`(
          SELECT ${user.name} FROM ${user}
          WHERE ${user.id} = ${entities.createdBy}
        )`,
      });
    case "_created-at":
      return timestampSortKey({ direction, expr: sql`${entities.createdAt}` });
    case "_updated-at":
      return timestampSortKey({
        direction,
        expr: sql`COALESCE(${entities.updatedAt}, ${LOW_TIMESTAMP_SENTINEL})`,
      });
    case "_status":
      return textSortKey({
        direction,
        expr: desc
          ? sql`COALESCE(${entities.status}, '')`
          : sql`COALESCE(${entities.status}, ${HIGH_TEXT_SENTINEL})`,
      });
    case "_priority":
      return textSortKey({
        direction,
        expr: desc
          ? sql`COALESCE(${entities.priority}, '')`
          : sql`COALESCE(${entities.priority}, ${HIGH_TEXT_SENTINEL})`,
      });
    case "_due-date":
      return dateSortKey({
        direction,
        expr: desc
          ? sql`COALESCE(${entities.dueDate}, ${LOW_DATE_SENTINEL})`
          : sql`COALESCE(${entities.dueDate}, ${HIGH_DATE_SENTINEL})`,
      });
    case "_version":
      return numberSortKey({
        direction,
        expr: sql`(
          SELECT COUNT(*) FROM ${entityVersions}
          WHERE ${entityVersions.entityId} = ${entities.id}
        )`,
      });
    case "_kind":
      return textSortKey({ direction, expr: sql`${entities.kind}` });
    default:
      return null;
  }
};

const buildViewSortKeys = (sorts: readonly ViewSort[]): EntitySortKey[] => {
  if (sorts.length === 0) {
    return [
      timestampSortKey({ direction: "asc", expr: sql`${entities.createdAt}` }),
    ];
  }

  const keys: EntitySortKey[] = [];
  for (const sort of sorts) {
    const internal = internalSortKey(sort);
    if (internal) {
      keys.push(internal);
      continue;
    }

    keys.push(
      legacyNullableTextSortKey({
        direction: sort.desc ? "desc" : "asc",
        expr: propertySortValueExpr(sort.propertyId),
      }),
    );
  }
  return keys;
};

const buildSearchSortKeys = (search: string | undefined): EntitySortKey[] => {
  const trimmed = search?.trim() ?? "";
  if (!trimmed) {
    return [];
  }

  const titleExpr = sql`(
    SELECT sd.title
    FROM ${searchDocuments} sd
    WHERE sd.entity_id = ${entities.id}
    LIMIT 1
  )`;
  const normalizedTitle = sql`lower(${titleExpr})`;
  const normalizedSearch = trimmed.toLowerCase();

  return [
    numberSortKey({
      direction: "asc",
      expr: sql`CASE
        WHEN ${normalizedTitle} = ${normalizedSearch} THEN 0
        WHEN ${normalizedTitle} LIKE ${`${normalizedSearch}%`} THEN 1
        WHEN ${normalizedTitle} LIKE ${`%${normalizedSearch}%`} THEN 2
        ELSE 3
      END`,
    }),
    numberSortKey({
      direction: "asc",
      expr: sql`strpos(${normalizedTitle}, ${normalizedSearch})`,
    }),
    numberSortKey({
      direction: "asc",
      expr: sql`length(${titleExpr})`,
    }),
  ];
};

const buildSortKeys = ({
  search,
  sorts,
}: {
  search?: string | undefined;
  sorts: readonly ViewSort[];
}): EntitySortKey[] => [
  ...buildSearchSortKeys(search),
  ...buildViewSortKeys(sorts),
  textSortKey({ direction: "asc", expr: sql`${entities.id}` }),
];

export const buildEntitySortExpressions = ({
  search,
  sorts,
}: {
  search?: string | undefined;
  sorts: readonly ViewSort[];
}): SQL[] => buildSortKeys({ search, sorts }).map(orderSortKey);

const parseCursorValue = (
  key: EntitySortKey,
  value: EntitiesWindowCursorValue,
): number | string | null => {
  switch (key.type) {
    case "string":
      return typeof value === "string" ? value : null;
    case "date":
      return typeof value === "string" && isValidDateCursorValue(value)
        ? value
        : null;
    case "number":
      return typeof value === "number" && Number.isFinite(value) ? value : null;
    case "timestamp": {
      if (typeof value !== "string") {
        return null;
      }
      return isValidTimestampCursorValue(value) ? value : null;
    }
  }

  return null;
};

const cursorValueSql = (key: EntitySortKey, value: number | string): SQL => {
  if (key.type === "timestamp") {
    return sql`${value}::timestamp`;
  }

  return sql`${value}`;
};

const invalidCursor = () =>
  new HandlerError({ status: 400, message: "Invalid cursor" });

const buildCursorCondition = ({
  cursor,
  sortKeys,
}: {
  cursor: EntitiesWindowCursorValues | null | undefined;
  sortKeys: readonly EntitySortKey[];
}): Result<SQL | null, HandlerError> => {
  if (!cursor) {
    return Result.ok(null);
  }

  if (cursor.length !== sortKeys.length) {
    return Result.err(invalidCursor());
  }

  const parsedValues = sortKeys.map((key, index) =>
    parseCursorValue(key, cursor[index] ?? null),
  );
  if (parsedValues.some((value) => value === null)) {
    return Result.err(invalidCursor());
  }

  const branches: SQL[] = [];
  for (let index = 0; index < sortKeys.length; index++) {
    const key = sortKeys[index];
    const value = parsedValues[index];
    if (!key || value === null || value === undefined) {
      return Result.err(invalidCursor());
    }

    const prefix: SQL[] = [];
    for (let prefixIndex = 0; prefixIndex < index; prefixIndex++) {
      const prefixKey = sortKeys[prefixIndex];
      const prefixValue = parsedValues[prefixIndex];
      if (!prefixKey || prefixValue === null || prefixValue === undefined) {
        return Result.err(invalidCursor());
      }
      prefix.push(
        sql`${prefixKey.expr} = ${cursorValueSql(prefixKey, prefixValue)}`,
      );
    }

    const comparison =
      key.direction === "asc"
        ? sql`${key.expr} > ${cursorValueSql(key, value)}`
        : sql`${key.expr} < ${cursorValueSql(key, value)}`;
    branches.push(and(...prefix, comparison) ?? comparison);
  }

  return Result.ok(or(...branches) ?? null);
};

const normalizeCursorValues = (
  rawValues: unknown,
): EntitiesWindowCursorValues => {
  if (Array.isArray(rawValues)) {
    return rawValues.filter(isGeneratedCursorValue);
  }

  if (typeof rawValues !== "string") {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawValues);
  } catch {
    return [];
  }

  return Array.isArray(parsed) ? parsed.filter(isGeneratedCursorValue) : [];
};

const isGeneratedCursorValue = (
  value: unknown,
): value is EntitiesWindowCursorValue =>
  value === null || typeof value === "string" || typeof value === "number";

const queryEntitiesGenerator = async function* ({
  safeDb,
  workspaceId,
  currentUserId,
  currentOrganizationId,
  filters,
  sorts,
  search,
  cursor,
  offset = 0,
  limit,
  fieldMode,
  fieldIds,
  excludedKinds = [],
  previewableForAi = false,
  extraConditions = [],
  includeTotalCount,
}: QueryEntitiesProps) {
  const workspaceCondition = eq(entities.workspaceId, workspaceId);
  const filterConditions = buildFilterConditions(filters);
  const searchConditions = buildSearchConditions({
    search,
    organizationId: currentOrganizationId,
    workspaceId,
  });
  const kindConditions =
    excludedKinds.length > 0 ? [notInArray(entities.kind, excludedKinds)] : [];
  const previewableConditions = previewableForAi
    ? [buildAIPreviewableEntityCondition()]
    : [];
  const whereClause = and(
    workspaceCondition,
    ...filterConditions,
    ...searchConditions,
    ...kindConditions,
    ...previewableConditions,
    ...extraConditions,
  );
  const sortKeys = buildSortKeys({ search, sorts });
  const cursorConditionResult = buildCursorCondition({ cursor, sortKeys });
  if (Result.isError(cursorConditionResult)) {
    return Result.err(cursorConditionResult.error);
  }
  const paginatedWhereClause =
    cursorConditionResult.value === null
      ? whereClause
      : and(whereClause, cursorConditionResult.value);
  const sortExpressions = sortKeys.map(orderSortKey);
  const cursorValuesExpr = sql<EntitiesWindowCursorValues>`jsonb_build_array(${sql.join(
    sortKeys.map((key) => key.cursorExpr),
    sql`, `,
  )})`;

  const countRowsPromise = includeTotalCount
    ? safeDb((tx) =>
        tx.select({ total: count() }).from(entities).where(whereClause),
      )
    : Promise.resolve(null);

  const [idRowsResult, countRowsResult] = await Promise.all([
    safeDb((tx) => {
      const query = tx
        .select({ cursorValues: cursorValuesExpr, id: entities.id })
        .from(entities)
        .where(paginatedWhereClause)
        .orderBy(...sortExpressions)
        .limit(limit);

      if (offset <= 0) {
        return query;
      }

      return query.offset(offset);
    }),
    countRowsPromise,
  ]);

  const idRows = yield* idRowsResult;

  let totalCount: number | null = null;
  if (countRowsResult !== null) {
    const countResult = yield* countRowsResult;
    totalCount = countResult.at(0)?.total ?? 0;
  }

  const pageIds = idRows.map((r) => r.id);
  const cursorValuesByEntityId = new Map<string, EntitiesWindowCursorValues>(
    idRows.map((row) => [row.id, normalizeCursorValues(row.cursorValues)]),
  );

  if (pageIds.length === 0) {
    return Result.ok({
      cursorValuesByEntityId,
      entities: [],
      totalCount,
    });
  }

  // Phase 2: Fetch entity metadata and the requested field payloads.
  const idFilter = inArray(entities.id, pageIds);

  const lastEditor = alias(user, "last_editor");
  const sessionEditor = alias(user, "session_editor");
  const fieldPredicates = [
    eq(fields.entityVersionId, entities.currentVersionId),
    idFilter,
  ];
  if (fieldMode === "visible") {
    const uniqueFieldIds = [...new Set(fieldIds)];
    const fileFieldCondition = sql`${fields.content}->>'type' = 'file'`;
    if (uniqueFieldIds.length === 0) {
      fieldPredicates.push(fileFieldCondition);
    } else {
      const visibleFieldCondition = or(
        fileFieldCondition,
        inArray(fields.propertyId, uniqueFieldIds),
      );
      if (visibleFieldCondition) {
        fieldPredicates.push(visibleFieldCondition);
      }
    }
  }
  const cellMetadataPredicates = buildCellMetadataPredicates({
    fieldIds,
    fieldMode,
    idFilter,
  });

  const [
    entityRowsResult,
    versionCountsResult,
    fieldRowsResult,
    cellMetadataRowsResult,
    activeSessionsResult,
  ] = await Promise.all([
    safeDb((tx) => {
      const createdByMembers = organizationMemberIdsSubquery(
        tx,
        currentOrganizationId,
        "created_by_members",
      );
      const lastEditorMembers = organizationMemberIdsSubquery(
        tx,
        currentOrganizationId,
        "last_editor_members",
      );

      return tx
        .select({
          id: entities.id,
          kind: entities.kind,
          name: entities.name,
          parentId: entities.parentId,
          currentVersionId: entities.currentVersionId,
          createdAt: entities.createdAt,
          updatedAt: entities.updatedAt,
          // Author display falls back to email when the user hasn't set
          // a display name (Better Auth's notNull `name` allows empty
          // strings, so passwordless email signups land with `name=''`).
          // Without this coalesce the Author column renders blank for
          // those users.
          createdByName: sql<
            string | null
          >`coalesce(nullif(trim(${user.name}), ''), ${user.email})`,
          createdByImage: user.image,
          lastEditedByName: sql<
            string | null
          >`coalesce(nullif(trim(${lastEditor.name}), ''), ${lastEditor.email})`,
          lastEditedByImage: lastEditor.image,
          status: entities.status,
          priority: entities.priority,
          dueDate: entities.dueDate,
          agendaKind: entities.agendaKind,
          startAt: entities.startAt,
          endAt: entities.endAt,
          occurredAt: entities.occurredAt,
          remindAt: entities.remindAt,
          allDay: entities.allDay,
          timeZone: entities.timeZone,
          location: entities.location,
          onlineMeetingUrl: entities.onlineMeetingUrl,
          availability: entities.availability,
          sensitivity: entities.sensitivity,
          organizer: entities.organizer,
          attendees: entities.attendees,
          recurrence: entities.recurrence,
          agendaSource: entities.agendaSource,
          externalSource: entities.externalSource,
          externalId: entities.externalId,
          externalChangeKey: entities.externalChangeKey,
          externalICalUid: entities.externalICalUid,
          readOnly: entities.readOnly,
          sortOrder: entities.sortOrder,
        })
        .from(entities)
        .leftJoin(
          createdByMembers,
          eq(entities.createdBy, createdByMembers.userId),
        )
        .leftJoin(user, eq(createdByMembers.userId, user.id))
        .leftJoin(
          lastEditorMembers,
          eq(entities.lastEditedBy, lastEditorMembers.userId),
        )
        .leftJoin(lastEditor, eq(lastEditorMembers.userId, lastEditor.id))
        .where(idFilter);
    }),
    safeDb((tx) =>
      tx
        .select({
          entityId: entityVersions.entityId,
          versionCount: count(),
        })
        .from(entityVersions)
        .where(inArray(entityVersions.entityId, pageIds))
        .groupBy(entityVersions.entityId),
    ),
    safeDb((tx) =>
      tx
        .select({
          entityVersionId: fields.entityVersionId,
          id: fields.id,
          propertyId: fields.propertyId,
          content: fields.content,
        })
        .from(fields)
        .innerJoin(entities, and(...fieldPredicates)),
    ),
    safeDb((tx) =>
      tx
        .select({
          entityVersionId: cellMetadata.entityVersionId,
          propertyId: cellMetadata.propertyId,
          metadata: cellMetadata.metadata,
        })
        .from(cellMetadata)
        .innerJoin(entities, and(...cellMetadataPredicates)),
    ),
    safeDb((tx) => {
      const sessionEditorMembers = organizationMemberIdsSubquery(
        tx,
        currentOrganizationId,
        "session_editor_members",
      );

      return tx
        .select({
          entityId: desktopEditSessions.entityId,
          createdBy: desktopEditSessions.createdBy,
          editorName: sessionEditor.name,
          editorImage: sessionEditor.image,
        })
        .from(desktopEditSessions)
        .innerJoin(
          sessionEditorMembers,
          eq(desktopEditSessions.createdBy, sessionEditorMembers.userId),
        )
        .innerJoin(
          sessionEditor,
          eq(sessionEditorMembers.userId, sessionEditor.id),
        )
        .where(
          and(
            inArray(desktopEditSessions.entityId, pageIds),
            eq(desktopEditSessions.status, "open"),
          ),
        )
        .orderBy(desktopEditSessions.createdAt);
    }),
  ]);

  const entityRows = yield* entityRowsResult;
  const versionCounts = yield* versionCountsResult;
  const fieldRows = yield* fieldRowsResult;
  const cellMetadataRows = yield* cellMetadataRowsResult;
  const activeSessions = yield* activeSessionsResult;
  const cellMetadataActorIds = getCellMetadataActorIds(cellMetadataRows);
  const cellMetadataActors =
    cellMetadataActorIds.length > 0
      ? yield* Result.await(
          safeDb((tx) => {
            const actorMembers = tx
              .select({ userId: member.userId })
              .from(member)
              .where(
                and(
                  eq(member.organizationId, currentOrganizationId),
                  inArray(member.userId, cellMetadataActorIds),
                ),
              )
              .groupBy(member.userId)
              .as("cell_metadata_actor_members");

            return tx
              .select({
                id: user.id,
                name: sql<
                  string | null
                >`coalesce(nullif(trim(${user.name}), ''), ${user.email})`,
                image: user.image,
              })
              .from(actorMembers)
              .innerJoin(user, eq(actorMembers.userId, user.id));
          }),
        )
      : [];
  const cellMetadataActorMap = new Map(
    cellMetadataActors.map((actor) => [actor.id, actor]),
  );

  const versionCountMap = new Map(
    versionCounts.map((v) => [v.entityId, v.versionCount]),
  );

  const activeEditMap = new Map<
    string,
    { name: string; image: string | null; isMe: boolean }
  >();
  for (const s of activeSessions) {
    if (!activeEditMap.has(s.entityId)) {
      activeEditMap.set(s.entityId, {
        name: s.editorName,
        image: s.editorImage,
        isMe: s.createdBy === currentUserId,
      });
    }
  }

  const fieldsByVersionId = groupByEntityVersionId(fieldRows);
  const cellMetadataByVersionId = groupByEntityVersionId(cellMetadataRows);

  const entityMap = new Map(entityRows.map((e) => [e.id, e]));

  const result: QueryEntityResult[] = [];
  for (const id of pageIds) {
    const entity = entityMap.get(id);
    if (!entity) {
      continue;
    }

    const versionId = entity.currentVersionId;
    if (!versionId) {
      panic("Entity has no currentVersion");
    }

    const entityFields = fieldsByVersionId.get(versionId) ?? [];
    const entityCellMetadata = cellMetadataByVersionId.get(versionId) ?? [];

    result.push({
      entityId: entity.id,
      kind: entity.kind,
      name: entity.name,
      parentId: entity.parentId,
      createdAt: entity.createdAt.toISOString(),
      createdBy: entity.lastEditedByName ?? entity.createdByName ?? null,
      createdByImage: entity.lastEditedByImage ?? entity.createdByImage ?? null,
      version: versionCountMap.get(entity.id) ?? 0,
      updatedAt: entity.updatedAt?.toISOString() ?? null,
      status: entity.status,
      priority: entity.priority,
      dueDate: entity.dueDate,
      agendaKind: entity.agendaKind ?? AGENDA_ITEM_KIND.TASK,
      startAt: entity.startAt?.toISOString() ?? null,
      endAt: entity.endAt?.toISOString() ?? null,
      occurredAt: entity.occurredAt?.toISOString() ?? null,
      remindAt: entity.remindAt?.toISOString() ?? null,
      allDay: entity.allDay,
      timeZone: entity.timeZone,
      location: entity.location,
      onlineMeetingUrl: entity.onlineMeetingUrl,
      availability: entity.availability,
      sensitivity: entity.sensitivity,
      organizer: entity.organizer,
      attendees: entity.attendees,
      recurrence: entity.recurrence,
      agendaSource: entity.agendaSource ?? AGENDA_ITEM_SOURCE.MANUAL,
      externalSource: entity.externalSource,
      externalId: entity.externalId,
      externalChangeKey: entity.externalChangeKey,
      externalICalUid: entity.externalICalUid,
      readOnly: entity.readOnly,
      sortOrder: entity.sortOrder,
      activeEditBy: activeEditMap.get(entity.id) ?? null,
      fields: entityFields.map((field) => ({
        id: field.id,
        propertyId: field.propertyId,
        entityId: entity.id,
        content: field.content,
      })),
      cellMetadata: entityCellMetadata.map((entry) => ({
        propertyId: entry.propertyId,
        metadata: enrichCellMetadata(entry.metadata, cellMetadataActorMap),
      })),
    });
  }

  return Result.ok({
    cursorValuesByEntityId,
    entities: result,
    totalCount,
  });
};

const buildSearchConditions = ({
  search,
  organizationId,
  workspaceId,
}: {
  search?: string | undefined;
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
}): SQL[] => {
  const trimmed = search?.trim() ?? "";
  if (!trimmed) {
    return [];
  }

  return [
    sql`EXISTS (
      SELECT 1 FROM ${searchDocuments} sd
      WHERE sd.entity_id = ${entities.id}
        AND sd.organization_id = ${organizationId}
        AND sd.workspace_id = ${workspaceId}
        AND sd.title ILIKE ${`%${trimmed}%`}
    )`,
  ];
};

const buildAIPreviewableEntityCondition = (): SQL => sql`EXISTS (
    SELECT 1
    FROM ${fields}
    WHERE ${fields.entityVersionId} = ${entities.currentVersionId}
      AND ${fields.content}->>'type' = 'file'
      AND (
        ${fields.content}->>'mimeType' = ${PDF_MIME_TYPE}
        OR ${fields.content}->>'pdfFileId' IS NOT NULL
      )
  )`;

export const queryEntities = async (props: QueryEntitiesProps) =>
  await Result.gen(() => queryEntitiesGenerator(props));
