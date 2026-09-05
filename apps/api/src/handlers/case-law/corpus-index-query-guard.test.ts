import { expect, test } from "bun:test";
import { getTableName } from "drizzle-orm";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import nodePath from "node:path";

import {
  CASE_LAW_CORPUS_INDEX_BACKFILL_STATUSES,
  CASE_LAW_CORPUS_INDEX_PROJECTION_ACTIONS,
} from "@/api/db/schema";
import { CORPUS_INDEX_SOURCE_TABLES } from "@/api/lib/legal-search/corpus-index-generation-store";
import { CORPUS_LICENSES } from "@/api/lib/legal-search/corpus-source";

const caseLawCorpusIndexSource = new URL("corpus-index.ts", import.meta.url);
const caseLawErasureSource = new URL("erasure.ts", import.meta.url);
const caseLawWithdrawalSource = new URL(
  "withdraw-document.ts",
  import.meta.url,
);
const caseLawSchemaSource = new URL(
  "../../db/schema/case-law.ts",
  import.meta.url,
);
const publicSearchSource = new URL("decisions/search.ts", import.meta.url);
const sharedSearchProviderSource = new URL(
  "../../lib/legal-search/corpus-index-provider.ts",
  import.meta.url,
);
const caseLawCorpusProjectionSource = new URL(
  "../../lib/legal-search/case-law-corpus-projection.ts",
  import.meta.url,
);
const generationMigrationSource = new URL(
  "../../../drizzle/20260731170000_case_law_corpus_generation_backfill/migration.sql",
  import.meta.url,
);
const ingestionSourceGrantMigration = new URL(
  "../../../drizzle/20260731210000_case_law_ingestion_source_grants/migration.sql",
  import.meta.url,
);
const ingestionSourceLeaseMigration = new URL(
  "../../../drizzle/20260801120000_case_law_source_ingestion_lease/migration.sql",
  import.meta.url,
);
const DRIZZLE_DIR = nodePath.resolve(import.meta.dir, "../../../drizzle");
const SHARE_LOCK_PATTERN = /LOCK TABLE (?<tables>[^`]*?) IN SHARE MODE/u;
const DRIZZLE_TABLE_REFERENCE_PATTERN = /\$\{(?<identifier>\w+)\}/gu;
const PG_TABLE_DECLARATION_PATTERN =
  /export const (?<identifier>\w+) = (?:p\.)?pgTable\(\s*"(?<table>\w+)"/gu;
const TABLE_PRIVILEGE_PATTERN =
  /^(?<action>GRANT|REVOKE) (?<privileges>.+?) ON TABLE (?<tables>.+?) (?:TO|FROM) (?<roles>.+)$/iu;
// Dropping a table takes its grants with it, so a recreated table starts bare.
const DROP_TABLE_PATTERN =
  /^DROP TABLE (?:IF EXISTS )?(?<tables>.+?)(?: CASCADE| RESTRICT)?$/iu;
// PostgreSQL admits SHARE MODE only for a role holding one of these at table
// level; a column-scoped grant does not satisfy the check.
const LOCK_CONFERRING_PRIVILEGES = [
  "UPDATE",
  "DELETE",
  "TRUNCATE",
  "MAINTAIN",
] as const;

// Timestamp-prefixed directory names, so lexical order is apply order. The
// replay below depends on it.
const migrationStatements = (): string[] =>
  readdirSync(DRIZZLE_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .map((name) => nodePath.join(DRIZZLE_DIR, name, "migration.sql"))
    .filter((file) => existsSync(file))
    .flatMap((file) =>
      readFileSync(file, "utf-8")
        .split(/\r?\n/u)
        .map((line) => {
          const commentStart = line.indexOf("--");
          return commentStart === -1 ? line : line.slice(0, commentStart);
        })
        .join("\n")
        .split(";")
        .map((statement) => statement.replace(/\s+/gu, " ").trim())
        .filter((statement) => statement.length > 0),
    );

const identifierList = (list: string): string[] =>
  list.split(",").map((entry) => entry.trim().replaceAll('"', ""));

const lockPrivilegesNamed = (privileges: string): string[] => {
  const upper = privileges.toUpperCase();
  if (upper === "ALL" || upper === "ALL PRIVILEGES") {
    return [...LOCK_CONFERRING_PRIVILEGES];
  }

  const named = identifierList(upper);
  return LOCK_CONFERRING_PRIVILEGES.filter((privilege) =>
    named.includes(privilege),
  );
};

// Replay every table-level GRANT/REVOKE touching the role in apply order: an
// earlier grant that a later migration revokes must not count as held.
const ingestionLockPrivileges = (table: string): string[] => {
  const held = new Set<string>();
  for (const statement of migrationStatements()) {
    const dropped = DROP_TABLE_PATTERN.exec(statement)?.groups?.["tables"];
    if (dropped !== undefined && identifierList(dropped).includes(table)) {
      held.clear();
      continue;
    }

    const { action, privileges, roles, tables } =
      TABLE_PRIVILEGE_PATTERN.exec(statement)?.groups ?? {};
    if (
      action === undefined ||
      privileges === undefined ||
      roles === undefined ||
      tables === undefined ||
      // A parenthesised column list marks the change column-scoped.
      privileges.includes("(") ||
      !identifierList(roles).includes("stella_ingestion") ||
      !identifierList(tables).includes(table)
    ) {
      continue;
    }

    for (const privilege of lockPrivilegesNamed(privileges)) {
      if (action.toUpperCase() === "GRANT") {
        held.add(privilege);
        continue;
      }
      held.delete(privilege);
    }
  }

  return [...held];
};

test("every corpus source activation lock has an ingestion-role privilege", () => {
  for (const table of Object.values(CORPUS_INDEX_SOURCE_TABLES)) {
    expect(ingestionLockPrivileges(getTableName(table))).not.toHaveLength(0);
  }
});

const GENERATION_STATE_TABLES = [
  "case_law_corpus_index_backfills",
  "case_law_corpus_index_source_reconciliations",
  "case_law_corpus_index_writer_leases",
  "case_law_corpus_index_projections",
] as const;

test("case-law incremental corpus scans never select a generation inequality", async () => {
  const source = await Bun.file(caseLawCorpusIndexSource).text();
  // A generation cutover must be a durable keyset walk. `<>` turns its
  // selector into a corpus-wide scan and can starve request traffic.
  expect(source).not.toMatch(/indexedGeneration\}[^`]*<>/su);
  expect(source).not.toMatch(/indexed_generation[^`]*<>/su);
  expect(source).toMatch(
    /sql`LOCK TABLE \$\{caseLawDecisions\}, \$\{caseLawSources\} IN SHARE MODE`/u,
  );
});

test("a restore racing erasure is durably requeued", async () => {
  const source = await Bun.file(caseLawErasureSource).text();
  const generationValidation = source.indexOf(
    "if (!isCaseLawCorpusGeneration(generation)) {",
  );
  const firstIrreversibleMutation = source.indexOf(
    "await removeDecisionFromIndex(decisionId, scopedDb);",
  );
  const storedTargetValidation = source.indexOf(
    "const storedIndexTarget = (() => {",
  );
  const branchStart = source.indexOf("if (!stillErased) {");
  const branchEnd = source.indexOf("return;", branchStart);

  expect(generationValidation).toBeGreaterThanOrEqual(0);
  expect(storedTargetValidation).toBeGreaterThan(generationValidation);
  expect(firstIrreversibleMutation).toBeGreaterThan(generationValidation);
  expect(firstIrreversibleMutation).toBeGreaterThan(storedTargetValidation);
  expect(branchStart).toBeGreaterThanOrEqual(0);
  expect(branchEnd).toBeGreaterThan(branchStart);
  expect(source.slice(branchStart, branchEnd)).toContain(
    ".set({ indexedAt: null, indexedHash: null })",
  );
  expect(source).toContain("auditedViaCorpusIndex = targets.size > 0");
  expect(source).toContain(
    "pendingRevision: caseLawCorpusIndexProjections.pendingRevision",
  );
  expect(source).toContain(
    "eq(\n                        caseLawCorpusIndexProjections.pendingRevision,\n                        projection.pendingRevision,",
  );
});

test("withdrawal clears pointers only once the objects are gone", async () => {
  // The same ordering the redaction holds to, for the same reason: a
  // pointer cleared before its object is deleted leaves an object nothing
  // names and no way to retry the delete. Kept in its own module so this
  // and the redaction guards each read one function.
  const source = await Bun.file(caseLawWithdrawalSource).text();
  const rowFence = source.indexOf('.for("update")');
  const intentFence = source.indexOf(
    "cancelCaseLawCorpusUploadIntents",
    rowFence,
  );
  const erasure = source.indexOf("corpusErasure = await eraseCorpusObjects({");
  const incompleteReturn = source.indexOf(
    'return { type: "corpus-objects-remain", error: corpusErasure.error };',
  );
  const pointerClear = source.indexOf(
    ".set({ textS3Key: null, normalizedS3Key: null, astS3Key: null })",
  );

  expect(rowFence).toBeGreaterThan(-1);
  expect(intentFence).toBeGreaterThan(rowFence);
  expect(erasure).toBeGreaterThan(intentFence);
  expect(incompleteReturn).toBeGreaterThan(erasure);
  expect(pointerClear).toBeGreaterThan(incompleteReturn);
  // A withdrawal is not a takedown: the row must keep its tombstone column
  // clear, or the decision could never be replayed into a document again.
  expect(source).not.toContain("redactedAt");
});

test("redaction fences uploads before inspecting or deleting object keys", async () => {
  const source = await Bun.file(caseLawErasureSource).text();
  const rowFence = source.indexOf('.for("update")');
  const tombstone = source.indexOf("redactedAt:", rowFence);
  const intentFence = source.indexOf(
    "cancelCaseLawCorpusUploadIntents",
    tombstone,
  );
  const objectDelete = source.indexOf("deleteCorpusDocument", intentFence);

  expect(rowFence).toBeGreaterThan(-1);
  expect(tombstone).toBeGreaterThan(rowFence);
  expect(intentFence).toBeGreaterThan(tombstone);
  expect(objectDelete).toBeGreaterThan(intentFence);
});

test("pointer columns and the success audit depend on every corpus object being gone", async () => {
  const source = await Bun.file(caseLawErasureSource).text();
  const erasure = source.indexOf("corpusErasure = await eraseCorpusObjects({");
  const incompleteAudit = source.indexOf(
    "await recordFailedRedactionAudit({",
    erasure,
  );
  const pointerClear = source.indexOf(
    ".set({ textS3Key: null, normalizedS3Key: null, astS3Key: null })",
  );
  const pointerGuard = source.lastIndexOf(
    'if (corpusErasure.type === "deleted") {',
    pointerClear,
  );
  const incompleteReturn = source.indexOf(
    'return { type: "corpus-objects-remain", error: corpusErasure.error };',
  );
  const successAudit = source.indexOf('status: "succeeded"');

  expect(erasure).toBeGreaterThan(-1);
  expect(incompleteAudit).toBeGreaterThan(erasure);
  expect(pointerGuard).toBeGreaterThan(incompleteAudit);
  expect(pointerClear).toBeGreaterThan(pointerGuard);
  expect(incompleteReturn).toBeGreaterThan(pointerClear);
  expect(successAudit).toBeGreaterThan(incompleteReturn);
});

test("lease acquisition failures are audited after local redaction", async () => {
  const source = await Bun.file(caseLawErasureSource).text();
  const firstIrreversibleMutation = source.indexOf(
    "await removeDecisionFromIndex(decisionId, scopedDb);",
  );
  const rejectedClaim = source.indexOf("if (claimRejected) {");
  const rejectedClaimAudit = source.indexOf(
    "await recordFailedRedactionAudit({",
    rejectedClaim,
  );
  const rejectedClaimThrow = source.indexOf(
    "throw firstClaimError;",
    rejectedClaim,
  );

  expect(rejectedClaim).toBeGreaterThan(firstIrreversibleMutation);
  expect(rejectedClaimAudit).toBeGreaterThan(rejectedClaim);
  expect(rejectedClaimThrow).toBeGreaterThan(rejectedClaimAudit);
});

test("generation checkpoint migration preserves replay and role invariants", async () => {
  const [source, schemaSource] = await Promise.all([
    Bun.file(generationMigrationSource).text(),
    Bun.file(caseLawSchemaSource).text(),
  ]);

  for (const table of GENERATION_STATE_TABLES) {
    expect(source).toContain(
      `ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`,
    );
    expect(source).toContain(
      `GRANT SELECT, INSERT, UPDATE, DELETE\n  ON TABLE "${table}" TO stella_ingestion`,
    );
    expect(
      source.match(new RegExp(`tablename = '${table}'`, "gu")),
    ).toHaveLength(2);
  }
  expect(source).toContain(
    'CONSTRAINT "case_law_corpus_index_projections_pk" PRIMARY KEY ("generation", "decision_id")',
  );
  expect(source).toContain(
    'CREATE INDEX IF NOT EXISTS "case_law_corpus_index_backfills_order_generation_idx"\n  ON "case_law_corpus_index_backfills" ("generation_order", "generation")',
  );
  expect(schemaSource).toContain(
    '.index("case_law_corpus_index_backfills_order_generation_idx")\n      .on(t.generationOrder, t.generation)',
  );
  expect(source).toContain('"generation_order" integer GENERATED ALWAYS AS');
  expect(source.match(/newer\.generation_order/gu)).toHaveLength(3);
  expect(source).not.toContain("newer.snapshot_at");
  expect(source).toContain(
    'CREATE INDEX IF NOT EXISTS "case_law_corpus_index_source_reconciliations_source_idx"\n  ON "case_law_corpus_index_source_reconciliations" ("source_id")',
  );
  expect(schemaSource).toContain(
    '.index("case_law_corpus_index_source_reconciliations_source_idx")\n      .on(t.sourceId)',
  );
  for (const constraint of [
    "case_law_corpus_index_source_reconciliations_pk",
    "case_law_corpus_index_source_reconciliations_generation_fk",
    "case_law_corpus_index_source_reconciliations_source_fk",
  ]) {
    expect(source).toContain(`CONSTRAINT "${constraint}"`);
    expect(schemaSource).toContain(`name: "${constraint}"`);
  }
  expect(source).toContain(
    'CONSTRAINT "case_law_corpus_index_source_reconciliations_upper_pair"',
  );
  expect(schemaSource).toContain(
    '"case_law_corpus_index_source_reconciliations_upper_pair"',
  );
  expect(source).toContain(
    'CONSTRAINT "case_law_source_reconciliations_cursor_upper"',
  );
  expect(schemaSource).toContain(
    '"case_law_source_reconciliations_cursor_upper"',
  );
  expect(source).toContain(
    "CREATE OR REPLACE FUNCTION enforce_case_law_sources_descriptor_shape()",
  );
  expect(source).toContain("BEFORE INSERT OR UPDATE OF descriptor");
  expect(source).toContain("NEW.descriptor IS DISTINCT FROM OLD.descriptor");
  expect(source).toContain(
    "jsonb_typeof(NEW.descriptor -> 'allowsRedistribution') = 'boolean'",
  );
  expect(source).toContain("CONSTRAINT = 'case_law_sources_descriptor_shape'");
  expect(schemaSource).not.toContain('"case_law_sources_descriptor_shape"');
  for (const license of CORPUS_LICENSES) {
    expect(source).toContain(`'${license}'`);
  }
  expect(source).toContain(
    "AFTER INSERT OR UPDATE OF content_hash, indexed_hash, country",
  );
  expect(source).toContain("AFTER UPDATE OF descriptor");
  expect(source).not.toContain(
    "coalesce(NEW.descriptor ->> 'allowsRedistribution', 'true')",
  );
  expect(source).toContain(
    "OR (NEW.descriptor ->> 'allowsRedistribution') = 'true'",
  );
  expect(source).toContain(
    "SET revision = case_law_corpus_index_source_reconciliations.revision + 1",
  );
  expect(source).toContain("cursor_created_at = null");
  expect(source).toContain("cursor_id = null");
  expect(source).toContain("upper_created_at = EXCLUDED.upper_created_at");
  expect(source).toContain("upper_id = EXCLUDED.upper_id");
  expect(source).toContain("LEFT JOIN LATERAL (");
  expect(source).toContain(
    "ORDER BY decision.created_at DESC, decision.id DESC",
  );
  expect(
    source.match(
      /ON CONFLICT ON CONSTRAINT case_law_corpus_index_projections_pk DO UPDATE/gu,
    ),
  ).toHaveLength(2);
  expect(source).not.toContain("ON CONFLICT (");
  expect(source).toContain("pending_hash = EXCLUDED.pending_hash");
  expect(source).toContain(
    "\"pending_index_ids\" varchar(64)[] DEFAULT '{}'::varchar(64)[] NOT NULL",
  );
  expect(source).toContain('"pending_revision" integer DEFAULT 0 NOT NULL');
  expect(source).toContain(
    'ADD COLUMN IF NOT EXISTS "pending_revision" integer DEFAULT 0 NOT NULL',
  );
  expect(source).toContain(
    'CONSTRAINT "case_law_corpus_index_projections_pending_revision_nonnegative"',
  );
  expect(source).toContain(
    "conname = 'case_law_corpus_index_projections_pending_revision_nonnegative'",
  );
  expect(source).toContain(
    "conrelid = 'case_law_corpus_index_projections'::regclass",
  );
  expect(schemaSource).toContain(
    '"case_law_corpus_index_projections_pending_revision_nonnegative"',
  );
  expect(source).toContain("pending_index_ids = ARRAY(");
  expect(source).toContain(
    "case_law_corpus_index_projections.pending_index_ids",
  );
  expect(source).toContain("pending_action = EXCLUDED.pending_action");
  expect(source).toContain("'delete', null, '{}', 1, clock_timestamp()");
  expect(
    source.match(
      /pending_revision = case_law_corpus_index_projections\.pending_revision \+ 1/gu,
    ),
  ).toHaveLength(2);
  expect(source.match(/existing\.decision_id = NEW\.id/gu)).toHaveLength(2);
  expect(source).toContain("existing_decision.source_id = NEW.id");
  expect(source).toContain(
    "NEW.indexed_generation =\n          (projection.generation || '_' || lower(NEW.country))",
  );
  for (const action of CASE_LAW_CORPUS_INDEX_PROJECTION_ACTIONS) {
    expect(source).toContain(`"pending_action" = '${action}'`);
  }
  expect(source).toContain(
    'DROP INDEX CONCURRENTLY IF EXISTS "case_law_decisions_corpus_generation_cursor_idx"',
  );
  expect(source).toContain(
    'CREATE INDEX CONCURRENTLY "case_law_decisions_corpus_generation_cursor_idx"\n  ON "case_law_decisions" ("created_at", "id")',
  );
  expect(source).toContain(
    'CREATE INDEX IF NOT EXISTS "case_law_corpus_index_projections_decision_idx"\n  ON "case_law_corpus_index_projections" ("decision_id")',
  );
  for (const alteration of [
    'ALTER TABLE "case_law_decisions" ALTER COLUMN "indexed_generation" SET DATA TYPE varchar(64)',
    'ALTER TABLE "case_law_index_jobs" ALTER COLUMN "generation" SET DATA TYPE varchar(64)',
    'ALTER TABLE "legislation_documents" ALTER COLUMN "indexed_generation" SET DATA TYPE varchar(64)',
    'ALTER TABLE "legislation_index_jobs" ALTER COLUMN "generation" SET DATA TYPE varchar(64)',
  ]) {
    expect(source).toContain(alteration);
  }
  expect(source).toContain(
    'CREATE INDEX CONCURRENTLY "case_law_decisions_source_generation_cursor_idx"\n  ON "case_law_decisions" ("source_id", "created_at", "id")',
  );
  expect(source).toContain(
    'CREATE INDEX CONCURRENTLY "case_law_decisions_corpus_hash_pending_idx"\n  ON "case_law_decisions" ("id")\n  WHERE "content_hash" IS NOT NULL AND "indexed_hash" IS NULL',
  );
  expect(source).toContain(
    'CREATE INDEX CONCURRENTLY "legislation_documents_corpus_hash_pending_idx"\n  ON "legislation_documents" ("id")\n  WHERE "content_hash" IS NOT NULL AND "indexed_hash" IS NULL',
  );
  expect(source).not.toContain(
    'DROP INDEX CONCURRENTLY IF EXISTS "case_law_decisions_corpus_pending_idx"',
  );
  expect(source).not.toContain(
    'DROP INDEX CONCURRENTLY IF EXISTS "legislation_documents_corpus_pending_idx"',
  );
  expect(source).toContain(
    `CHECK ("status" IN (${CASE_LAW_CORPUS_INDEX_BACKFILL_STATUSES.map(
      (status) => `'${status}'`,
    ).join(",")}))`,
  );
  expect(source).toContain(
    'ALTER COLUMN "created_at" SET DEFAULT clock_timestamp()',
  );
  expect(source).toContain(
    "CREATE OR REPLACE FUNCTION enforce_case_law_decisions_corpus_country_shape()",
  );
  expect(source).toContain("BEFORE INSERT OR UPDATE OF country");
  expect(source).toContain("NEW.country IS DISTINCT FROM OLD.country");
  expect(source).toContain("NEW.country !~ '^[A-Za-z]{2,8}$'");
  expect(source).toContain(
    "CONSTRAINT = 'case_law_decisions_corpus_country_shape'",
  );
  expect(schemaSource).not.toContain(
    '"case_law_decisions_corpus_country_shape"',
  );
});

test("ordered source progress remains inside the ingestion role boundary", async () => {
  const [source, leaseSource] = await Promise.all([
    Bun.file(ingestionSourceGrantMigration).text(),
    Bun.file(ingestionSourceLeaseMigration).text(),
  ]);

  expect(source).toContain(
    "GRANT UPDATE (observation_order, checkpoint_observation_order)",
  );
  expect(source).toContain('ON TABLE "case_law_sources"');
  expect(source).toContain("TO stella_ingestion");
  expect(leaseSource).toContain(
    "GRANT UPDATE (ingestion_lease_token, ingestion_lease_expires_at)",
  );
  expect(leaseSource).toContain('ON TABLE "case_law_sources"');
  expect(leaseSource).toContain("TO stella_ingestion");
});

test("the ingestion role can take every lock the corpus checkpoint holds", async () => {
  const [source, schemaSource] = await Promise.all([
    Bun.file(caseLawCorpusIndexSource).text(),
    Bun.file(caseLawSchemaSource).text(),
  ]);

  const sqlTableByIdentifier = new Map(
    [...schemaSource.matchAll(PG_TABLE_DECLARATION_PATTERN)].map((match) => [
      match.groups?.["identifier"],
      match.groups?.["table"],
    ]),
  );
  const lockTargets = SHARE_LOCK_PATTERN.exec(source)?.groups?.["tables"] ?? "";
  const lockedTables = [
    ...lockTargets.matchAll(DRIZZLE_TABLE_REFERENCE_PATTERN),
  ].map((match) => sqlTableByIdentifier.get(match.groups?.["identifier"]));

  // Non-vacuity: the lock must still be found and resolvable to table names.
  expect(lockedTables).toContain("case_law_decisions");
  expect(lockedTables).toContain("case_law_sources");

  for (const table of lockedTables) {
    expect(table).toBeDefined();
    expect({
      table,
      lockable: ingestionLockPrivileges(table ?? "").length > 0,
    }).toEqual({ table, lockable: true });
  }
});

// The binding, not the statement's formatting: a consumer that imports the
// shared builder alongside anything else, or across several lines, satisfies
// this invariant exactly as much as a single-specifier import does. Pinning
// the literal statement made a reformat look like a bypass.
const SHARED_BUILDER_IMPORT =
  /import\s*\{[^}]*\bcaseLawCorpusQuery\b[^}]*\}\s*from\s*"@\/api\/lib\/legal-search\/corpus-query"/su;

// One assembler, or the two boundaries drift into two answers about what the
// engine sees. The public search path and the shared provider must both reach
// the engine through corpus-query.ts, and neither may re-derive quoting,
// interpolate user text into the DSL, or assemble a clause of its own.
test("every case-law corpus query is assembled by the shared builder", async () => {
  const consumers = await Promise.all(
    [publicSearchSource, sharedSearchProviderSource].map(
      async (source) => await Bun.file(source).text(),
    ),
  );
  for (const source of consumers) {
    expect(source).toMatch(SHARED_BUILDER_IMPORT);
    expect(source).toContain("caseLawCorpusQuery(");
    // A local escaping helper is how the two paths diverged before, and
    // reaching for the shared quoting primitive is the same divergence with a
    // shared name: quoting belongs to the builder that owns the clause.
    expect(source).not.toMatch(/const quote = /u);
    expect(source).not.toMatch(/replaceAll\('"'/u);
    expect(source).not.toContain("quoteCorpusValue");
    // No field clause is assembled outside the shared builder, and free text
    // never reaches a template literal.
    expect(source).not.toMatch(/`(?:document_type|source|language|court):/u);
    expect(source).not.toMatch(/`decision_date:\[/u);
    expect(source).not.toMatch(/\$\{\w+\.query\}/u);
    // Query expansion emits grouped OR leaves. That assembly is the builder's
    // too: a consumer that grows its own group is the same drift in the shape
    // the expander made reachable.
    expect(source).not.toMatch(/"\s+OR\s+"/u);
  }
});

// The physical index id has one SQL derivation, `caseLawIndexIdSql`, and its
// migration twin `case_law_corpus_index_id`. A hand-written concatenation in
// a query or the trigger would be a second answer to which index a decision
// belongs to, and from generation 3 on a wrong one.
test("no case-law SQL derives the physical index id by hand", async () => {
  const consumers = await Promise.all(
    [caseLawCorpusIndexSource, caseLawCorpusProjectionSource].map(
      async (source) => await Bun.file(source).text(),
    ),
  );
  for (const source of consumers) {
    expect(source).not.toMatch(/\|\|\s*'_'\s*\|\|/u);
  }
  const triggerMigrations = readdirSync(DRIZZLE_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => nodePath.join(DRIZZLE_DIR, entry.name, "migration.sql"))
    .filter((file) => existsSync(file))
    .sort()
    .filter((file) =>
      readFileSync(file, "utf-8").includes(
        "CREATE OR REPLACE FUNCTION enqueue_case_law_corpus_index_projection()",
      ),
    );
  const latestTrigger = triggerMigrations.at(-1);
  if (latestTrigger === undefined) {
    throw new Error("no migration defines the projection trigger");
  }
  const trigger = readFileSync(latestTrigger, "utf-8");
  expect(trigger).toContain(
    "NEW.indexed_generation =\n          case_law_corpus_index_id(projection.generation, NEW.country)",
  );
  expect(trigger).toContain(
    "ARRAY[case_law_corpus_index_id(checkpoint.generation, NEW.country)]",
  );
  expect(trigger).not.toContain("|| '_' || lower(NEW.country)");
});

test("every case-law corpus search boundary uses generation projection state", async () => {
  const consumers = await Promise.all(
    [publicSearchSource, sharedSearchProviderSource].map(
      async (source) => await Bun.file(source).text(),
    ),
  );
  for (const source of consumers) {
    expect(source).toContain("caseLawCorpusProjectionJoin(generation)");
    expect(source).toContain("currentCaseLawCorpusProjection(generation)");
  }
});
