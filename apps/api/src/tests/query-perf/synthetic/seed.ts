import { panic } from "better-result";
import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import * as v from "valibot";

import { ENTITY_KINDS } from "@stll/api-contract";
import type { EntityKind } from "@stll/api-contract";
import {
  ENTITY_PRIORITIES,
  LIST_ITEM_TYPES,
  TASK_STATUSES,
} from "@stll/api-contract/entity-options";

import { LEGAL_LIST_ITEM_REVIEW_STATUSES } from "@/api/db/schema";
import { createMembershipScopedDb, markRlsDatabase } from "@/api/db/scoped";
import { toSafeId } from "@/api/lib/branded-types";
import { executedRows } from "@/api/lib/db/executed-rows";
import { TASK_ASSIGNEE_ROLES } from "@/api/lib/entity-constants";
import { LIMITS } from "@/api/lib/limits";
import { isoToRegconfig } from "@/api/lib/search/detect-language";
import { buildDocumentSearchQueries } from "@/api/lib/search/pg-fts-search-query";
import { sqlCaseFragment } from "@/api/lib/sql-case-expression";
import type { GatedTestDb } from "@/api/tests/gated-test-database";

import { QUERY_PERF_PROFILES, queryPerfDatabaseName } from "../profiles";
import { allocateRelatedRows } from "./allocate-related";
import {
  aggregateProfileSchema,
  apportion,
  allocateWorkspaceRows,
  createColumnSlots,
  createSeededRandom,
  HOT_TABLES,
  SYNTHETIC_LANGUAGES,
} from "./profile";
import type { SyntheticProfile } from "./profile";
import { SYNTHETIC_TABLES } from "./tables";
import { allocateTaskQuotas } from "./task-quota";

const DOCUMENT_KIND = "document" satisfies EntityKind;
const TASK_KIND = "task" satisfies EntityKind;
const NON_TASK_KINDS = [
  DOCUMENT_KIND,
  ...ENTITY_KINDS.filter(
    (kind) => kind !== DOCUMENT_KIND && kind !== TASK_KIND,
  ),
];

const FIXTURE_ORG = "query-perf-synthetic-org";
const FIXTURE_USER = "query-perf-synthetic-user";
const FIXTURE_EPOCH = "2025-01-01T00:00:00Z";
const PROPERTY_COUNT = 8;

// SQL rows and column permutations use the same deterministic namespace.
const fixtureId = (kind: string, workspace: number, ordinal = 1) =>
  new Bun.CryptoHasher("md5")
    .update(`${kind}:${workspace}:${ordinal}`)
    .digest("hex");

type ColumnSlotOptions = {
  profile: SyntheticProfile;
  table: (typeof HOT_TABLES)[number];
  column: string;
};

const columnSlotExpression = ({
  profile,
  table,
  column,
}: ColumnSlotOptions) => {
  if (profile.tables[table].rowCount === 0) {
    return { distinctCount: 0, slot: sql`NULL::bigint` };
  }
  const stats = profile.tables[table].columns[column];
  if (!stats) {
    panic(`Missing synthetic column statistics: ${table}.${column}`);
  }
  const distribution = createColumnSlots({
    stats,
    rowCount: profile.tables[table].rowCount,
    random: createSeededRandom(
      (profile.seed +
        Number.parseInt(fixtureId(`${table}.${column}`, 0).slice(0, 8), 16)) %
        0x1_00_00_00_00,
    ),
  });
  const position = sql`mod((row_no - 1)::bigint * ${distribution.multiplier}::bigint + ${distribution.offset}::bigint, ${profile.tables[table].rowCount}::bigint)`;
  const cases: SQL[] = [
    sql`WHEN ${position} < ${distribution.nullCount} THEN NULL`,
  ];
  let boundary = distribution.nullCount;
  for (const [index, count] of distribution.mcvCounts.entries()) {
    boundary += count;
    cases.push(sql`WHEN ${position} < ${boundary} THEN ${index}::bigint`);
  }
  const tailCount = distribution.distinctCount - distribution.mcvCounts.length;
  return {
    distinctCount: distribution.distinctCount,
    slot:
      tailCount === 0
        ? sqlCaseFragment({ branches: cases, fallback: sql`NULL::bigint` })
        : sqlCaseFragment({
            branches: cases,
            fallback: sql`${distribution.mcvCounts.length} + mod(${position} - ${boundary}, ${tailCount})`,
          }),
  };
};

type ColumnExpressionOptions = ColumnSlotOptions & { values: readonly SQL[] };
const columnExpression = ({ values, ...options }: ColumnExpressionOptions) => {
  const { slot, distinctCount } = columnSlotExpression(options);
  if (distinctCount > values.length) {
    panic(`Synthetic domain is too small: ${options.table}.${options.column}`);
  }
  return sql`(ARRAY[${sql.join(values, sql`, `)}])[1 + (${slot})::int]`;
};

const timestampExpression = (options: ColumnSlotOptions) => {
  const { slot } = columnSlotExpression(options);
  return sql`${FIXTURE_EPOCH}::timestamptz + (${slot}) * interval '1 second'`;
};

const assertFixtureDatabase = async (db: GatedTestDb) => {
  const database = (
    await db.execute<{ name: string }>(sql`SELECT current_database() AS name`)
  ).at(0);
  if (
    !QUERY_PERF_PROFILES.some(
      (profileId) => database?.name === queryPerfDatabaseName(profileId),
    )
  ) {
    panic(
      "Synthetic fixtures require a dedicated query performance profile database",
    );
  }
};

/** Owns data only; the perf harness owns authorization and measurement sessions. */
export const seedProdShaped = async (
  db: GatedTestDb,
  input: SyntheticProfile,
) => {
  const profile = v.parse(aggregateProfileSchema, input);
  const started = performance.now();
  await assertFixtureDatabase(db);
  const allocations = Object.fromEntries(
    HOT_TABLES.map((table) => [
      table,
      allocateWorkspaceRows({
        histogram: profile.tables[table].workspaceHistogram,
        rowCount: profile.tables[table].rowCount,
        random: createSeededRandom(profile.seed),
      }).toSorted((a, b) => b - a),
    ]),
  );
  const entityCounts =
    allocations["entities"] ?? panic("Missing entity allocation");
  // Marginal histograms cannot describe FK correlations; project children into parent capacity.
  type AlignOptions = {
    table: (typeof HOT_TABLES)[number];
    minimum: number[];
    maximum: number[];
  };
  const align = ({ table, minimum, maximum }: AlignOptions) => {
    allocations[table] = allocateRelatedRows({
      desired: allocations[table] ?? panic("Missing table allocation"),
      minimum,
      maximum,
    });
  };
  const zeroCounts = entityCounts.map(() => 0);
  align({
    table: "entity_versions",
    minimum: entityCounts,
    maximum: entityCounts.map((count) =>
      count === 0 ? 0 : profile.tables.entity_versions.rowCount,
    ),
  });
  const versionCounts =
    allocations["entity_versions"] ?? panic("Missing version allocation");
  align({
    table: "fields",
    minimum: zeroCounts,
    maximum: versionCounts.map((count) => count * PROPERTY_COUNT),
  });
  for (const table of [
    "search_documents",
    "extracted_content",
    "legal_list_items",
    "task_assignees",
  ] as const) {
    align({ table, minimum: zeroCounts, maximum: entityCounts });
  }
  const listRandom = createSeededRandom(
    (profile.seed + 0x11_57) % 0x1_00_00_00_00,
  );
  const listConfig = profile.legalLists;
  const usingWorkspaces =
    listConfig.source === "observed" ? 0 : listConfig.usingWorkspaceCount;
  if (usingWorkspaces > entityCounts.filter((count) => count > 0).length) {
    panic(
      "Assumed list workspace population exceeds populated entity workspaces",
    );
  }
  const listCounts = entityCounts.map((_, index) =>
    index >= usingWorkspaces || listConfig.source === "observed"
      ? 0
      : listConfig.listsPerWorkspace.min +
        Math.floor(
          listRandom() *
            (listConfig.listsPerWorkspace.max -
              listConfig.listsPerWorkspace.min +
              1),
        ),
  );
  const lists = listCounts.flatMap((count, index) =>
    Array.from({ length: count }, (_, ordinal) => ({
      ws: index + 1,
      list_no: ordinal + 1,
      sections:
        listConfig.source === "observed"
          ? 0
          : listConfig.sectionsPerList.min +
            Math.floor(
              listRandom() *
                (listConfig.sectionsPerList.max -
                  listConfig.sectionsPerList.min +
                  1),
            ),
    })),
  );
  const listWeights = entityCounts.map((count, index) =>
    index < usingWorkspaces ? count : 0,
  );
  if (profile.tables.legal_list_items.rowCount > 0 && usingWorkspaces === 0) {
    panic("Populated list items require assumed lists");
  }
  allocations["legal_list_items"] = allocateRelatedRows({
    desired: apportion(listWeights, profile.tables.legal_list_items.rowCount),
    minimum: zeroCounts,
    maximum: listWeights,
  });
  const kindStats =
    profile.tables.entities.columns["kind"] ?? panic("Missing kind statistics");
  const kindSlots = createColumnSlots({
    stats: kindStats,
    rowCount: profile.tables.entities.rowCount,
    random: createSeededRandom(profile.seed),
  });
  if (kindSlots.nullCount !== 0 || kindSlots.mcvCounts.length < 2) {
    panic("Synthetic kinds require non-null document and task MCV slots");
  }
  const taskCount =
    kindSlots.mcvCounts.at(1) ?? panic("Missing task kind frequency");
  const taskQuotas = allocateTaskQuotas({
    entityCounts,
    itemCounts:
      allocations["legal_list_items"] ?? panic("Missing item allocation"),
    assigneeCounts:
      allocations["task_assignees"] ?? panic("Missing assignee allocation"),
    taskCount,
  });
  let precedingTasks = 0;
  const taskPrefixes = taskQuotas.map((quota) => {
    const prefix = precedingTasks;
    precedingTasks += quota;
    return prefix;
  });
  const taskQuota = sql`(${JSON.stringify(taskQuotas)}::text::jsonb->>(ws-1))::int`;
  const taskPrefix = sql`(${JSON.stringify(taskPrefixes)}::text::jsonb->>(ws-1))::int`;
  const nonTaskCount = profile.tables.entities.rowCount - taskCount;
  if (nonTaskCount === 0) {
    panic("Synthetic entity kinds require non-task rows");
  }
  const nonTaskProfile = {
    ...profile,
    tables: {
      ...profile.tables,
      entities: {
        ...profile.tables.entities,
        rowCount: nonTaskCount,
        columns: {
          ...profile.tables.entities.columns,
          kind: {
            ...kindStats,
            n_distinct: kindSlots.distinctCount - 1,
            most_common_freqs: kindSlots.mcvCounts
              .filter((_, index) => index !== 1)
              .map((count) => count / nonTaskCount),
          },
        },
      },
    },
  };
  const nonTaskKind = columnExpression({
    profile: nonTaskProfile,
    table: "entities",
    column: "kind",
    values: NON_TASK_KINDS.map((value) => sql`${value}::text`),
  });
  // Compress the global row ordinal after reserving task rows in each workspace.
  const kind = sql`CASE WHEN n <= ${taskQuota} THEN ${TASK_KIND}::text ELSE (SELECT ${nonTaskKind} FROM (SELECT row_no - ${taskPrefix} - ${taskQuota} AS row_no) AS non_task) END`;
  const status = columnExpression({
    profile,
    table: "entities",
    column: "status",
    values: TASK_STATUSES.map((value) => sql`${value}::text`),
  });
  const priority = columnExpression({
    profile,
    table: "entities",
    column: "priority",
    values: ENTITY_PRIORITIES.map((value) => sql`${value}::text`),
  });
  const review = columnExpression({
    profile,
    table: "legal_list_items",
    column: "review_status",
    values: LEGAL_LIST_ITEM_REVIEW_STATUSES.map((value) => sql`${value}::text`),
  });

  const { slot: dueDateSlot } = columnSlotExpression({
    profile,
    table: "entities",
    column: "due_date",
  });
  const dueDate = sql`${FIXTURE_EPOCH.slice(0, 10)}::date + (${dueDateSlot})::int`;
  const createdAt = timestampExpression({
    profile,
    table: "entities",
    column: "created_at",
  });
  const updatedAt = timestampExpression({
    profile,
    table: "entities",
    column: "updated_at",
  });
  const deletedStats =
    profile.tables.entity_versions.columns["deleted_at"] ??
    panic("Missing deleted_at statistics");
  const historicalCount =
    profile.tables.entity_versions.rowCount - profile.tables.entities.rowCount;
  const deletedCount = Math.round(
    profile.tables.entity_versions.rowCount * (1 - deletedStats.null_frac),
  );
  if (deletedCount > historicalCount) {
    panic("Deleted versions exceed historical version capacity");
  }
  let precedingEntities = 0;
  const entityPrefixes = entityCounts.map((count) => {
    const prefix = precedingEntities;
    precedingEntities += count;
    return prefix;
  });
  const entityPrefix = sql`(${JSON.stringify(entityPrefixes)}::text::jsonb->>(r.ws-1))::int`;
  const firstVersionCount = sql`(counts->>'entities')::int`;
  const historicalProfile = {
    ...profile,
    tables: {
      ...profile.tables,
      entity_versions: {
        ...profile.tables.entity_versions,
        rowCount: historicalCount,
        columns: {
          ...profile.tables.entity_versions.columns,
          deleted_at: {
            ...deletedStats,
            null_frac:
              historicalCount === 0 ? 1 : 1 - deletedCount / historicalCount,
            n_distinct:
              deletedStats.n_distinct < 0
                ? Math.round(
                    -deletedStats.n_distinct *
                      profile.tables.entity_versions.rowCount,
                  )
                : deletedStats.n_distinct,
            most_common_freqs: deletedStats.most_common_freqs.map(
              (frequency) =>
                (frequency * profile.tables.entity_versions.rowCount) /
                Math.max(1, historicalCount),
            ),
          },
        },
      },
    },
  };
  const historicalDeletedAt =
    historicalCount === 0
      ? sql`NULL::timestamptz`
      : timestampExpression({
          profile: historicalProfile,
          table: "entity_versions",
          column: "deleted_at",
        });
  const deletedAt = sql`CASE WHEN n <= ${firstVersionCount} THEN NULL::timestamptz ELSE (SELECT ${historicalDeletedAt} FROM (SELECT row_no - ${entityPrefix} - ${firstVersionCount} AS row_no) historical) END`;
  const parentSlot = columnSlotExpression({
    profile,
    table: "entities",
    column: "parent_id",
  }).slot;
  const versionCreatedAt = timestampExpression({
    profile,
    table: "entity_versions",
    column: "created_at",
  });
  const itemCreatedAt = timestampExpression({
    profile,
    table: "legal_list_items",
    column: "created_at",
  });
  const assigneeCreatedAt = timestampExpression({
    profile,
    table: "task_assignees",
    column: "created_at",
  });
  const fieldSlot = columnSlotExpression({
    profile,
    table: "fields",
    column: "content",
  }).slot;
  const fieldWidth = Math.max(
    16,
    Math.round(
      profile.tables.fields.columns["content"]?.avg_width ??
        (profile.tables.fields.rowCount === 0
          ? 0
          : panic("Missing content width")),
    ) - 40,
  );
  const searchLanguage = columnExpression({
    profile,
    table: "search_documents",
    column: "language",
    values: SYNTHETIC_LANGUAGES.map(
      (value) => sql`${isoToRegconfig(value)}::text`,
    ),
  });
  const extractedLanguage = columnExpression({
    profile,
    table: "extracted_content",
    column: "language",
    values: SYNTHETIC_LANGUAGES.map((value) => sql`${value}::text`),
  });
  const searchUpdatedAt = timestampExpression({
    profile,
    table: "search_documents",
    column: "updated_at",
  });
  const extractedAt = timestampExpression({
    profile,
    table: "extracted_content",
    column: "extracted_at",
  });
  const role = columnExpression({
    profile,
    table: "task_assignees",
    column: "role",
    values: TASK_ASSIGNEE_ROLES.map((value) => sql`${value}::text`),
  });
  const searchWidth = Math.max(
    32,
    Math.round(profile.tables.search_documents.averageRowWidth) - 120,
  );
  const extractedWidth = Math.max(
    16,
    Math.round(profile.tables.extracted_content.averageRowWidth) - 120,
  );

  await db.transaction(async (tx) => {
    const populated = await tx.execute(
      sql`${sql.join(
        SYNTHETIC_TABLES.map(
          (table) =>
            sql`SELECT ${table}::text AS table_name WHERE EXISTS (SELECT 1 FROM ${sql.identifier(table)} LIMIT 1)`,
        ),
        sql` UNION ALL `,
      )}`,
    );
    if (populated.length > 0) {
      panic("Synthetic perf seed requires empty fixture tables");
    }
    await tx.execute(
      sql`CREATE TEMP TABLE perf_workspaces (ws integer PRIMARY KEY, counts jsonb NOT NULL) ON COMMIT DROP`,
    );
    const workspaces = entityCounts.map((_, ws) => ({
      ws: ws + 1,
      counts: Object.fromEntries(
        HOT_TABLES.map((table) => [
          table,
          allocations[table]?.at(ws) ?? panic("Missing workspace allocation"),
        ]),
      ),
    }));
    await tx.execute(
      sql`INSERT INTO perf_workspaces SELECT ws, counts FROM jsonb_to_recordset(${JSON.stringify(workspaces)}::text::jsonb) AS x(ws integer, counts jsonb)`,
    );
    await tx.execute(
      sql`CREATE TEMP TABLE perf_rows (ws integer, n integer, row_no bigint) ON COMMIT DROP`,
    );
    const rowsFor = async (table: (typeof HOT_TABLES)[number]) => {
      await tx.execute(sql`TRUNCATE perf_rows`);
      await tx.execute(
        sql`INSERT INTO perf_rows SELECT ws, n, row_number() OVER (ORDER BY ws, n) FROM perf_workspaces CROSS JOIN LATERAL generate_series(1, (counts->>${table})::int) AS g(n)`,
      );
    };
    await tx.execute(
      sql`INSERT INTO organization (id,name,slug,created_at) VALUES (${FIXTURE_ORG},'Synthetic measurements',${FIXTURE_ORG},${FIXTURE_EPOCH}::timestamptz)`,
    );
    await tx.execute(
      sql`INSERT INTO "user" (id,name,email,created_at,updated_at) VALUES (${FIXTURE_USER},'Synthetic user','query-perf@example.invalid',${FIXTURE_EPOCH}::timestamptz,${FIXTURE_EPOCH}::timestamptz)`,
    );
    await tx.execute(
      sql`INSERT INTO member (id,organization_id,user_id,role,created_at) VALUES ('query-perf-member',${FIXTURE_ORG},${FIXTURE_USER},'member',${FIXTURE_EPOCH}::timestamptz)`,
    );
    await tx.execute(
      sql`INSERT INTO workspaces (id,organization_id,name,reference,created_at,last_activity_at) SELECT md5('workspace:'||ws||':1')::uuid,${FIXTURE_ORG},'Synthetic matter '||ws,'synthetic-'||ws,${FIXTURE_EPOCH}::timestamptz,${FIXTURE_EPOCH}::timestamptz FROM perf_workspaces`,
    );
    await tx.execute(
      sql`INSERT INTO workspace_members (id,workspace_id,user_id,created_at) SELECT md5('membership:'||ws||':1')::uuid,md5('workspace:'||ws||':1')::uuid,${FIXTURE_USER},${FIXTURE_EPOCH}::timestamptz FROM perf_workspaces`,
    );
    await tx.execute(
      sql`INSERT INTO properties (id,workspace_id,name,status,content,tool,created_at) SELECT md5('property:'||ws||':'||n)::uuid,md5('workspace:'||ws||':1')::uuid,'Synthetic property '||n,'fresh','{"version":1,"type":"text"}'::jsonb,'{"version":1,"type":"manual-input"}'::jsonb,${FIXTURE_EPOCH}::timestamptz FROM perf_workspaces CROSS JOIN generate_series(1,${PROPERTY_COUNT}) AS g(n)`,
    );
    await tx.execute(
      sql`CREATE TEMP TABLE perf_lists (ws integer,list_no integer,sections integer) ON COMMIT DROP`,
    );
    await tx.execute(
      sql`INSERT INTO perf_lists SELECT ws,list_no,sections FROM jsonb_to_recordset(${JSON.stringify(lists)}::text::jsonb) AS x(ws integer,list_no integer,sections integer)`,
    );
    await tx.execute(sql`INSERT INTO legal_lists (id,workspace_id,name,description,created_by,created_at,updated_at)
      SELECT md5('list:'||ws||':'||list_no)::uuid,md5('workspace:'||ws||':1')::uuid,rpad('Synthetic list '||list_no,24,' synthetic'),CASE WHEN mod(list_no,2)=0 THEN NULL ELSE rpad('Synthetic description',24,' synthetic') END,CASE WHEN mod(list_no,2)=0 THEN NULL ELSE ${FIXTURE_USER} END,${FIXTURE_EPOCH}::timestamptz,${FIXTURE_EPOCH}::timestamptz FROM perf_lists`);
    await tx.execute(sql`INSERT INTO legal_list_sections (id,workspace_id,list_id,name,position,created_at,updated_at)
      SELECT md5('section:'||ws||':'||list_no||':'||section_no)::uuid,md5('workspace:'||ws||':1')::uuid,md5('list:'||ws||':'||list_no)::uuid,rpad('Synthetic section '||section_no,24,' synthetic'),(section_no-1)::text,${FIXTURE_EPOCH}::timestamptz,${FIXTURE_EPOCH}::timestamptz FROM perf_lists CROSS JOIN LATERAL generate_series(1,sections) g(section_no)`);
    await rowsFor("entities");
    await tx.execute(sql`INSERT INTO entities (id,workspace_id,kind,name,display_name,status,priority,due_date,created_at,updated_at)
      SELECT md5('entity:'||ws||':'||n)::uuid,md5('workspace:'||ws||':1')::uuid,${kind},'Synthetic document '||n,'Synthetic document '||n,${status},${priority},${dueDate},${createdAt},${updatedAt} FROM perf_rows`);
    await tx.execute(
      sql`UPDATE entities e SET parent_id = CASE WHEN n = 1 OR (${parentSlot}) IS NULL THEN NULL ELSE md5('entity:'||ws||':'||(1+mod((${parentSlot}), n-1)))::uuid END FROM perf_rows r WHERE e.id=md5('entity:'||ws||':'||n)::uuid`,
    );
    await rowsFor("entity_versions");
    await tx.execute(sql`INSERT INTO entity_versions (id,workspace_id,entity_id,version_number,created_at,deleted_at)
      SELECT md5('version:'||r.ws||':'||n)::uuid,md5('workspace:'||r.ws||':1')::uuid,md5('entity:'||r.ws||':'||(1+mod(n-1,(counts->>'entities')::int)))::uuid,1+(n-1)/(counts->>'entities')::int,${versionCreatedAt},${deletedAt} FROM perf_rows r JOIN perf_workspaces w ON w.ws=r.ws`);
    await tx.execute(
      sql`UPDATE entities e SET current_version_id=v.id FROM entity_versions v WHERE v.entity_id=e.id AND v.version_number=1`,
    );
    await rowsFor("fields");
    await tx.execute(sql`INSERT INTO fields (id,workspace_id,property_id,entity_version_id,content)
      SELECT md5('field:'||r.ws||':'||n)::uuid,md5('workspace:'||r.ws||':1')::uuid,md5('property:'||r.ws||':'||(1+(n-1)/(counts->>'entity_versions')::int))::uuid,md5('version:'||r.ws||':'||(1+mod(n-1,(counts->>'entity_versions')::int)))::uuid,jsonb_build_object('version',1,'type','text','value',rpad('Synthetic clause '||(${fieldSlot})::text,${fieldWidth},' synthetic')) FROM perf_rows r JOIN perf_workspaces w ON w.ws=r.ws`);
    await rowsFor("search_documents");
    await tx.execute(sql`INSERT INTO search_documents (entity_id,organization_id,workspace_id,kind,title,searchable_text,language,tsv,updated_at)
      SELECT e.id,${FIXTURE_ORG},e.workspace_id,e.kind,e.display_name,rpad('synthetic contract clause '||mod(r.n,1000),${searchWidth},' synthetic'),${searchLanguage},to_tsvector(coalesce(${searchLanguage},${isoToRegconfig(null)})::regconfig,'synthetic contract clause '||mod(r.n,1000)),GREATEST(${searchUpdatedAt},ev.created_at) FROM perf_rows r JOIN entities e ON e.id=md5('entity:'||ws||':'||n)::uuid JOIN entity_versions ev ON ev.id=e.current_version_id`);
    await rowsFor("extracted_content");
    await tx.execute(sql`INSERT INTO extracted_content (entity_id,organization_id,workspace_id,source_entity_version_id,ciphertext,iv,char_count,language,extracted_at)
      SELECT e.id,${FIXTURE_ORG},e.workspace_id,e.current_version_id,decode((SELECT string_agg(md5(${profile.seed}::text||':'||ws||':'||n||':'||b),'') FROM generate_series(1,${Math.ceil(extractedWidth / 16)}) g(b)),'hex'),decode(repeat('00',12),'hex'),${extractedWidth},${extractedLanguage},${extractedAt} FROM perf_rows r JOIN entities e ON e.id=md5('entity:'||ws||':'||n)::uuid`);
    await rowsFor("legal_list_items");
    const itemType = sql`(ARRAY[${sql.join(
      LIST_ITEM_TYPES.map((value) => sql`${value}::text`),
      sql`, `,
    )}])[1+mod(r.n-1,${LIST_ITEM_TYPES.length})]`;
    await tx.execute(
      sql`UPDATE entities e SET list_item_type=${itemType} FROM perf_rows r WHERE e.id=md5('entity:'||r.ws||':'||r.n)::uuid AND e.kind=${TASK_KIND}`,
    );
    // Keep section choice independent of the alternating nullable-column pattern.
    const itemSection = sql`1 + mod(('x' || substr(md5(${profile.seed}::text || ':section:' || r.ws || ':' || r.n), 1, 8))::bit(32)::bigint, l.sections)`;
    await tx.execute(sql`INSERT INTO legal_list_items (entity_id,workspace_id,list_id,section_id,position,description,review_status,added_by,created_at,updated_at)
      SELECT e.id,e.workspace_id,md5('list:'||r.ws||':'||l.list_no)::uuid,CASE WHEN mod(r.n,2)=0 THEN NULL ELSE md5('section:'||r.ws||':'||l.list_no||':'||(${itemSection}))::uuid END,((r.n-1)/lc.list_count)::text,CASE WHEN mod(r.n,2)=0 THEN NULL ELSE rpad('Synthetic item',24,' synthetic') END,${review},CASE WHEN mod(r.n,2)=0 THEN NULL ELSE ${FIXTURE_USER} END,${itemCreatedAt},${itemCreatedAt}
      FROM perf_rows r JOIN entities e ON e.id=md5('entity:'||r.ws||':'||r.n)::uuid AND e.kind=${TASK_KIND}
      JOIN (SELECT ws,count(*)::int AS list_count FROM perf_lists GROUP BY ws) lc ON lc.ws=r.ws
      JOIN perf_lists l ON l.ws=r.ws AND l.list_no=1+mod(r.n-1,lc.list_count)`);
    await rowsFor("task_assignees");
    await tx.execute(sql`INSERT INTO task_assignees (id,workspace_id,entity_id,user_id,role,created_at)
      SELECT md5('assignee:'||ws||':'||n)::uuid,e.workspace_id,e.id,${FIXTURE_USER},${role},${assigneeCreatedAt} FROM perf_rows r JOIN entities e ON e.id=md5('entity:'||ws||':'||n)::uuid AND e.kind=${TASK_KIND}`);
  });
  await db.execute(
    sql`ANALYZE ${sql.join(
      SYNTHETIC_TABLES.map((table) => sql.identifier(table)),
      sql`, `,
    )}`,
  );
  return {
    ...(await readSeededProfile(db, profile)),
    seedMilliseconds: performance.now() - started,
  };
};

/** Reads restored fixtures through the same membership scope as the measured caller. */
export const readSeededProfile = async (
  db: GatedTestDb,
  input: SyntheticProfile,
) => {
  const profile = v.parse(aggregateProfileSchema, input);
  await assertFixtureDatabase(db);
  const countSchema = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
  const identities = v.parse(
    v.array(
      v.strictObject({
        organization_id: v.string(),
        user_id: v.string(),
      }),
    ),
    executedRows(
      await db.execute(sql`
    SELECT o.id AS organization_id, u.id AS user_id
    FROM organization o JOIN member m ON m.organization_id=o.id
    JOIN "user" u ON u.id=m.user_id
    WHERE o.id=${FIXTURE_ORG} AND u.id=${FIXTURE_USER} AND m.role='member'
  `),
    ),
  );
  if (identities.length !== 1) {
    panic("Synthetic fixture requires one measured member");
  }
  const identity = identities.at(0) ?? panic("Missing synthetic identity");
  const organizationId = toSafeId<"organization">(identity.organization_id);
  const userId = toSafeId<"user">(identity.user_id);
  const workspaces = v.parse(
    v.array(
      v.strictObject({
        id: v.string(),
        entity_count: countSchema,
      }),
    ),
    executedRows(
      await db.execute(sql`
    SELECT w.id, count(e.id)::int AS entity_count
    FROM workspaces w LEFT JOIN entities e ON e.workspace_id=w.id
    WHERE w.organization_id=${organizationId}
    GROUP BY w.id ORDER BY count(e.id) DESC, w.id ASC
  `),
    ),
  );
  const expectedWorkspaceCount = Object.values(
    profile.tables.entities.workspaceHistogram,
  ).reduce((sum, count) => sum + count, 0);
  if (workspaces.length !== expectedWorkspaceCount) {
    panic("Synthetic workspace population does not match the profile");
  }
  const populated = workspaces.filter(({ entity_count }) => entity_count > 0);
  const big =
    populated.at(0) ?? panic("Synthetic fixture has no populated workspace");
  const median =
    populated.at(Math.floor((populated.length - 1) / 2)) ??
    panic("Missing synthetic median workspace");
  const bigWorkspaceId = toSafeId<"workspace">(big.id);
  const medianWorkspaceId = toSafeId<"workspace">(median.id);
  const countedTables = [
    ...HOT_TABLES,
    "legal_lists",
    "legal_list_sections",
  ] as const;
  const tableCounts = v.parse(
    v.array(
      v.strictObject({
        table_name: v.picklist(countedTables),
        row_count: countSchema,
      }),
    ),
    executedRows(
      await db.execute(
        sql`${sql.join(
          countedTables.map(
            (table) =>
              sql`SELECT ${table}::text AS table_name, count(*)::int AS row_count FROM ${sql.identifier(table)}`,
          ),
          sql` UNION ALL `,
        )}`,
      ),
    ),
  );
  const rowCounts = Object.fromEntries(
    tableCounts.map(({ table_name, row_count }) => [table_name, row_count]),
  );
  for (const table of HOT_TABLES) {
    if (rowCounts[table] !== profile.tables[table].rowCount) {
      panic("Synthetic row population does not match the profile");
    }
  }
  const scopedDb = createMembershipScopedDb(markRlsDatabase(db), {
    organizationId,
    userId,
    serverValidatedWorkspaceIds: [],
  });
  const searchInput = {
    query: "contract",
    organizationId,
    workspaceIds: [bigWorkspaceId],
    limit: LIMITS.mcpSearchPageSizeDefault,
  };
  const countQuery = buildDocumentSearchQueries(searchInput).countQuery;
  const documentCountQuery = buildDocumentSearchQueries({
    ...searchInput,
    kinds: [DOCUMENT_KIND],
  }).countQuery;
  const searchCounts = await scopedDb(async (tx) => {
    const resultSchema = v.strictObject({ total: countSchema });
    const visible = v.parse(
      resultSchema,
      executedRows(await tx.execute(countQuery)).at(0),
    );
    const documents = v.parse(
      resultSchema,
      executedRows(await tx.execute(documentCountQuery)).at(0),
    );
    if (visible.total <= searchInput.limit) {
      panic("Synthetic search fixture must fill a default search page");
    }
    return { visible: visible.total, documents: documents.total };
  });
  return {
    organizationId,
    userId,
    workspaceIds: workspaces.map(({ id }) => toSafeId<"workspace">(id)),
    bigWorkspaceId,
    medianWorkspaceId,
    query: searchInput.query,
    documentMatchCount: searchCounts.documents,
    searchMatchCount: searchCounts.visible,
    rowCounts,
  };
};
