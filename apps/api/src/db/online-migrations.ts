import { panic } from "better-result";

import {
  REWRITTEN_MIGRATION_INDEXES,
  type RequiredMigrationIndex,
} from "../lib/db/migration-history";

const ONLINE_MIGRATIONS_LOCK_SQL =
  "SELECT pg_advisory_lock(hashtext('stella-online-migrations'))";
const ONLINE_MIGRATIONS_UNLOCK_SQL =
  "SELECT pg_advisory_unlock(hashtext('stella-online-migrations'))";
const READ_INDEX_STATE_SQL = `
  SELECT
    index_state.indisready AS "isReady",
    index_state.indisunique AS "isUnique",
    index_state.indisvalid AS "isValid",
    pg_get_indexdef(index_relation.oid) AS "definition",
    index_relation.relname AS "name"
  FROM pg_catalog.pg_class index_relation
  JOIN pg_catalog.pg_namespace index_namespace
    ON index_namespace.oid = index_relation.relnamespace
  JOIN pg_catalog.pg_index index_state
    ON index_state.indexrelid = index_relation.oid
  JOIN pg_catalog.pg_class table_relation
    ON table_relation.oid = index_state.indrelid
  WHERE index_namespace.nspname = $1
    AND index_relation.relname = $2
    AND table_relation.relname = $3
`;
const READ_REINDEX_ARTIFACTS_SQL = `
  SELECT
    index_state.indisready AS "isReady",
    index_state.indisunique AS "isUnique",
    index_state.indisvalid AS "isValid",
    pg_get_indexdef(index_relation.oid) AS "definition",
    index_relation.relname AS "name"
  FROM pg_catalog.pg_class index_relation
  JOIN pg_catalog.pg_namespace index_namespace
    ON index_namespace.oid = index_relation.relnamespace
  JOIN pg_catalog.pg_index index_state
    ON index_state.indexrelid = index_relation.oid
  JOIN pg_catalog.pg_class table_relation
    ON table_relation.oid = index_state.indrelid
  WHERE index_namespace.nspname = $1
    AND table_relation.relname = $2
    AND (
      starts_with(index_relation.relname, $3)
      OR starts_with(index_relation.relname, $4)
    )
`;

type OnlineIndex = RequiredMigrationIndex & {
  createSql?: string;
};

export const ONLINE_MIGRATION_INDEXES: readonly OnlineIndex[] = [
  {
    createSql:
      'CREATE UNIQUE INDEX CONCURRENTLY "account_issuer_account_id_uidx" ON public."account" USING btree ("issuer", "account_id")',
    definitionBody: "ON public.account USING btree (issuer, account_id)",
    isUnique: true,
    name: "account_issuer_account_id_uidx",
    tableName: "account",
  },
  {
    createSql:
      'CREATE INDEX CONCURRENTLY "chat_thread_compactions_memory_unmined_org_idx" ON public."chat_thread_compactions" USING btree ("memory_extraction_organization_id", "memory_extraction_consent_at", "memory_extraction_attempted_at" ASC NULLS FIRST, "created_at", "id") WHERE "memory_extraction_organization_id" IS NOT NULL AND "memory_extraction_consent_at" IS NOT NULL AND "memory_extracted_at" IS NULL AND "status" = \'active\'',
    definitionBody:
      "ON public.chat_thread_compactions USING btree (memory_extraction_organization_id, memory_extraction_consent_at, memory_extraction_attempted_at NULLS FIRST, created_at, id) WHERE ((memory_extraction_organization_id IS NOT NULL) AND (memory_extraction_consent_at IS NOT NULL) AND (memory_extracted_at IS NULL) AND ((status)::text = 'active'::text))",
    isUnique: false,
    name: "chat_thread_compactions_memory_unmined_org_idx",
    tableName: "chat_thread_compactions",
  },
  {
    createSql:
      'CREATE INDEX CONCURRENTLY "organization_settings_memory_extraction_queue_idx" ON public."organization_settings" USING btree ("memory_extraction_scheduled_at", "organization_id") WHERE "memory_extraction_enabled" = true AND "memory_extraction_scheduled_at" IS NOT NULL',
    definitionBody:
      "ON public.organization_settings USING btree (memory_extraction_scheduled_at, organization_id) WHERE ((memory_extraction_enabled = true) AND (memory_extraction_scheduled_at IS NOT NULL))",
    isUnique: false,
    name: "organization_settings_memory_extraction_queue_idx",
    tableName: "organization_settings",
  },
  {
    createSql:
      'CREATE UNIQUE INDEX CONCURRENTLY "workspaces_id_org_unq" ON public."workspaces" USING btree ("id", "organization_id")',
    definitionBody: "ON public.workspaces USING btree (id, organization_id)",
    isUnique: true,
    name: "workspaces_id_org_unq",
    tableName: "workspaces",
  },
  {
    createSql:
      'CREATE UNIQUE INDEX CONCURRENTLY "entity_versions_id_entity_ws_uidx" ON public."entity_versions" USING btree ("id", "entity_id", "workspace_id")',
    definitionBody:
      "ON public.entity_versions USING btree (id, entity_id, workspace_id)",
    isUnique: true,
    name: "entity_versions_id_entity_ws_uidx",
    tableName: "entity_versions",
  },
  {
    createSql:
      'CREATE UNIQUE INDEX CONCURRENTLY "chat_messages_id_thread_uidx" ON public."chat_messages" USING btree ("id", "thread_id")',
    definitionBody: "ON public.chat_messages USING btree (id, thread_id)",
    isUnique: true,
    name: "chat_messages_id_thread_uidx",
    tableName: "chat_messages",
  },
  {
    createSql:
      'CREATE UNIQUE INDEX CONCURRENTLY "time_entries_one_active_timer_per_user_idx" ON public."time_entries" USING btree ("user_id") WHERE "timer_started_at" IS NOT NULL',
    definitionBody:
      "ON public.time_entries USING btree (user_id) WHERE (timer_started_at IS NOT NULL)",
    isUnique: true,
    name: "time_entries_one_active_timer_per_user_idx",
    tableName: "time_entries",
  },
  {
    createSql:
      'CREATE UNIQUE INDEX CONCURRENTLY "playbook_definitions_org_starter_id_uidx" ON public."playbook_definitions" USING btree ("organization_id", "starter_id") WHERE "starter_id" IS NOT NULL',
    definitionBody:
      "ON public.playbook_definitions USING btree (organization_id, starter_id) WHERE (starter_id IS NOT NULL)",
    isUnique: true,
    name: "playbook_definitions_org_starter_id_uidx",
    tableName: "playbook_definitions",
  },
  {
    createSql:
      'CREATE UNIQUE INDEX CONCURRENTLY "templates_org_pack_template_uidx" ON public."templates" USING btree ("organization_id", (("origin"->>\'packId\')), (("origin"->>\'slug\'))) WHERE "origin_type" = \'bundled-pack\'',
    definitionBody:
      "ON public.templates USING btree (organization_id, ((origin ->> 'packId'::text)), ((origin ->> 'slug'::text))) WHERE (origin_type = 'bundled-pack'::text)",
    isUnique: true,
    name: "templates_org_pack_template_uidx",
    tableName: "templates",
  },
  {
    createSql:
      'CREATE INDEX CONCURRENTLY "report_exports_workspace_requester_created_idx" ON public."report_exports" USING btree ("workspace_id", "requested_by", "created_at", "id")',
    definitionBody:
      "ON public.report_exports USING btree (workspace_id, requested_by, created_at, id)",
    isUnique: false,
    name: "report_exports_workspace_requester_created_idx",
    tableName: "report_exports",
  },
  ...REWRITTEN_MIGRATION_INDEXES,
];

type OnlineIndexCutover = {
  final: RequiredMigrationIndex;
  staged: OnlineIndex;
};

export const ONLINE_MIGRATION_INDEX_CUTOVERS: readonly OnlineIndexCutover[] = [
  {
    final: {
      definitionBody:
        "ON public.case_law_decisions USING btree (updated_at DESC, id DESC)",
      isUnique: false,
      name: "case_law_decisions_updated_id_idx",
      tableName: "case_law_decisions",
    },
    staged: {
      createSql:
        'CREATE INDEX CONCURRENTLY "case_law_decisions_updated_id_idx_replacement" ON public."case_law_decisions" USING btree ("updated_at" DESC, "id" DESC)',
      definitionBody:
        "ON public.case_law_decisions USING btree (updated_at DESC, id DESC)",
      isUnique: false,
      name: "case_law_decisions_updated_id_idx_replacement",
      tableName: "case_law_decisions",
    },
  },
];

export const ONLINE_VALIDATED_INDEX_NAMES: ReadonlySet<string> = new Set([
  ...ONLINE_MIGRATION_INDEXES.map(({ name }) => name),
  ...ONLINE_MIGRATION_INDEX_CUTOVERS.flatMap(({ final, staged }) => [
    final.name,
    staged.name,
  ]),
]);

type OnlineIndexReplacement = {
  legacyName: string;
  replacementNames: readonly string[];
};

const ONLINE_INDEX_REPLACEMENTS: readonly OnlineIndexReplacement[] = [
  {
    legacyName: "case_law_decisions_source_case_lang_idx",
    replacementNames: [
      "case_law_decisions_source_document_idx",
      "case_law_decisions_source_case_lang_null_idx",
    ],
  },
];

type OnlineMigrationConnection = {
  execute: (query: string, params?: readonly unknown[]) => Promise<void>;
  query: (
    query: string,
    params?: readonly unknown[],
  ) => Promise<readonly unknown[]>;
  release: () => void;
};

export type OnlineMigrationPool = {
  reserve: () => Promise<OnlineMigrationConnection>;
};

type PresentIndexState = {
  definition: string;
  isReady: boolean;
  isUnique: boolean;
  isValid: boolean;
  name: string;
  type: "present";
};

type OnlineIndexState = { type: "missing" } | PresentIndexState;

type OnlineMigrationOperation = "repair" | "validate";

export const runOnlineMigrations = async (
  pool: OnlineMigrationPool,
): Promise<void> => await processOnlineMigrations(pool, "repair");

export const assertOnlineMigrationsApplied = async (
  pool: OnlineMigrationPool,
): Promise<void> => await processOnlineMigrations(pool, "validate");

const processOnlineMigrations = async (
  pool: OnlineMigrationPool,
  operation: OnlineMigrationOperation,
): Promise<void> => {
  const connection = await pool.reserve();
  let lockAcquired = false;

  try {
    await connection.execute(ONLINE_MIGRATIONS_LOCK_SQL);
    lockAcquired = true;

    if (operation === "repair") {
      await connection.execute("SET lock_timeout = '1s'");
      await connection.execute("SET statement_timeout = '0'");
    }

    await processOnlineIndexAt(connection, operation);
    await processOnlineIndexCutoverAt(connection, operation);
    if (operation === "repair") {
      await retireReplacedIndexAt(connection);
    }
  } finally {
    try {
      if (lockAcquired) {
        await connection.execute(ONLINE_MIGRATIONS_UNLOCK_SQL);
      }
    } finally {
      connection.release();
    }
  }
};

const processOnlineIndexAt = async (
  connection: OnlineMigrationConnection,
  operation: OnlineMigrationOperation,
  offset = 0,
): Promise<void> => {
  const index = ONLINE_MIGRATION_INDEXES.at(offset);
  if (!index) {
    return;
  }

  if (operation === "repair") {
    await ensureIndexValid(connection, index);
  } else {
    await assertIndexReady(connection, index);
  }
  await processOnlineIndexAt(connection, operation, offset + 1);
};

const processOnlineIndexCutoverAt = async (
  connection: OnlineMigrationConnection,
  operation: OnlineMigrationOperation,
  offset = 0,
): Promise<void> => {
  const cutover = ONLINE_MIGRATION_INDEX_CUTOVERS.at(offset);
  if (!cutover) {
    return;
  }

  if (operation === "repair") {
    await completeIndexCutover(connection, cutover);
  } else {
    await assertIndexReady(connection, cutover.final);
  }
  await processOnlineIndexCutoverAt(connection, operation, offset + 1);
};

const retireReplacedIndexAt = async (
  connection: OnlineMigrationConnection,
  offset = 0,
): Promise<void> => {
  const replacement = ONLINE_INDEX_REPLACEMENTS.at(offset);
  if (!replacement) {
    return;
  }

  await assertReplacementIndexAt(connection, replacement);
  await connection.execute(
    `DROP INDEX CONCURRENTLY IF EXISTS public.${quoteIdentifier(replacement.legacyName)}`,
  );
  await retireReplacedIndexAt(connection, offset + 1);
};

const assertReplacementIndexAt = async (
  connection: OnlineMigrationConnection,
  replacement: OnlineIndexReplacement,
  offset = 0,
): Promise<void> => {
  const replacementName = replacement.replacementNames.at(offset);
  if (!replacementName) {
    return;
  }
  const index = ONLINE_MIGRATION_INDEXES.find(
    ({ name }) => name === replacementName,
  );
  if (!index) {
    panic(
      `Replacement index ${replacementName} is not registered for online validation`,
    );
  }

  await assertIndexReady(connection, index);
  await assertReplacementIndexAt(connection, replacement, offset + 1);
};

const parsePresentIndexState = (row: unknown): PresentIndexState => {
  if (
    typeof row !== "object" ||
    row === null ||
    !("definition" in row) ||
    typeof row.definition !== "string" ||
    !("isReady" in row) ||
    typeof row.isReady !== "boolean" ||
    !("isUnique" in row) ||
    typeof row.isUnique !== "boolean" ||
    !("isValid" in row) ||
    typeof row.isValid !== "boolean" ||
    !("name" in row) ||
    typeof row.name !== "string"
  ) {
    panic("Online migration index state has an invalid shape");
  }

  return {
    definition: row.definition,
    isReady: row.isReady,
    isUnique: row.isUnique,
    isValid: row.isValid,
    name: row.name,
    type: "present",
  };
};

const readIndexState = async (
  connection: OnlineMigrationConnection,
  { name, tableName }: RequiredMigrationIndex,
): Promise<OnlineIndexState> => {
  const row = (
    await connection.query(READ_INDEX_STATE_SQL, ["public", name, tableName])
  ).at(0);
  return row === undefined ? { type: "missing" } : parsePresentIndexState(row);
};

const POSTGRES_IDENTIFIER_MAX_LENGTH = 63;

const reindexArtifactPrefix = (name: string, suffix: "_ccnew" | "_ccold") =>
  `${name.slice(0, POSTGRES_IDENTIFIER_MAX_LENGTH - suffix.length)}${suffix}`;

const readReindexArtifacts = async (
  connection: OnlineMigrationConnection,
  { name, tableName }: RequiredMigrationIndex,
): Promise<PresentIndexState[]> =>
  (
    await connection.query(READ_REINDEX_ARTIFACTS_SQL, [
      "public",
      tableName,
      reindexArtifactPrefix(name, "_ccnew"),
      reindexArtifactPrefix(name, "_ccold"),
    ])
  ).map(parsePresentIndexState);

const definitionBody = (definition: string): string => {
  const bodyStart = definition.indexOf(" ON ");
  if (bodyStart === -1) {
    panic("Online migration index definition has an invalid shape");
  }
  return definition.slice(bodyStart + 1);
};

const assertIndexDefinition = (
  index: RequiredMigrationIndex,
  state: PresentIndexState,
): void => {
  if (!hasExpectedIndexDefinition(index, state)) {
    panic(
      `Required migration index ${index.name} has an unexpected definition`,
    );
  }
};

const hasExpectedIndexDefinition = (
  index: RequiredMigrationIndex,
  state: PresentIndexState,
): boolean =>
  state.isUnique === index.isUnique &&
  definitionBody(state.definition) === index.definitionBody;

const assertNoReindexArtifacts = async (
  connection: OnlineMigrationConnection,
  index: RequiredMigrationIndex,
): Promise<void> => {
  const artifacts = await readReindexArtifacts(connection, index);
  if (artifacts.length > 0) {
    panic(`Required migration index ${index.name} has reindex artifacts`);
  }
};

const cleanupFailedReindexArtifacts = async (
  connection: OnlineMigrationConnection,
  index: RequiredMigrationIndex,
): Promise<void> => {
  const artifacts = await readReindexArtifacts(connection, index);
  await cleanupReindexArtifactAt(connection, index, artifacts);
};

const cleanupReindexArtifactAt = async (
  connection: OnlineMigrationConnection,
  index: RequiredMigrationIndex,
  artifacts: readonly PresentIndexState[],
  offset = 0,
): Promise<void> => {
  const artifact = artifacts.at(offset);
  if (!artifact) {
    return;
  }

  assertIndexDefinition(index, artifact);
  if (artifact.isValid) {
    panic(
      `Required migration index ${index.name} has a valid reindex artifact`,
    );
  }
  await connection.execute(
    `DROP INDEX CONCURRENTLY public.${quoteIdentifier(artifact.name)}`,
  );
  await cleanupReindexArtifactAt(connection, index, artifacts, offset + 1);
};

const assertIndexReady = async (
  connection: OnlineMigrationConnection,
  index: RequiredMigrationIndex,
): Promise<void> => {
  const state = await readIndexState(connection, index);
  if (state.type === "missing") {
    panic(`Required migration index ${index.name} is missing`);
  }
  assertIndexDefinition(index, state);
  if (!state.isValid || !state.isReady) {
    panic(`Required migration index ${index.name} is not ready`);
  }
  await assertNoReindexArtifacts(connection, index);
};

const ensureIndexValid = async (
  connection: OnlineMigrationConnection,
  index: OnlineIndex,
): Promise<void> => {
  await cleanupFailedReindexArtifacts(connection, index);
  const initialState = await readIndexState(connection, index);
  if (initialState.type === "present") {
    assertIndexDefinition(index, initialState);
    if (initialState.isValid && initialState.isReady) {
      return;
    }

    await connection.execute(
      `REINDEX INDEX CONCURRENTLY public.${quoteIdentifier(index.name)}`,
    );
  } else if (index.createSql) {
    await connection.execute(index.createSql);
  } else {
    panic(`Required migration index ${index.name} is missing`);
  }

  await assertIndexReady(connection, index);
};

const completeIndexCutover = async (
  connection: OnlineMigrationConnection,
  { final, staged }: OnlineIndexCutover,
): Promise<void> => {
  const finalState = await readIndexState(connection, final);

  if (finalState.type === "present") {
    const finalIsReady =
      hasExpectedIndexDefinition(final, finalState) &&
      finalState.isValid &&
      finalState.isReady;

    if (finalIsReady) {
      await cleanupFailedReindexArtifacts(connection, final);
      await assertIndexReady(connection, final);
      const stagedState = await readIndexState(connection, staged);
      if (stagedState.type === "present") {
        assertIndexDefinition(staged, stagedState);
        await connection.execute(
          `DROP INDEX CONCURRENTLY public.${quoteIdentifier(staged.name)}`,
        );
      }
      return;
    }
  }

  await ensureIndexValid(connection, staged);

  if (finalState.type === "present") {
    await connection.execute(
      `DROP INDEX CONCURRENTLY public.${quoteIdentifier(final.name)}`,
    );
  }
  await connection.execute(
    `ALTER INDEX public.${quoteIdentifier(staged.name)} RENAME TO ${quoteIdentifier(final.name)}`,
  );
  await assertIndexReady(connection, final);
};

const POSTGRES_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/u;

const quoteIdentifier = (identifier: string): string => {
  if (!POSTGRES_IDENTIFIER.test(identifier)) {
    panic(`Invalid internal PostgreSQL identifier: ${identifier}`);
  }
  return `"${identifier}"`;
};
