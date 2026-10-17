import { panic, Result } from "better-result";
import type { SQL } from "bun";
import { describe, expect, test } from "bun:test";

import {
  SETTING_ORGANIZATION_ID,
  SETTING_USER_ID,
  SETTING_WORKSPACE_IDS,
  SETTING_WORKSPACE_ACCESS_MODE,
  WORKSPACE_ACCESS_MODE,
} from "@/api/db/rls";
import { withGatedTestClients } from "@/api/tests/gated-test-database";

const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const MIGRATIONS = [
  {
    name: "20261010005100_signals_flows_enrolments",
    index: undefined,
    table: undefined,
  },
  {
    name: "20261010005200_validate_signals_flows_enrolments",
    index: undefined,
    table: undefined,
  },
  {
    name: "20261010005300_flow_upload_replay_index",
    index: "flow_runs_upload_identity_idx",
    table: "flow_runs",
  },
  {
    name: "20261010005400_upload_trigger_settlements",
    index: "flow_upload_trigger_intents_retry_idx",
    table: "flow_upload_trigger_intents",
  },
  {
    name: "20261010005500_feature_recovery_grant_waits",
    index: "pending_scout_emissions_awaiting_grant_idx",
    table: "pending_scout_emissions",
  },
  {
    name: "20261010005600_flow_recovery_outcomes",
    index: undefined,
    table: undefined,
  },
  {
    name: "20261010005700_validate_flow_recovery_outcomes",
    index: undefined,
    table: undefined,
  },
  {
    name: "20261010005800_flow_completion_notice_recovery_index",
    index: "flow_runs_completion_notice_pending_idx",
    table: "flow_runs",
  },
  {
    name: "20261010005900_upload_trigger_skipped_recovery_index",
    index: "flow_upload_trigger_intents_skipped_recovery_idx",
    table: "flow_upload_trigger_intents",
  },
  {
    name: "20261010006000_validate_feature_recovery_constraints",
    index: undefined,
    table: undefined,
  },
  {
    name: "20261012030000_feature_recovery_receipt_owner_access",
    index: undefined,
    table: undefined,
  },
] as const;
const DEPENDENCIES = [
  "organization",
  "feature_enrolments",
  "workspaces",
  "entities",
  "flow_definitions",
  "flow_runs",
  "document_processing_runs",
] as const;
type MigrationSession = Awaited<ReturnType<SQL["reserve"]>>;

const migrationStatements = async (name: string) =>
  (
    await Bun.file(
      new URL(`../../drizzle/${name}/migration.sql`, import.meta.url),
    ).text()
  )
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);

const executableStatement = (statement: string) =>
  statement.replace(/^\s*--[^\n]*$/gmu, "").trim();

const committedCutpoints = async (name: string) => {
  const cutpoints: number[] = [];
  let transaction: "open" | "committed" = "open";
  const statements = await migrationStatements(name);
  for (const [index, statement] of statements.entries()) {
    const executable = executableStatement(statement);
    if (/^BEGIN\s*;/iu.test(executable)) {
      transaction = "open";
      continue;
    }
    if (/^COMMIT\s*;/iu.test(executable)) {
      transaction = "committed";
      cutpoints.push(index);
      continue;
    }
    // DDL outside BEGIN commits independently, including each constraint validation.
    if (
      transaction === "committed" &&
      /^(?:ALTER|CREATE|DROP)\s/iu.test(executable)
    ) {
      cutpoints.push(index);
    }
  }
  return cutpoints;
};

type ApplyMigrationOptions = {
  session: MigrationSession;
  schema: string;
  name: string;
  interrupt: "none" | "transaction-end" | number;
};

const applyMigration = async ({
  session,
  schema,
  name,
  interrupt,
}: ApplyMigrationOptions) => {
  await session.unsafe("BEGIN");
  for (const [index, statement] of (
    await migrationStatements(name)
  ).entries()) {
    // db-await-in-loop: shipped migration statements require sequential execution.
    await session.unsafe(
      statement
        .replaceAll(
          "public.pending_scout_emissions",
          () => `${schema}.pending_scout_emissions`,
        )
        .replaceAll(
          "public.flow_upload_trigger_intents",
          () => `${schema}.flow_upload_trigger_intents`,
        ),
    );
    if (interrupt === index) {
      return;
    }
  }
  await session.unsafe(interrupt === "none" ? "COMMIT" : "ROLLBACK");
};

const catalogSnapshot = async (session: MigrationSession, schema: string) => {
  const columns =
    await session`SELECT table_name, column_name, data_type, is_nullable, column_default
    FROM information_schema.columns WHERE table_schema = ${schema}
    ORDER BY table_name, ordinal_position`;
  const checks =
    await session`SELECT t.relname, c.conname, c.convalidated, pg_get_constraintdef(c.oid) AS definition
    FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace WHERE n.nspname = ${schema}
    ORDER BY t.relname, c.conname`;
  const indexes =
    await session`SELECT t.relname, i.relname AS index_name, x.indisvalid, pg_get_indexdef(i.oid) AS definition
    FROM pg_index x JOIN pg_class t ON t.oid = x.indrelid JOIN pg_class i ON i.oid = x.indexrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace WHERE n.nspname = ${schema}
    ORDER BY t.relname, i.relname`;
  const policies =
    await session`SELECT tablename, policyname, permissive, roles, cmd, qual, with_check
    FROM pg_policies WHERE schemaname = ${schema} ORDER BY tablename, policyname`;
  return JSON.stringify({ columns, checks, indexes, policies }).replaceAll(
    schema,
    "fixture_schema",
  );
};

const seedRecoverySources = async (session: MigrationSession) => {
  const organizationId = Bun.randomUUIDv7();
  const workspaceId = Bun.randomUUIDv7();
  const definitionId = Bun.randomUUIDv7();
  await session`INSERT INTO organization (id, name, slug, created_at) VALUES (${organizationId}, 'Replay fixture', ${organizationId}, now())`;
  await session`INSERT INTO workspaces (id, organization_id, name, reference) VALUES (${workspaceId}, ${organizationId}, 'Replay matter', 'REPLAY')`;
  await session`INSERT INTO flow_definitions (id, organization_id, name, steps, trigger) VALUES (${definitionId}, ${organizationId}, 'Replay flow', '[]', '{"type":"manual"}')`;
  for (let index = 0; index < 2; index += 1) {
    const entityId = Bun.randomUUIDv7();
    // db-await-in-loop: two source identities establish a genuine concurrent uniqueness failure.
    // LIKE copies the gate checks, but not the trigger that initializes the gate.
    await session`INSERT INTO entities (id, workspace_id, name, entity_feature_gate) VALUES (${entityId}, ${workspaceId}, 'replay.pdf', 'open')`;
    // db-await-in-loop: seed the matching run before testing its replay index.
    await session`INSERT INTO flow_runs (id, workspace_id, definition_id, definition_snapshot, trigger_source)
      VALUES (${Bun.randomUUIDv7()}, ${workspaceId}, ${definitionId}, '{"name":"Replay flow","steps":[]}', '{"type":"schedule"}')`;
    // Historical FORCE RLS tables have no owner policy. Seed receipts through
    // their authorized tenant writer, not through the later repair policy.
    // db-await-in-loop: each receipt pair commits with its explicit fixture scope.
    await session.begin(async (tx) => {
      await tx`SELECT set_config('role', 'stella', true),
        set_config(${SETTING_ORGANIZATION_ID}, ${organizationId}, true),
        set_config(${SETTING_USER_ID}, '', true),
        set_config(${SETTING_WORKSPACE_IDS}, ${`{${workspaceId}}`}, true),
        set_config(${SETTING_WORKSPACE_ACCESS_MODE}, ${WORKSPACE_ACCESS_MODE.explicit}, true)`;
      await tx`INSERT INTO flow_upload_trigger_intents (definition_id, entity_id, organization_id, workspace_id)
        VALUES (${definitionId}, ${entityId}, ${organizationId}, ${workspaceId})`;
      await tx`INSERT INTO pending_scout_emissions (organization_id, workspace_id, source_kind, source_id)
        VALUES (${organizationId}, ${workspaceId}, 'document-review', ${entityId})`;
    });
  }
};

type MigrationScenarioOptions = {
  session: MigrationSession;
  migration: (typeof MIGRATIONS)[number];
  scenario:
    | "complete"
    | "invalid-index"
    | { type: "interrupted"; afterStatement: number | "transaction-end" };
};

const migrationScenario = async ({
  session,
  migration,
  scenario,
}: MigrationScenarioOptions) => {
  const schema = `recovery_replay_${Bun.randomUUIDv7().replaceAll("-", "")}`;
  // No public fallback: absent local indexes must never resolve to production tables.
  await session.unsafe(`CREATE SCHEMA ${schema}; SET search_path TO ${schema}`);
  try {
    for (const table of DEPENDENCIES) {
      // db-await-in-loop: dependencies are isolated before applying the actual shipped SQL.
      await session.unsafe(
        `CREATE TABLE ${table} (LIKE public.${table} INCLUDING ALL)`,
      );
    }
    await session.unsafe(
      "ALTER TABLE flow_runs DROP COLUMN IF EXISTS recovery_state CASCADE",
    );
    // The deadline prerequisites derive their pre-grant-wait checks from the
    // migration that introduced them, rather than the already migrated database.
    await session.unsafe(`ALTER TABLE document_processing_runs
      DROP CONSTRAINT document_processing_runs_deadline_scout_status_values_check,
      DROP CONSTRAINT document_processing_runs_deadline_scout_lifecycle_check`);
    for (const statement of await migrationStatements(
      "20260830120000_signals",
    )) {
      if (
        statement.includes(
          'ADD CONSTRAINT "document_processing_runs_deadline_scout_status_values_check"',
        ) ||
        statement.includes(
          'ADD CONSTRAINT "document_processing_runs_deadline_scout_lifecycle_check"',
        )
      ) {
        // db-await-in-loop: restore the two historical checks before the feature migrations.
        await session.unsafe(statement);
      }
    }
    const copiedWaitIndexes = await session<
      { index_name: string }[]
    >`SELECT i.relname AS index_name
      FROM pg_index x JOIN pg_class t ON t.oid = x.indrelid JOIN pg_class i ON i.oid = x.indexrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = ${schema} AND t.relname = 'document_processing_runs'
        AND pg_get_expr(x.indpred, x.indrelid) LIKE '%awaiting_grant%'`;
    for (const { index_name: indexName } of copiedWaitIndexes) {
      // db-await-in-loop: remove only catalog-proven copied indexes in the isolated search path.
      await session.unsafe(`DROP INDEX "${indexName.replaceAll('"', '""')}"`);
    }
    for (const previous of MIGRATIONS) {
      if (previous.name === migration.name) {
        break;
      }
      // db-await-in-loop: migration identity order defines the prerequisite schema.
      await applyMigration({
        session,
        schema,
        name: previous.name,
        interrupt: "none",
      });
    }
    await session.unsafe(`GRANT USAGE ON SCHEMA ${schema} TO stella`);
    if (migration.name !== MIGRATIONS[0].name) {
      await seedRecoverySources(session);
    }
    if (scenario !== "complete") {
      const beforePrefix = await catalogSnapshot(session, schema);
      await applyMigration({
        session,
        schema,
        name: migration.name,
        interrupt:
          scenario === "invalid-index"
            ? ((await committedCutpoints(migration.name)).at(0) ??
              "transaction-end")
            : scenario.afterStatement,
      });
      if (
        migration.name === "20261010005400_upload_trigger_settlements" ||
        migration.name === "20261010005500_feature_recovery_grant_waits"
      ) {
        // Column and CHECK changes survive the internal COMMIT before replay.
        expect(await catalogSnapshot(session, schema)).not.toBe(beforePrefix);
      }
    }
    if (scenario === "invalid-index") {
      if (migration.index === undefined) {
        return panic("Invalid-index scenario requires a concurrent migration");
      }
      await session.unsafe(
        `DROP INDEX CONCURRENTLY IF EXISTS ${migration.index}`,
      );
      const failed = await Result.tryPromise(
        async () =>
          await session.unsafe(
            `CREATE UNIQUE INDEX CONCURRENTLY ${migration.index} ON ${migration.table} ((1))`,
          ),
      );
      expect(failed.isErr()).toBe(true);
      const invalid = await session<
        { valid: boolean }[]
      >`SELECT indisvalid AS valid FROM pg_index WHERE indexrelid = ${`${schema}.${migration.index}`}::regclass`;
      expect(invalid).toEqual([{ valid: false }]);
    }
    await applyMigration({
      session,
      schema,
      name: migration.name,
      interrupt: "none",
    });
    const snapshot = await catalogSnapshot(session, schema);
    if (migration.index !== undefined) {
      await applyMigration({
        session,
        schema,
        name: migration.name,
        interrupt: "none",
      });
      expect(await catalogSnapshot(session, schema)).toBe(snapshot);
    }
    return snapshot;
  } finally {
    await session.unsafe("ROLLBACK");
    await session.unsafe(
      `DROP SCHEMA ${schema} CASCADE; SET search_path TO public`,
    );
  }
};

describe.skipIf(!enabled)(
  "feature recovery migration replay (postgres)",
  () => {
    for (const migration of MIGRATIONS) {
      test(`${migration.name}: committed prefixes replay to the uninterrupted catalog`, async () => {
        await withGatedTestClients(
          process.env["DATABASE_URL"] ?? panic("Missing PostgreSQL test URL"),
          async ({ openClient }) => {
            const session = await openClient().sql.reserve();
            try {
              const complete = await migrationScenario({
                session,
                migration,
                scenario: "complete",
              });
              const cutpoints = await committedCutpoints(migration.name);
              const interruptions =
                cutpoints.length === 0
                  ? ["transaction-end" as const]
                  : cutpoints;
              for (const afterStatement of interruptions) {
                // db-await-in-loop: each committed prefix gets a fresh isolated replay schema.
                expect(
                  await migrationScenario({
                    session,
                    migration,
                    scenario: { type: "interrupted", afterStatement },
                  }),
                ).toBe(complete);
              }
              if (migration.index !== undefined) {
                expect(
                  await migrationScenario({
                    session,
                    migration,
                    scenario: "invalid-index",
                  }),
                ).toBe(complete);
              }
            } finally {
              session.release();
            }
          },
        );
      }, 60_000);
    }
  },
);
