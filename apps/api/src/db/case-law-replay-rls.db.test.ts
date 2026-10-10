import { describe, expect, test } from "bun:test";

import { withGatedTestClients } from "../tests/gated-test-database";

const databaseUrl = process.env["DATABASE_URL"];
const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const sourceId = "00000000-0000-0000-0000-000000000001";
const decisionId = "00000000-0000-0000-0000-000000000002";

const receipts = [
  {
    prepare: null,
    table: "case_law_replay_batches",
    insert: `INSERT INTO case_law_replay_batches (id, source_id, first_decision_id, last_decision_id, parser_version_to, budget_day, status, attempted, gate_verdict) VALUES ('receipt', '${sourceId}', '${decisionId}', '${decisionId}', 2, '2026-10-02', 'reserved', 1, '{"kind":"normal","signals":[]}')`,
    update:
      "UPDATE case_law_replay_batches SET status = 'completed' RETURNING id",
  },
  {
    prepare: null,
    table: "case_law_replay_blocked",
    insert: `INSERT INTO case_law_replay_blocked (source_id, decision_id, parser_version_to, outcome, reason) VALUES ('${sourceId}', '${decisionId}', 2, 'rejected', 'no-document')`,
    update:
      "UPDATE case_law_replay_blocked SET detail = 'updated' RETURNING decision_id",
  },
  {
    prepare: `INSERT INTO case_law_replay_batches (id, source_id, first_decision_id, last_decision_id, parser_version_to, budget_day, status, attempted, gate_verdict) VALUES ('daily', '${sourceId}', '${decisionId}', '${decisionId}', 2, '2026-10-02', 'reserved', 1, '{"kind":"normal","signals":[]}')`,
    table: "case_law_replay_daily_rows",
    insert: `INSERT INTO case_law_replay_daily_rows (batch_id, source_id, budget_day) VALUES ('daily', '${sourceId}', '2026-10-02')`,
    update:
      "UPDATE case_law_replay_daily_rows SET budget_day = '2026-10-03' RETURNING batch_id",
  },
  {
    prepare: null,
    table: "case_law_replay_source_progress",
    insert: `INSERT INTO case_law_replay_source_progress (source_id) VALUES ('${sourceId}')`,
    update:
      "UPDATE case_law_replay_source_progress SET ticks_without_progress = 1 RETURNING source_id",
  },
  {
    prepare: null,
    table: "case_law_replay_audit_events",
    insert: `INSERT INTO case_law_replay_audit_events (id, source_id, service_id, action, resource_id, details) VALUES ('audit', '${sourceId}', 'case-law-background-replay', 'tick-recorded', 'fixture', '{}')`,
    update:
      "UPDATE case_law_replay_audit_events SET resource_id = 'changed' RETURNING id",
  },
  {
    prepare: null,
    table: "eu_completion_receipts",
    insert: `INSERT INTO eu_completion_receipts (id, source_id, decision_id, mode, parser_version, status) VALUES ('completion', '${sourceId}', '${decisionId}', 'dry-run', 2, 'pending')`,
    update: "UPDATE eu_completion_receipts SET detail = 'fixture' RETURNING id",
  },
  {
    prepare: null,
    table: "eu_completion_request_hours",
    insert:
      "INSERT INTO eu_completion_request_hours (hour, requests) VALUES ('2026-10-02T00:00:00Z', 1)",
    update:
      "UPDATE eu_completion_request_hours SET requests = 2 RETURNING hour",
  },
  {
    prepare: `INSERT INTO eu_completion_receipts (id, source_id, decision_id, mode, parser_version, status, completed_at) VALUES ('approval-evidence', '${sourceId}', '${decisionId}', 'dry-run', 2, 'dry-run', '2026-10-02T00:00:00Z')`,
    table: "eu_completion_approvals",
    insert: `INSERT INTO eu_completion_approvals (source_id, parser_version, supervised_receipt_id, evidence_ref, supervised_by, supervised_at, approved_by, approved_at, proof_mode, proof_status, proof_completed_at, reviewed_counts) VALUES ('${sourceId}', 2, 'approval-evidence', 'fixture://evidence', 'fixture-supervisor', now(), 'fixture-operator', now(), 'dry-run', 'dry-run', '2026-10-02T00:00:00Z', '{"reviewed":1,"accepted":1,"requiresReview":0}')`,
    update:
      "UPDATE eu_completion_approvals SET evidence_ref = 'fixture://updated' RETURNING source_id",
  },
  {
    prepare: null,
    table: "eu_completion_controls",
    insert: `INSERT INTO eu_completion_controls (key, source_id) VALUES ('source:${sourceId}', '${sourceId}')`,
    update:
      "UPDATE eu_completion_controls SET ticks_without_progress = 1 RETURNING key",
  },
] as const;

describe.skipIf(!enabled)("replay receipt row security", () => {
  test("forced RLS admits only the plain owner even when another role is granted every table privilege", async () => {
    if (databaseUrl === undefined) {
      throw new TypeError("DATABASE_URL required");
    }
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const client = openClient().sql;
      const suffix = Bun.randomUUIDv7().replaceAll("-", "");
      const schema = `replay_${suffix}`;
      const owner = `replay_owner_${suffix}`;
      const reader = `replay_reader_${suffix}`;
      const migration = await Bun.file(
        new URL(
          "../../drizzle/20261003123500_case_law_replay_receipts/migration.sql",
          import.meta.url,
        ),
      ).text();
      const completionMigration = await Bun.file(
        new URL(
          "../../drizzle/20261003123700_eu_completion_receipts/migration.sql",
          import.meta.url,
        ),
      ).text();
      await client.unsafe("BEGIN");
      try {
        const version = await client.unsafe<{ version: number }[]>(
          "SELECT current_setting('server_version_num')::int AS version",
        );
        expect(version.at(0)?.version).toBeGreaterThanOrEqual(180_000);
        expect(version.at(0)?.version).toBeLessThan(190_000);
        await client.unsafe(`CREATE SCHEMA ${schema}`);
        await client.unsafe(
          `CREATE ROLE ${owner} NOLOGIN NOSUPERUSER NOBYPASSRLS`,
        );
        await client.unsafe(
          `CREATE ROLE ${reader} NOLOGIN NOSUPERUSER NOBYPASSRLS`,
        );
        await client.unsafe(`SET LOCAL search_path TO ${schema}, public`);
        await client.unsafe(
          "CREATE TABLE case_law_sources (id uuid PRIMARY KEY)",
        );
        await client.unsafe(
          `INSERT INTO case_law_sources VALUES ('${sourceId}')`,
        );
        for (const statement of `${migration}--> statement-breakpoint${completionMigration}`
          .replaceAll(
            '"public"."case_law_sources"',
            () => `"${schema}"."case_law_sources"`,
          )
          .replaceAll(
            "public.case_law_replay_",
            () => `${schema}.case_law_replay_`,
          )
          .replaceAll("public.eu_completion_", () => `${schema}.eu_completion_`)
          .split("--> statement-breakpoint")) {
          if (statement.trim().length > 0) {
            await client.unsafe(statement);
          }
        }
        await client.unsafe(
          `GRANT USAGE ON SCHEMA ${schema} TO ${owner}, ${reader}`,
        );
        for (const receipt of receipts) {
          const posture = await client.unsafe<
            { enabled: boolean; forced: boolean }[]
          >(
            `SELECT relrowsecurity AS enabled, relforcerowsecurity AS forced FROM pg_class WHERE oid = '${schema}.${receipt.table}'::regclass`,
          );
          expect(posture.at(0)).toEqual({ enabled: true, forced: true });
          const privileges = await client.unsafe<{ allowed: boolean }[]>(
            `SELECT has_table_privilege('stella', '${schema}.${receipt.table}', 'SELECT, INSERT, UPDATE, DELETE') AS allowed`,
          );
          expect(privileges.at(0)?.allowed).toBe(false);
          await client.unsafe(`ALTER TABLE ${receipt.table} OWNER TO ${owner}`);
          await client.unsafe(
            `GRANT SELECT, INSERT, UPDATE, DELETE ON ${receipt.table} TO ${reader}`,
          );
          await client.unsafe(`SET LOCAL ROLE ${owner}`);
          if (receipt.prepare !== null) {
            await client.unsafe(receipt.prepare);
          }
          await client.unsafe(receipt.insert);
          expect(
            await client.unsafe<Record<string, unknown>[]>(receipt.update),
          ).toHaveLength(1);
          await client.unsafe(`SET LOCAL ROLE ${reader}`);
          expect(
            await client.unsafe<Record<string, unknown>[]>(
              `SELECT * FROM ${receipt.table}`,
            ),
          ).toHaveLength(0);
          expect(
            await client.unsafe<Record<string, unknown>[]>(receipt.update),
          ).toHaveLength(0);
          expect(
            await client.unsafe<Record<string, unknown>[]>(
              `DELETE FROM ${receipt.table} RETURNING *`,
            ),
          ).toHaveLength(0);
          await client.unsafe("SAVEPOINT denied_insert");
          const rejection: unknown = await client.unsafe(receipt.insert).then(
            () => null,
            (error: unknown) => error,
          );
          expect(rejection).toBeInstanceOf(Error);
          expect(
            rejection instanceof Error ? rejection.message : String(rejection),
          ).toMatch(/row-level security/u);
          await client.unsafe("ROLLBACK TO SAVEPOINT denied_insert");
          await client.unsafe(`SET LOCAL ROLE ${owner}`);
          expect(
            await client.unsafe<Record<string, unknown>[]>(
              `SELECT * FROM ${receipt.table}`,
            ),
          ).toHaveLength(1);
          expect(
            await client.unsafe<Record<string, unknown>[]>(
              `DELETE FROM ${receipt.table} RETURNING *`,
            ),
          ).toHaveLength(1);
          await client.unsafe("RESET ROLE");
        }
      } finally {
        await client.unsafe("ROLLBACK");
      }
    });
  });
});
