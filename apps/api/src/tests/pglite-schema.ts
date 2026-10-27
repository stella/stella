import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { panic } from "better-result";
import { type SQL, sql } from "drizzle-orm";
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
const CLIENT_INVOICES_MIGRATION_PATH = nodePath.join(
  DRIZZLE_DIR,
  "20261026130000_client_invoices",
  "migration.sql",
);
const MATTER_ACCESS_RULE_FUNCTION_MIGRATION_PATH = nodePath.join(
  DRIZZLE_DIR,
  "20261015090000_matter_access_rule_function",
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
const SCHEDULER_PAUSE_BOUND_MIGRATION_PATH = nodePath.join(
  DRIZZLE_DIR,
  "20261022120000_scheduler_pause_bound",
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
const SYNTHETIC_SESSION_MIGRATION_PATH = nodePath.join(
  DRIZZLE_DIR,
  "20261019070000_monitoring_session",
  "migration.sql",
);
const STORED_KEYS_ORGANIZATION_SCOPE_MIGRATION_PATH = nodePath.join(
  DRIZZLE_DIR,
  "20261020000100_stored_keys_organization_scope",
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
const PROVISION_PENDING_SINCE_MIGRATION_PATH = nodePath.join(
  DRIZZLE_DIR,
  "20261010110000_case_law_provision_pending_since",
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
 * (migration 20260901130000) and `search_fold` (migration 20261026210000)
 * cannot be installed verbatim. This double is generated from the fold table
 * the unaccent parity test pins against the real extension: NFD plus
 * combining-mark removal for everything Unicode can decompose, then the
 * table's rules for the letters it cannot (`ł`, `ß`, `ø`). It approximates
 * the extension for Latin text only; the Postgres suites hold the real one.
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

const FOLD_FUNCTIONS = ["legislation_title_fold", "search_fold"] as const;

const foldFunctionPgliteSql = (name: (typeof FOLD_FUNCTIONS)[number]): string =>
  `CREATE OR REPLACE FUNCTION ${name}(input text)
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

const READER_ANNOTATION_MATTER_ROW_FUNCTIONS = [
  "legal_reader_annotation_claim_visible",
  "legal_reader_annotation_claim_held",
  "legal_reader_annotation_document_visible",
  "legal_reader_annotation_document_held",
] as const;

export const installPgliteSchemaPrerequisites = async (
  db: PgliteSchemaDb,
): Promise<void> => {
  await db.execute(sql.raw("CREATE EXTENSION IF NOT EXISTS pg_trgm"));
  await db.execute(sql.raw(arabicNormalizeFunctionSql()));
  await db.execute(sql.raw(unaccentPgliteSql()));
  for (const name of FOLD_FUNCTIONS) {
    await db.execute(sql.raw(foldFunctionPgliteSql(name)));
  }
  await db.execute(sql.raw(fieldFindTextFunctionSql()));
  await db.execute(
    sql.raw(
      latestMigrationStatementContaining(
        "CREATE FUNCTION stella_list_verification_day",
      ),
    ),
  );
  const invoiceAccessDefinition =
    readMigrationStatements(CLIENT_INVOICES_MIGRATION_PATH)
      .map(executableSql)
      .find((statement) =>
        statement.startsWith("CREATE FUNCTION public.stella_invoice_access("),
      ) ?? panic("Invoice access migration function is missing");
  // Its signature must exist before schema policies; no data can be read until
  // the migration-owned body replaces this deny-all bootstrap implementation.
  await db.execute(
    sql.raw(
      invoiceAccessDefinition
        .replace(/CREATE FUNCTION/u, "CREATE OR REPLACE FUNCTION")
        .replace(/AS \$\$[\s\S]*\$\$;/u, () => "AS $$ SELECT false $$;"),
    ),
  );
  // The reader-annotation policies call these claim and document checks, so
  // they must exist before the push creates the policies; their bodies name
  // tables the push creates afterwards, so body validation waits for first use.
  await db.execute(sql.raw("SET check_function_bodies = off"));
  for (const name of READER_ANNOTATION_MATTER_ROW_FUNCTIONS) {
    await db.execute(
      sql.raw(
        latestMigrationStatementContaining(
          `CREATE OR REPLACE FUNCTION public.${name}(uuid, uuid, uuid)`,
        ),
      ),
    );
  }
  await db.execute(sql.raw("RESET check_function_bodies"));
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
    MATTER_ACCESS_RULE_FUNCTION_MIGRATION_PATH,
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

/** Install the dedicated principal membership trigger omitted by schema push. */
export const installPgliteSyntheticMembershipTrigger = async (
  db: PgliteSchemaDb,
): Promise<void> => {
  const statements = readMigrationStatements(
    SYNTHETIC_SESSION_MIGRATION_PATH,
  ).filter((statement) => {
    const source = executableSql(statement);
    return (
      source.startsWith("CREATE FUNCTION enforce_synthetic_membership") ||
      source.startsWith(
        "REVOKE ALL ON FUNCTION enforce_synthetic_membership",
      ) ||
      source.startsWith("CREATE TRIGGER member_synthetic_organization_check")
    );
  });
  if (statements.length !== 3) {
    panic("Expected the dedicated principal membership function and trigger");
  }
  for (const statement of statements) {
    await db.execute(sql.raw(statement));
  }
};

/** Install the organization-owned user-file key guard omitted by schema push. */
export const installPgliteUserFileOrganizationKeyGuard = async (
  db: PgliteSchemaDb,
): Promise<void> => {
  const statements = readFileSync(
    STORED_KEYS_ORGANIZATION_SCOPE_MIGRATION_PATH,
    "utf-8",
  ).match(
    /CREATE FUNCTION public\.user_files_enforce_organization_key\(\)[\s\S]*?\n\$\$;|CREATE TRIGGER user_files_organization_key_guard[\s\S]*?;/gu,
  );
  if (statements?.length !== 2) {
    panic("Expected the user-file organization key function and trigger");
  }
  for (const statement of statements) {
    await db.execute(sql.raw(statement));
  }
};

export const installPgliteAiMemoryActiveUserGuard = async (
  db: PgliteSchemaDb,
): Promise<void> => {
  await installPgliteMigration({
    db,
    migrationPath: nodePath.join(
      DRIZZLE_DIR,
      "20261018050200_ai_memory_active_user_guard",
      "migration.sql",
    ),
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

/** Install the scheduler pause triggers omitted by declarative schema push. */
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
  // The 72-hour bound and the recorded start of a pause.
  const bound = readMigrationStatements(
    SCHEDULER_PAUSE_BOUND_MIGRATION_PATH,
  ).filter((statement) => {
    const executable = executableSql(statement);
    return (
      executable.startsWith(
        "CREATE FUNCTION public.scheduler_job_pause_bound",
      ) || executable.startsWith("CREATE TRIGGER scheduler_job_pause_bound")
    );
  });
  for (const statement of [...statements, ...bound]) {
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

/** Apply the account audit migration's forced user boundary after schema push. */
export const installPgliteAccountAuditRls = async (
  db: PgliteSchemaDb,
): Promise<void> => {
  const statement = readMigrationStatements(
    nodePath.join(
      DRIZZLE_DIR,
      "20261010005100_account_audit_scope",
      "migration.sql",
    ),
  ).find((candidate) =>
    executableSql(candidate).startsWith(
      'ALTER TABLE "account_audit_logs" FORCE ROW LEVEL SECURITY',
    ),
  );
  if (statement === undefined) {
    panic("Account audit FORCE RLS migration statement is missing");
  }
  await db.execute(sql.raw(statement));
};

/** Apply the revision migration's forced boundary, which schema push omits. */
export const installPgliteChatMessageRevisionsRls = async (
  db: PgliteSchemaDb,
): Promise<void> => {
  const statement = readMigrationStatements(
    nodePath.join(
      DRIZZLE_DIR,
      "20261009190430_chat_message_revisions",
      "migration.sql",
    ),
  ).find((candidate) =>
    executableSql(candidate).startsWith(
      'ALTER TABLE "chat_message_revisions" FORCE ROW LEVEL SECURITY',
    ),
  );
  if (statement === undefined) {
    panic("Chat message revision FORCE RLS migration statement is missing");
  }
  await db.execute(sql.raw(statement));
};

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

/** Apply the committed settings omitted by schema push. */
const READER_ANNOTATION_MATTER_ROW_STATEMENTS = [
  {
    migration: "20261021080000_reader_annotation_verification_claims",
    prefixes: [
      'ALTER TABLE "legal_reader_annotations" FORCE ROW LEVEL SECURITY',
      'CREATE OR REPLACE FUNCTION "legal_reader_annotations_drop_claim_comments"',
      'REVOKE ALL ON FUNCTION "legal_reader_annotations_drop_claim_comments"',
      'CREATE TRIGGER "legal_list_claims_drop_reader_comments"',
    ],
  },
  {
    migration: "20261026120000_reader_annotation_matter_documents",
    prefixes: [
      'CREATE OR REPLACE FUNCTION "legal_reader_annotations_drop_document_marks"',
      'REVOKE ALL ON FUNCTION "legal_reader_annotations_drop_document_marks"',
      'CREATE TRIGGER "entities_drop_reader_annotations"',
    ],
  },
] as const;

// The push creates the matter-note columns and policies; the forced RLS and
// the claim and document cleanup triggers exist only in the migrations.
export const installPgliteReaderAnnotationMatterRows = async (
  db: PgliteSchemaDb,
): Promise<void> => {
  for (const {
    migration,
    prefixes,
  } of READER_ANNOTATION_MATTER_ROW_STATEMENTS) {
    const statements = readMigrationStatements(
      nodePath.join(DRIZZLE_DIR, migration, "migration.sql"),
    );
    for (const prefix of prefixes) {
      const statement = statements.find((candidate) =>
        executableSql(candidate).startsWith(prefix),
      );
      if (statement === undefined) {
        panic(`Reader annotation matter statement is missing: ${prefix}`);
      }
      await db.execute(sql.raw(statement));
    }
  }
};

export const installPgliteReaderAnswerRls = async (
  db: PgliteSchemaDb,
): Promise<void> => {
  const statements = readMigrationStatements(
    nodePath.join(
      DRIZZLE_DIR,
      "20261010212100_reader_answers",
      "migration.sql",
    ),
  );
  for (const table of [
    "legal_reader_answers",
    "legal_reader_answer_messages",
  ]) {
    const statement = statements.find((candidate) =>
      executableSql(candidate).startsWith(
        `ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`,
      ),
    );
    if (statement === undefined) {
      panic(`Reader answer FORCE RLS migration statement is missing: ${table}`);
    }
    await db.execute(sql.raw(statement));
  }
};

/** Apply the committed setting omitted by schema push. */
export const installPgliteCitationDoctrineRls = async (
  db: PgliteSchemaDb,
): Promise<void> => {
  const statements = readMigrationStatements(
    nodePath.join(
      DRIZZLE_DIR,
      "20261014174500_case_law_citation_doctrine",
      "migration.sql",
    ),
  );
  const statement = statements.find((candidate) =>
    executableSql(candidate).startsWith(
      'ALTER TABLE "case_law_citation_doctrine_reviews" FORCE ROW LEVEL SECURITY',
    ),
  );
  if (statement === undefined) {
    panic("Citation doctrine FORCE RLS migration statement is missing");
  }
  await db.execute(sql.raw(statement));
};

/** Apply the committed setting omitted by schema push. */
export const installPgliteChatSecretRls = async (
  db: PgliteSchemaDb,
): Promise<void> => {
  const statements = readMigrationStatements(
    nodePath.join(DRIZZLE_DIR, "20261008090000_chat_secrets", "migration.sql"),
  );
  for (const table of ["chat_secrets"]) {
    const statement = statements.find((candidate) =>
      executableSql(candidate).startsWith(
        `ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`,
      ),
    );
    if (statement === undefined) {
      panic("Chat secret FORCE RLS migration statement is missing");
    }
    await db.execute(sql.raw(statement));
  }
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
const STATUTE_CITATION_PROJECTION_MIGRATIONS = [
  "20261010212100_case_law_publication_filter",
  "20261022230000_provision_citation_anchor_lineage",
] as const;

const definedFunctionsOf = (migration: string): string[] =>
  Array.from(
    readFileSync(
      nodePath.join(DRIZZLE_DIR, migration, "migration.sql"),
      "utf-8",
    ).matchAll(/CREATE OR REPLACE FUNCTION "([^"]+)"/gu),
    ([, name]) => name ?? "",
  );

/**
 * The projection's migrations, then every later one that redefines a
 * function they install, oldest first: the schema runs the newest definition
 * of each, and no redefinition can be left out of the replay.
 */
const statuteCitationProjectionMigrations = (): string[] => {
  const installed = new Set(
    STATUTE_CITATION_PROJECTION_MIGRATIONS.flatMap(definedFunctionsOf),
  );
  const last = STATUTE_CITATION_PROJECTION_MIGRATIONS.at(-1) ?? "";
  const later = readdirSync(DRIZZLE_DIR)
    .filter((name) => /^\d{14}_/u.test(name) && name > last)
    .toSorted()
    .filter((name) =>
      definedFunctionsOf(name).some((defined) => installed.has(defined)),
    );
  return [...STATUTE_CITATION_PROJECTION_MIGRATIONS, ...later];
};

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
  for (const migration of statuteCitationProjectionMigrations()) {
    for (const statement of readMigrationStatements(
      nodePath.join(DRIZZLE_DIR, migration, "migration.sql"),
    ).filter((candidate) => !executableSql(candidate).startsWith("SET "))) {
      await db.execute(sql.raw(statement));
    }
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
    PROVISION_PENDING_SINCE_MIGRATION_PATH,
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

const SERVICE_OAUTH_CLIENTS_MIGRATION_PATH = nodePath.join(
  DRIZZLE_DIR,
  "20261009190500_service_oauth_clients",
  "migration.sql",
);
const SERVICE_CLIENT_CREDENTIAL_STATEMENT_PREFIXES = [
  "CREATE FUNCTION",
  "CREATE TRIGGER",
] as const;

/** Install the trigger that removes a service binding's credential with it. */
export const installPgliteServiceClientCredentialCascade = async (
  db: PgliteSchemaDb,
): Promise<void> => {
  const statements = readMigrationStatements(
    SERVICE_OAUTH_CLIENTS_MIGRATION_PATH,
  ).filter((statement) =>
    SERVICE_CLIENT_CREDENTIAL_STATEMENT_PREFIXES.some((prefix) =>
      executableSql(statement).startsWith(prefix),
    ),
  );
  for (const statement of statements) {
    await db.execute(sql.raw(statement));
  }
};

/** Install the country invariant directly from its committed migration. */
export const installPgliteCaseLawCountryShape = async (
  db: PgliteSchemaDb,
): Promise<void> => {
  const statements = readMigrationStatements(
    nodePath.join(
      DRIZZLE_DIR,
      "20261016010000_case_law_country_uppercase",
      "migration.sql",
    ),
  );
  for (const statement of statements) {
    const source = executableSql(statement);
    if (
      source.startsWith("CREATE OR REPLACE FUNCTION") ||
      source.startsWith("DROP TRIGGER") ||
      source.startsWith("CREATE TRIGGER")
    ) {
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
  )
    .concat(
      readMigrationStatements(
        nodePath.join(
          DRIZZLE_DIR,
          "20261019091000_legislation_publisher_identity",
          "migration.sql",
        ),
      ),
    )
    .filter((statement) =>
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

/** Install parsed-input invalidation from the production migration after schema push. */
export const installPgliteCaseLawParsedSourceInvalidation = async (
  db: PgliteSchemaDb,
): Promise<void> => {
  const statements = readMigrationStatements(
    nodePath.join(
      DRIZZLE_DIR,
      "20261022120000_case_law_batch_slots",
      "migration.sql",
    ),
  ).filter((statement) => {
    const source = executableSql(statement);
    return (
      source.startsWith("CREATE FUNCTION invalidate_case_law_parsed_source") ||
      source.startsWith(
        "CREATE TRIGGER case_law_decisions_parsed_source_invalidation",
      )
    );
  });
  if (statements.length !== 2) {
    panic("Expected the parsed-source invalidation function and trigger");
  }
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
    // A missing access state admits only the creation membership.
    ...readMigrationStatements(
      nodePath.join(
        DRIZZLE_DIR,
        "20261023160000_organization_access_state_origin",
        "migration.sql",
      ),
    ),
    ...readMigrationStatements(
      nodePath.join(
        DRIZZLE_DIR,
        "20261025104500_per_seat_member_capacity",
        "migration.sql",
      ),
    ),
    ...readMigrationStatements(
      nodePath.join(
        DRIZZLE_DIR,
        "20261025120000_manual_entitlement_period_bound",
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
  const statements = [
    "20261003123000_case_law_decision_aliases",
    "20261020130000_cross_source_decision_aliases",
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
        source.startsWith("CREATE OR REPLACE FUNCTION") ||
        source.includes(
          "CREATE OR REPLACE FUNCTION public.case_law_decision_alias_validate",
        ) ||
        source.startsWith("CREATE TRIGGER") ||
        source.startsWith('ALTER TABLE "case_law_decision_aliases" FORCE')
      );
    });
  for (const statement of statements) {
    await db.execute(sql.raw(statement));
  }
};

/** Use the committed SQL for the projection that schema push cannot install. */
export const installPgliteDecisionCitationStats = async (
  db: PgliteSchemaDb,
): Promise<void> => {
  for (const statement of readMigrationStatements(
    nodePath.join(
      DRIZZLE_DIR,
      "20261005120200_decision_citation_stats",
      "migration.sql",
    ),
  ).filter((candidate) => {
    const text = executableSql(candidate);
    return (
      text.startsWith("CREATE FUNCTION") ||
      text.startsWith("CREATE TRIGGER") ||
      text.startsWith("REVOKE ALL ON FUNCTION") ||
      text.startsWith("GRANT EXECUTE ON FUNCTION")
    );
  })) {
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

/** Install invoice authorization and guards from the production migration after schema push. */
export const installPgliteInvoiceObjects = async (
  db: PgliteSchemaDb,
): Promise<void> => {
  const statements = readMigrationStatements(CLIENT_INVOICES_MIGRATION_PATH)
    .map(executableSql)
    .filter((statement) =>
      /^(?:CREATE FUNCTION|REVOKE ALL ON FUNCTION|GRANT EXECUTE ON FUNCTION|CREATE TRIGGER|CREATE POLICY)/u.test(
        statement,
      ),
    );
  for (const statement of statements) {
    const policy = /^CREATE POLICY (?<name>\w+) ON (?<table>\w+)/u.exec(
      statement,
    )?.groups;
    if (policy?.["name"] !== undefined && policy["table"] !== undefined) {
      // Schema push already created policies; workspace-access replay can also
      // replace them, so reinstall the owning migration's final definitions.
      await db.execute(
        sql.raw(
          `DROP POLICY IF EXISTS ${policy["name"]} ON ${policy["table"]}`,
        ),
      );
    }
    await db.execute(
      sql.raw(
        statement.replace(/^CREATE FUNCTION/u, "CREATE OR REPLACE FUNCTION"),
      ),
    );
  }
};
