import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { panic } from "better-result";
import { sql, type SQL } from "drizzle-orm";
import { readdirSync, readFileSync } from "node:fs";
import nodePath from "node:path";

import { ASCII_FOLD_TABLE } from "@stll/text-normalize";

import { WORKSPACE_ACCESS_VIEW_NAME } from "@/api/db/rls";
import { FLOW_TRANSITION_SPECS_V1 } from "@/api/lib/db/flow-run-transition-spec";
import { transitionTriggerSql } from "@/api/lib/db/transition-sql";

const DRIZZLE_DIR = nodePath.resolve(import.meta.dir, "../../drizzle");
const WORKSPACE_AUTHORIZATION_MIGRATION_PATH = nodePath.join(
  DRIZZLE_DIR,
  "20260710173000_scalable_workspace_authorization",
  "migration.sql",
);
const CHAT_THREAD_TURN_WORKSPACE_CASCADE_MIGRATION_PATH = nodePath.join(
  DRIZZLE_DIR,
  "20260803120000_chat_thread_turn_workspace_cascade",
  "migration.sql",
);
const CHAT_TURN_RUN_OWNERSHIP_MIGRATION_PATH = nodePath.join(
  DRIZZLE_DIR,
  "20261003121500_chat_turn_run_ownership",
  "migration.sql",
);
const SCHEDULER_OPERATOR_PAUSES_MIGRATION_PATH = nodePath.join(
  DRIZZLE_DIR,
  "20261003123100_scheduler_operator_pauses",
  "migration.sql",
);
const DOCX_SUGGESTION_SOURCE_MATTERS_MIGRATION_PATH = nodePath.join(
  DRIZZLE_DIR,
  "20260827120000_docx_suggestion_source_matters",
  "migration.sql",
);
const AGENT_SKILL_REVISIONS_MIGRATION_PATH = nodePath.join(
  DRIZZLE_DIR,
  "20260827080000_agent_skill_revisions",
  "migration.sql",
);
const AGENT_SKILL_ANCHOR_LOCK_MIGRATION_PATH = nodePath.join(
  DRIZZLE_DIR,
  "20260925230100_agent_skill_anchor_lock",
  "migration.sql",
);
const STATUTE_CITATION_COUNTS_MIGRATION_PATH = nodePath.join(
  DRIZZLE_DIR,
  "20260911150000_statute_citation_counts",
  "migration.sql",
);
const LEGISLATION_PAYLOAD_REVISION_MIGRATION_PATH = nodePath.join(
  DRIZZLE_DIR,
  "20260926150000_legislation_payload_revision",
  "migration.sql",
);
const LEGISLATION_PAYLOAD_REVISION_CLASSIFICATION_MIGRATION_PATH =
  nodePath.join(
    DRIZZLE_DIR,
    "20261003122200_legislation_payload_revision_classification",
    "migration.sql",
  );
const LEGISLATION_EXPRESSION_IDENTITY_MIGRATION_PATH = nodePath.join(
  DRIZZLE_DIR,
  "20261003120000_legislation_expression_identity",
  "migration.sql",
);
const PROVISION_EXTRACTION_STATE_MIGRATION_PATH = nodePath.join(
  DRIZZLE_DIR,
  "20260926160000_case_law_provision_extraction_state",
  "migration.sql",
);
const PROVISION_BACKFILL_MIGRATION_PATH = nodePath.join(
  DRIZZLE_DIR,
  "20260926170000_case_law_provision_backfill",
  "migration.sql",
);
const PROVISION_READ_STATUS_MIGRATION_PATH = nodePath.join(
  DRIZZLE_DIR,
  "20260927090000_case_law_provision_read_status",
  "migration.sql",
);
const PROVISION_READER_GRANTS_MIGRATION_PATH = nodePath.join(
  DRIZZLE_DIR,
  "20261003120300_case_law_provision_reader_grants",
  "migration.sql",
);
const PROVISION_SCOPE_TRANSITION_KEYSET_MIGRATION_PATH = nodePath.join(
  DRIZZLE_DIR,
  "20260929180100_case_law_provision_scope_transition_keyset",
  "migration.sql",
);
const CASE_LAW_OBSERVATION_FENCE_MIGRATION_PATH = nodePath.join(
  DRIZZLE_DIR,
  "20260731190000_case_law_observation_legacy_fence",
  "migration.sql",
);
const CORPUS_PROJECTION_REVISION_MIGRATION_PATHS = [
  nodePath.join(
    DRIZZLE_DIR,
    "20260826004100_corpus_projection_revision_fence",
    "migration.sql",
  ),
  nodePath.join(
    DRIZZLE_DIR,
    "20260901060000_concurrent_corpus_projection_revision_fence",
    "migration.sql",
  ),
] as const;

type PgliteSchemaDb = {
  execute: (query: SQL) => Promise<unknown>;
};

export const installPgliteFlowTransitions = async (db: PgliteSchemaDb) => {
  for (const spec of FLOW_TRANSITION_SPECS_V1) {
    for (const statement of transitionTriggerSql(spec).split(
      "--> statement-breakpoint",
    )) {
      if (statement.trim()) {
        await db.execute(sql.raw(statement));
      }
    }
  }
};

export const createSchemaPglite = async () =>
  await PGlite.create({ extensions: { pg_trgm } });

const readMigrationStatements = (migrationPath: string): string[] =>
  readFileSync(migrationPath, "utf-8")
    .split("--> statement-breakpoint")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

const executableSql = (statement: string): string =>
  statement.replace(/^[ \t]*--[^\n]*/gmu, "").trim();

/**
 * PGlite ships no `unaccent`, so the production `legislation_title_fold`
 * (migration 20260901130000) cannot be installed verbatim. This double is
 * generated from the fold table the unaccent parity test pins against the
 * real extension: NFD plus combining-mark removal for everything Unicode can
 * decompose, then the table's rules for the letters it cannot (`ł`, `ß`, `ø`).
 */
const asciiFoldPgliteExpression = (): string => {
  const entries = Object.entries(ASCII_FOLD_TABLE);
  const singles = entries.filter(([, folded]) => folded.length === 1);
  const multis = entries.filter(([, folded]) => folded.length !== 1);
  const quote = (value: string): string => `$fold$${value}$fold$`;
  let expression =
    "regexp_replace(normalize($1, NFD), '[\\u0300-\\u036f]', '', 'g')";
  expression = `translate(${expression}, ${quote(singles.map(([from]) => from).join(""))}, ${quote(singles.map(([, to]) => to).join(""))})`;
  for (const [from, to] of multis) {
    expression = `replace(${expression}, ${quote(from)}, ${quote(to)})`;
  }
  return expression;
};

const legislationTitleFoldPgliteSql = (): string =>
  `CREATE OR REPLACE FUNCTION legislation_title_fold(input text)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $body$
  SELECT lower(${asciiFoldPgliteExpression()})
$body$`;

/**
 * The same fold stands in for the `unaccent` extension itself, so search
 * queries (`to_tsquery('simple', unaccent(...))`) run under PGlite.
 */
const unaccentPgliteSql = (): string =>
  `CREATE OR REPLACE FUNCTION unaccent(text)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $body$
  SELECT ${asciiFoldPgliteExpression()}
$body$`;

const latestMigrationStatementContaining = (fragment: string): string => {
  const statements = readdirSync(DRIZZLE_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .toSorted()
    .flatMap((dirName) => {
      const migrationPath = nodePath.join(
        DRIZZLE_DIR,
        dirName,
        "migration.sql",
      );
      return readMigrationStatements(migrationPath).filter((part) =>
        part.includes(fragment),
      );
    });

  const statement = statements.at(-1);

  if (!statement) {
    panic(`Migration statement not found: ${fragment}`);
  }

  return statement;
};

const arabicNormalizeFunctionSql = (): string =>
  latestMigrationStatementContaining(
    "CREATE OR REPLACE FUNCTION arabic_normalize",
  );

// Plain jsonb operators, so the production function installs verbatim.
const fieldFindTextFunctionSql = (): string =>
  latestMigrationStatementContaining(
    "CREATE OR REPLACE FUNCTION field_find_text",
  );

export const installPgliteSchemaPrerequisites = async (
  db: PgliteSchemaDb,
): Promise<void> => {
  await db.execute(sql.raw("CREATE EXTENSION IF NOT EXISTS pg_trgm"));
  await db.execute(sql.raw(arabicNormalizeFunctionSql()));
  await db.execute(sql.raw(unaccentPgliteSql()));
  await db.execute(sql.raw(legislationTitleFoldPgliteSql()));
  await db.execute(sql.raw(fieldFindTextFunctionSql()));
  await db.execute(
    sql.raw(
      latestMigrationStatementContaining(
        "CREATE FUNCTION stella_list_verification_day",
      ),
    ),
  );
  // Drizzle emits policies that reference this view before its backing tables
  // exist. Install a harmless shape-compatible stub for schema creation; the
  // security test database replaces it after pushSchema finishes.
  await db.execute(
    sql.raw(`
      CREATE OR REPLACE VIEW public.${WORKSPACE_ACCESS_VIEW_NAME}
      AS SELECT
        NULL::uuid AS authorized_workspace_id,
        NULL::text AS workspace_status
      WHERE false
    `),
  );
};

// Split by leading keyword so each pattern stays below the lint's regex
// complexity budget; together they cover PostgreSQL's transaction-control
// statements (single-keyword forms subsume their PREPARED/SAVEPOINT/TO
// variants).
const isTransactionControlStatement = (executable: string): boolean =>
  /^(?:ABORT|BEGIN|COMMIT|END|RELEASE|ROLLBACK|SAVEPOINT)\b/iu.test(
    executable,
  ) ||
  /^(?:PREPARE|START)\s+TRANSACTION\b/iu.test(executable) ||
  /^SET\s+(?:TRANSACTION|SESSION\s+CHARACTERISTICS\s+AS\s+TRANSACTION)\b/iu.test(
    executable,
  );

export const installPgliteWorkspaceAccessObjects = async (
  db: PgliteSchemaDb,
): Promise<void> => {
  const migrationPaths = [
    WORKSPACE_AUTHORIZATION_MIGRATION_PATH,
    CHAT_THREAD_TURN_WORKSPACE_CASCADE_MIGRATION_PATH,
  ];
  for (const migrationPath of migrationPaths) {
    await installPgliteMigration({ db, migrationPath });
  }
  // The replay above rewrites every `workspace_*` policy to the plain matter
  // check, so a table whose policies carry a further predicate in the schema
  // needs its own ALTER POLICY statements replayed afterwards. The column
  // itself already exists from the push, so only the policy statements run.
  const policyStatements = readMigrationStatements(
    DOCX_SUGGESTION_SOURCE_MATTERS_MIGRATION_PATH,
  ).filter((statement) => executableSql(statement).startsWith("ALTER POLICY"));
  for (const statement of policyStatements) {
    await db.execute(sql.raw(statement));
  }
};

// Drizzle's schema (and therefore pushSchema) has no construct for trigger
// functions, so 20260827080000_agent_skill_revisions's CREATE FUNCTION /
// CREATE TRIGGER statements never reach the test database through the push
// path that creates its tables, indexes, and RLS policies. Installing the
// full migration file after pushSchema would re-run its CREATE TABLE
// statements against tables pushSchema already created, so this pulls out
// only the trigger-function statements — mirroring how
// arabicNormalizeFunctionSql above extracts one function statement rather
// than replaying its migration.
const AGENT_SKILL_REVISION_TRIGGER_STATEMENT_PREFIXES = [
  "CREATE FUNCTION",
  "REVOKE ALL ON FUNCTION",
  "CREATE TRIGGER",
] as const;

export const installPgliteAgentSkillRevisionTrigger = async (
  db: PgliteSchemaDb,
): Promise<void> => {
  const statements = readMigrationStatements(
    AGENT_SKILL_REVISIONS_MIGRATION_PATH,
  ).filter((statement) =>
    AGENT_SKILL_REVISION_TRIGGER_STATEMENT_PREFIXES.some((prefix) =>
      executableSql(statement).startsWith(prefix),
    ),
  );
  for (const statement of statements) {
    await db.execute(sql.raw(statement));
  }
  // The anchor lock migration holds only its function and grants.
  await installPgliteMigration({
    db,
    migrationPath: AGENT_SKILL_ANCHOR_LOCK_MIGRATION_PATH,
  });
};

const TREE_PARENT_CYCLE_GUARD_MIGRATION_PATH = nodePath.join(
  DRIZZLE_DIR,
  "20261004003000_tree_parent_cycle_guard",
  "migration.sql",
);
const ENTITY_FEATURE_GATE_MIGRATION_PATH = nodePath.join(
  DRIZZLE_DIR,
  "20261009112500_entity_feature_row_gates",
  "migration.sql",
);

/** Replay the committed gate migration's transactional setup against pushed schema. */
export const installPgliteEntityFeatureGateMaintenance = async (
  db: PgliteSchemaDb,
): Promise<void> => {
  const statements = readMigrationStatements(
    ENTITY_FEATURE_GATE_MIGRATION_PATH,
  );
  const commitIndex = statements.findIndex((statement) =>
    /^COMMIT\b/iu.test(executableSql(statement)),
  );
  if (commitIndex === -1) {
    panic("Entity feature gate migration has no initial transaction commit");
  }

  for (const statement of statements.slice(0, commitIndex)) {
    const executable = executableSql(statement);
    if (
      executable.length === 0 ||
      /^SET\s+(?:lock_timeout|statement_timeout)\b/iu.test(executable)
    ) {
      continue;
    }
    if (/\bCONCURRENTLY\b/iu.test(executable)) {
      panic("PGlite gate setup must not replay concurrent index statements");
    }
    await db.execute(sql.raw(statement));
  }
};

/** Install the self-referencing tree triggers omitted by declarative schema push. */
export const installPgliteTreeParentGuards = async (
  db: PgliteSchemaDb,
): Promise<void> => {
  await installPgliteMigration({
    db,
    migrationPath: TREE_PARENT_CYCLE_GUARD_MIGRATION_PATH,
  });
};

/** Install the scheduler pause audit trigger omitted by declarative schema push. */
export const installPgliteSchedulerJobPauseLog = async (
  db: PgliteSchemaDb,
): Promise<void> => {
  const statements = readMigrationStatements(
    SCHEDULER_OPERATOR_PAUSES_MIGRATION_PATH,
  ).filter((statement) => {
    const executable = executableSql(statement);
    return (
      executable.startsWith("CREATE FUNCTION public.scheduler_job_pause_log") ||
      executable.startsWith("CREATE TRIGGER scheduler_job_pause_log")
    );
  });
  for (const statement of statements) {
    await db.execute(sql.raw(statement));
  }
};

const PDF_SIGNING_SESSIONS_MIGRATION_PATH = nodePath.join(
  DRIZZLE_DIR,
  "20260928101000_pdf_signing_sessions",
  "migration.sql",
);

const CHAT_RUN_LOG_MIGRATION_PATH = nodePath.join(
  DRIZZLE_DIR,
  "20261003121600_chat_run_log",
  "migration.sql",
);

/** Schema push omits FORCE RLS, so mirror the migration's forced policies. */
export const installPgliteChatRunLogRls = async (
  db: PgliteSchemaDb,
): Promise<void> => {
  const statement = readMigrationStatements(CHAT_RUN_LOG_MIGRATION_PATH).find(
    (candidate) =>
      executableSql(candidate).startsWith(
        'ALTER TABLE "chat_run_logs" FORCE ROW LEVEL SECURITY',
      ),
  );
  if (statement === undefined) {
    panic("Chat run log FORCE RLS migration statement is missing");
  }
  await db.execute(sql.raw(statement));

  const entriesStatement = readMigrationStatements(
    CHAT_RUN_LOG_MIGRATION_PATH,
  ).find((candidate) =>
    executableSql(candidate).startsWith(
      'ALTER TABLE "chat_run_log_entries" FORCE ROW LEVEL SECURITY',
    ),
  );
  if (entriesStatement === undefined) {
    panic("Chat run log entries FORCE RLS migration statement is missing");
  }
  await db.execute(sql.raw(entriesStatement));
};

const PDF_SIGNING_TOKEN_SCOPE_STATEMENT_PREFIXES = [
  'ALTER TABLE "pdf_signing_sessions"\n  FORCE ROW LEVEL SECURITY',
  "CREATE FUNCTION",
  "REVOKE ALL ON FUNCTION",
  "GRANT EXECUTE ON FUNCTION",
] as const;

/** Apply the presence migration's forced owner boundary, which schema push omits. */
export const installPgliteDesktopPresenceRls = async (
  db: PgliteSchemaDb,
): Promise<void> => {
  const statement = readMigrationStatements(
    nodePath.join(
      DRIZZLE_DIR,
      "20261004120300_desktop_presence",
      "migration.sql",
    ),
  ).find((candidate) =>
    executableSql(candidate).startsWith(
      'ALTER TABLE "desktop_presence" FORCE ROW LEVEL SECURITY',
    ),
  );
  if (!statement) {
    panic("Desktop presence FORCE RLS migration statement is missing");
  }
  await db.execute(sql.raw(statement));
};

/**
 * Install what schema push cannot say about PDF signing sessions: forced row
 * security and the token-scope lookups the desktop's calls go through.
 */
export const installPglitePdfSigningTokenScopes = async (
  db: PgliteSchemaDb,
): Promise<void> => {
  const statements = readMigrationStatements(
    PDF_SIGNING_SESSIONS_MIGRATION_PATH,
  ).filter((statement) =>
    PDF_SIGNING_TOKEN_SCOPE_STATEMENT_PREFIXES.some((prefix) =>
      executableSql(statement).startsWith(prefix),
    ),
  );
  for (const statement of statements) {
    await db.execute(sql.raw(statement));
  }
};

/** Schema push omits the scoped, owner-executed run-id collision lookup. */
export const installPgliteChatTurnRunIdLookup = async (
  db: PgliteSchemaDb,
): Promise<void> => {
  const prefixes = [
    "CREATE OR REPLACE FUNCTION public.chat_turn_run_id_taken",
    "REVOKE ALL ON FUNCTION public.chat_turn_run_id_taken",
    "GRANT EXECUTE ON FUNCTION public.chat_turn_run_id_taken",
  ] as const;
  const statements = readMigrationStatements(
    CHAT_TURN_RUN_OWNERSHIP_MIGRATION_PATH,
  ).filter((statement) =>
    prefixes.some((prefix) => executableSql(statement).startsWith(prefix)),
  );
  if (statements.length !== prefixes.length) {
    panic("Chat turn run-id lookup migration statements are missing");
  }
  for (const statement of statements) {
    await db.execute(sql.raw(statement));
  }
};

const STATUTE_CITATION_COUNT_STATEMENT_PREFIXES = [
  'INSERT INTO "case_law_statute_citation_count_state"',
  "CREATE FUNCTION",
  "CREATE TRIGGER",
] as const;

/** Install the count state and trigger invariants omitted by schema push. */
export const installPgliteStatuteCitationCounts = async (
  db: PgliteSchemaDb,
): Promise<void> => {
  const statements = readMigrationStatements(
    STATUTE_CITATION_COUNTS_MIGRATION_PATH,
  ).filter((statement) =>
    STATUTE_CITATION_COUNT_STATEMENT_PREFIXES.some((prefix) =>
      executableSql(statement).startsWith(prefix),
    ),
  );
  for (const statement of statements) {
    await db.execute(sql.raw(statement));
  }
  for (const statement of readMigrationStatements(
    nodePath.join(
      DRIZZLE_DIR,
      "20260916110000_published_statute_citation_counts",
      "migration.sql",
    ),
  ).filter((candidate) => !executableSql(candidate).startsWith("SET "))) {
    await db.execute(sql.raw(statement));
  }
};

const PROVISION_EXTRACTION_STATE_STATEMENT_PREFIXES = [
  "CREATE FUNCTION",
  "CREATE OR REPLACE FUNCTION",
  "CREATE TRIGGER",
  "REVOKE ALL ON FUNCTION",
  "GRANT EXECUTE ON FUNCTION",
] as const;

/**
 * Install the provision extraction functions and triggers, including the
 * decision enqueue trigger, which declarative schema push omits.
 */
export const installPgliteProvisionExtractionState = async (
  db: PgliteSchemaDb,
): Promise<void> => {
  for (const migrationPath of [
    PROVISION_EXTRACTION_STATE_MIGRATION_PATH,
    PROVISION_BACKFILL_MIGRATION_PATH,
    PROVISION_READ_STATUS_MIGRATION_PATH,
    PROVISION_READER_GRANTS_MIGRATION_PATH,
    PROVISION_SCOPE_TRANSITION_KEYSET_MIGRATION_PATH,
  ]) {
    const statements = readMigrationStatements(migrationPath).filter(
      (statement) =>
        PROVISION_EXTRACTION_STATE_STATEMENT_PREFIXES.some((prefix) =>
          executableSql(statement).startsWith(prefix),
        ),
    );
    for (const statement of statements) {
      await db.execute(sql.raw(statement));
    }
  }
};

const CORPUS_PROJECTION_REVISION_STATEMENT_PREFIXES = [
  "CREATE FUNCTION",
  "CREATE OR REPLACE FUNCTION",
  "REVOKE ALL ON FUNCTION",
  "GRANT EXECUTE ON FUNCTION",
  "CREATE TRIGGER",
] as const;

/** Install the projection mutation fence omitted by declarative schema push. */
export const installPgliteCorpusProjectionRevisionFence = async (
  db: PgliteSchemaDb,
): Promise<void> => {
  for (const migrationPath of CORPUS_PROJECTION_REVISION_MIGRATION_PATHS) {
    const statements = readMigrationStatements(migrationPath).filter(
      (statement) =>
        CORPUS_PROJECTION_REVISION_STATEMENT_PREFIXES.some((prefix) =>
          executableSql(statement).startsWith(prefix),
        ),
    );
    for (const statement of statements) {
      await db.execute(sql.raw(statement));
    }
  }
};

const LEGISLATION_PAYLOAD_REVISION_STATEMENT_PREFIXES = [
  'ALTER TABLE "legislation_work_changes" FORCE ROW LEVEL SECURITY',
  "CREATE FUNCTION",
  "CREATE TRIGGER",
] as const;

/**
 * Install the triggers and forced row security that schema push omits, then
 * the function body later migrations replaced, so the tests run the body
 * production runs.
 */
export const installPgliteLegislationPayloadRevision = async (
  db: PgliteSchemaDb,
): Promise<void> => {
  const statements = [
    ...readMigrationStatements(
      LEGISLATION_PAYLOAD_REVISION_MIGRATION_PATH,
    ).filter((statement) =>
      LEGISLATION_PAYLOAD_REVISION_STATEMENT_PREFIXES.some((prefix) =>
        executableSql(statement).startsWith(prefix),
      ),
    ),
    ...readMigrationStatements(
      LEGISLATION_PAYLOAD_REVISION_CLASSIFICATION_MIGRATION_PATH,
    ).filter((statement) =>
      executableSql(statement).startsWith("CREATE OR REPLACE FUNCTION"),
    ),
  ];
  for (const statement of statements) {
    await db.execute(sql.raw(statement));
  }
};

const LEGISLATION_EXPRESSION_IDENTITY_STATEMENT_PREFIXES = [
  "CREATE OR REPLACE FUNCTION",
  "CREATE TRIGGER",
] as const;

/** Install the namespace and expression-id guards that schema push omits. */
export const installPgliteLegislationExpressionIdentity = async (
  db: PgliteSchemaDb,
): Promise<void> => {
  const statements = readMigrationStatements(
    LEGISLATION_EXPRESSION_IDENTITY_MIGRATION_PATH,
  ).filter((statement) =>
    LEGISLATION_EXPRESSION_IDENTITY_STATEMENT_PREFIXES.some((prefix) =>
      executableSql(statement).startsWith(prefix),
    ),
  );
  for (const statement of statements) {
    await db.execute(sql.raw(statement));
  }
};

/**
 * Install the fence that rejects a write of a decision's publisher hash that
 * does not advance its observation order.
 */
export const installPgliteCaseLawObservationFence = async (
  db: PgliteSchemaDb,
): Promise<void> => {
  const statements = readMigrationStatements(
    CASE_LAW_OBSERVATION_FENCE_MIGRATION_PATH,
  ).filter((statement) => !executableSql(statement).startsWith("SET "));
  for (const statement of statements) {
    await db.execute(sql.raw(statement));
  }
};

const ORGANIZATION_MEMBER_CAPACITY_MIGRATION_PATH = nodePath.join(
  DRIZZLE_DIR,
  "20261003120100_organization_member_capacity",
  "migration.sql",
);

/** Install the migration-owned matter-contact capacity guard after schema push. */
export const installPgliteWorkspaceContactCapacity = async (
  db: PgliteSchemaDb,
): Promise<void> => {
  const statements = readMigrationStatements(
    nodePath.join(
      DRIZZLE_DIR,
      "20261003125100_workspace_contact_capacity",
      "migration.sql",
    ),
  ).filter((statement) => !executableSql(statement).startsWith("SET "));
  for (const statement of statements) {
    await db.execute(sql.raw(statement));
  }
};

const ORGANIZATION_MEMBER_CAPACITY_STATEMENT_PREFIXES = [
  "CREATE FUNCTION",
  "CREATE OR REPLACE FUNCTION",
  "REVOKE ALL ON FUNCTION",
  "GRANT EXECUTE ON FUNCTION",
  "CREATE TRIGGER",
] as const;

/**
 * Install membership capacity, ownership, matter-membership reference and
 * effective-policy functions omitted by schema push.
 */
export const installPgliteOrganizationMemberCapacity = async (
  db: PgliteSchemaDb,
): Promise<void> => {
  const statements = [
    ...readMigrationStatements(ORGANIZATION_MEMBER_CAPACITY_MIGRATION_PATH),
    ...readMigrationStatements(
      nodePath.join(
        DRIZZLE_DIR,
        "20261003123700_membership_role_invariants",
        "migration.sql",
      ),
    ),
    ...readMigrationStatements(
      nodePath.join(
        DRIZZLE_DIR,
        "20261004001000_matter_membership_organization_membership",
        "migration.sql",
      ),
    ),
    // The effective-policy owner replaces the capacity function above and
    // adds the storage capacity read.
    ...readMigrationStatements(
      nodePath.join(
        DRIZZLE_DIR,
        "20261005090300_organization_effective_policy",
        "migration.sql",
      ),
    ),
  ].filter((statement) =>
    ORGANIZATION_MEMBER_CAPACITY_STATEMENT_PREFIXES.some((prefix) =>
      executableSql(statement).startsWith(prefix),
    ),
  );
  for (const statement of statements) {
    await db.execute(sql.raw(statement));
  }
};

/** Install migration-owned timer signals and grants omitted by schema push. */
export const installPgliteTimeEntryTimerSignals = async (
  db: PgliteSchemaDb,
) => {
  const statements = readMigrationStatements(
    nodePath.join(
      DRIZZLE_DIR,
      "20261003122600_timer_admin_stop",
      "migration.sql",
    ),
  ).filter((statement) => {
    const source = executableSql(statement);
    return (
      source.startsWith("CREATE FUNCTION") ||
      source.startsWith("CREATE TRIGGER") ||
      (/^(?:GRANT|REVOKE)\s/u.test(source) &&
        source.includes('ON "time_entry_timer_states"'))
    );
  });
  for (const statement of statements) {
    await db.execute(sql.raw(statement));
  }
};

/** Install the trigger that derives a playbook's document type key from scope. */
export const installPglitePlaybookDocumentTypeKey = async (
  db: PgliteSchemaDb,
): Promise<void> => {
  const statements = readMigrationStatements(
    nodePath.join(
      DRIZZLE_DIR,
      "20261003125200_playbook_document_type_reference",
      "migration.sql",
    ),
  ).filter((statement) => {
    const source = executableSql(statement);
    return (
      source.startsWith("CREATE FUNCTION") ||
      source.startsWith("CREATE TRIGGER")
    );
  });
  if (statements.length !== 2) {
    panic("Expected the playbook document type key function and trigger");
  }
  for (const statement of statements) {
    await db.execute(sql.raw(statement));
  }
};

/** Install monitoring transition triggers from their owning migrations. */
export const installPgliteSanctionsMonitoringTriggers = async (
  db: PgliteSchemaDb,
) => {
  const statements = [
    "20261003122900_sanctions_monitoring_marks",
    "20261003123000_sanctions_monitoring_backfills",
    "20261004120300_sanctions_drain_retry",
  ]
    .flatMap((migration) =>
      readMigrationStatements(
        nodePath.join(DRIZZLE_DIR, migration, "migration.sql"),
      ),
    )
    .filter((statement) => {
      const source = executableSql(statement);
      return (
        source.startsWith("CREATE FUNCTION") ||
        source.startsWith("CREATE TRIGGER")
      );
    });
  for (const statement of statements) {
    await db.execute(sql.raw(statement));
  }
};

export const installPgliteMigration = async ({
  db,
  migrationPath,
}: {
  db: PgliteSchemaDb;
  migrationPath: string;
}): Promise<void> => {
  const statements = readMigrationStatements(migrationPath);
  for (const statement of statements) {
    const executable = executableSql(statement);
    if (executable.length === 0) {
      continue;
    }
    if (isTransactionControlStatement(executable)) {
      panic(
        "A test-installed migration cannot control Drizzle's outer transaction",
      );
    }
    if (/\bCONCURRENTLY\b/iu.test(executable)) {
      panic(
        "A test-installed migration cannot run concurrent DDL inside Drizzle's transaction",
      );
    }
    if (/^SET LOCAL\b/iu.test(executable)) {
      continue;
    }
    await db.execute(sql.raw(statement));
  }
};

/** Derive public sanctions column grants from the migration rather than mirror them. */
export const readPglitePublicSanctionsGrants = (): string[] => {
  const migration = nodePath.join(
    DRIZZLE_DIR,
    "20261003122400_public_sanctions_reader",
    "migration.sql",
  );
  return readMigrationStatements(migration)
    .map(executableSql)
    .filter((statement) => statement.startsWith("GRANT "));
};

/** Install alias graph invariants which declarative schema push cannot express. */
export const installPgliteDecisionAliases = async (
  db: PgliteSchemaDb,
): Promise<void> => {
  const statements = readMigrationStatements(
    nodePath.join(
      DRIZZLE_DIR,
      "20261003123000_case_law_decision_aliases",
      "migration.sql",
    ),
  ).filter((statement) => {
    const source = executableSql(statement);
    return (
      source.startsWith("CREATE FUNCTION") ||
      source.startsWith("CREATE TRIGGER") ||
      source.startsWith('ALTER TABLE "case_law_decision_aliases" FORCE')
    );
  });
  for (const statement of statements) {
    await db.execute(sql.raw(statement));
  }
};

/** Install the migration-owned verification counter and Prague day function. */
export const installPgliteListVerificationBudgets = async (
  db: PgliteSchemaDb,
): Promise<void> => {
  const statements = readMigrationStatements(
    nodePath.join(
      DRIZZLE_DIR,
      "20261005120400_list_verification_run_caps",
      "migration.sql",
    ),
  ).filter((statement) => {
    const source = executableSql(statement);
    if (source.startsWith("CREATE FUNCTION stella_list_verification_day")) {
      return false;
    }
    return [
      "CREATE FUNCTION",
      "CREATE TRIGGER",
      "REVOKE ALL ON FUNCTION",
      "ALTER TABLE",
    ].some((prefix) => source.startsWith(prefix));
  });
  for (const statement of statements) {
    await db.execute(sql.raw(statement));
  }
};
