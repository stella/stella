import { panic } from "better-result";
import type { ReservedSQL } from "bun";
import { describe, expect, test } from "bun:test";

import { rejectionOf } from "@stll/property-testing/rejection";

import type { RetainedActivityFeatureOwner } from "@/api/db/feature-owner";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import { withIsolatedPostgresCluster } from "@/api/tests/isolated-postgres-cluster";

import { readOnlineIndexConfig } from "../env-online-index";
import { BackfillHeldError } from "./backfill-runtime";
import { createOnlineTableGate } from "./online-ddl";
import type { OnlineMigrationConnection } from "./online-migration-connection";
import { createRetainedActivityOwnerBackfill } from "./retained-activity-owner-backfill";
import { terminateReserved } from "./sql-close";

const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
type FeatureOwnerRow = { feature_owner: RetainedActivityFeatureOwner };
type ProvenanceScenario = {
  label: string;
  performer: string | null;
  run: string | null;
  owner: RetainedActivityFeatureOwner;
};
type ProvenanceRunIds = { runId: string; foreignRunId: string };
const provenanceScenarios = ({ runId, foreignRunId }: ProvenanceRunIds) =>
  (
    [
      {
        label: "performer-flow",
        performer: "flow:definition",
        run: null,
        owner: "flows",
      },
      {
        label: "performer-run",
        performer: "flow-run:execution",
        run: null,
        owner: "flows",
      },
      {
        label: "run-id",
        performer: null,
        run: runId,
        owner: "flows",
      },
      {
        label: "no-provenance",
        performer: null,
        run: null,
        owner: "unknown",
      },
      {
        label: "foreign-run",
        performer: null,
        run: foreignRunId,
        owner: "unknown",
      },
    ] satisfies ProvenanceScenario[]
  ).map((scenario) => ({
    ...scenario,
    id: Bun.randomUUIDv7(),
    fieldId: Bun.randomUUIDv7(),
  }));

const adapter = (session: ReservedSQL): OnlineMigrationConnection => ({
  execute: async (query, parameters = []) => {
    await session.unsafe(query, [...parameters]);
  },
  query: async (query, parameters = []) =>
    await session.unsafe<unknown[]>(query, [...parameters]),
  release: async () => {
    await session.release();
  },
  terminate: async () => {
    await terminateReserved(session);
  },
});
const migrationSql = async (name: string) =>
  await Bun.file(
    new URL(`../../drizzle/${name}/migration.sql`, import.meta.url),
  ).text();

describe.skipIf(!enabled)(
  "retained activity ownership migration (postgres)",
  () => {
    // timeout: the isolated PostgreSQL cluster exercises durable batch transactions and RLS.
    test("retained provenance survives deletion and every online phase validates before completion", async () => {
      await withIsolatedPostgresCluster(
        {
          prefix: "retained-owner",
          database: "stella",
          user: "fixture_admin",
          password: "fixture",
        },
        async (adminUrl) => {
          await withGatedTestClients(adminUrl, async ({ openClient }) => {
            await openClient().sql.unsafe(
              "CREATE ROLE fixture_owner LOGIN NOSUPERUSER NOBYPASSRLS CREATEROLE PASSWORD 'fixture'; CREATE ROLE stella NOLOGIN; GRANT stella TO fixture_owner WITH SET TRUE, INHERIT FALSE; ALTER DATABASE stella OWNER TO fixture_owner",
            );
          });
          const ownerUrl = new URL(adminUrl);
          ownerUrl.username = "fixture_owner";
          const url = ownerUrl.toString();
          await withGatedTestClients(url, async ({ openClient }) => {
            const session = await openClient().sql.reserve();
            try {
              await session.unsafe(`
            CREATE TABLE member (organization_id text, user_id text);
            CREATE TABLE "user" (id text, email_verified boolean, deleted_at timestamptz);
            CREATE TABLE feature_enrolments (organization_id text, user_id text, feature_id text);
            CREATE TABLE entities (id uuid PRIMARY KEY, workspace_id uuid NOT NULL);
            CREATE TABLE flow_runs (id uuid PRIMARY KEY, workspace_id uuid NOT NULL);
            CREATE TABLE flow_run_steps (workspace_id uuid NOT NULL, review_task_entity_id uuid REFERENCES entities(id) ON DELETE SET NULL);
            CREATE TABLE audit_logs (id uuid PRIMARY KEY, workspace_id uuid, organization_id text, user_id text, resource_type text NOT NULL, resource_id text NOT NULL, performer_id text, run_id text, metadata jsonb, changes jsonb);
            CREATE TABLE notifications (id uuid PRIMARY KEY, workspace_id uuid, organization_id text, user_id text, kind text NOT NULL, entity_type text, entity_id text);
            CREATE VIEW stella_authorized_workspaces AS SELECT NULL::uuid AS authorized_workspace_id WHERE false;
            CREATE POLICY audit_logs_select ON audit_logs FOR SELECT USING (true);
            CREATE POLICY user_select ON notifications FOR SELECT USING (true);
            CREATE POLICY user_update ON notifications FOR UPDATE USING (true) WITH CHECK (true);
          `);
              expect([
                ...(await session`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`),
              ]).toEqual([{ rolsuper: false, rolbypassrls: false }]);
              await session.unsafe(
                await migrationSql("20261001123000_database_backfill_state"),
              );
              const workspaceId = Bun.randomUUIDv7();
              const runId = Bun.randomUUIDv7();
              const foreignRunId = Bun.randomUUIDv7();
              await session`INSERT INTO flow_runs VALUES (${runId}, ${workspaceId}), (${foreignRunId}, ${Bun.randomUUIDv7()})`;
              const scenarios = provenanceScenarios({ runId, foreignRunId });
              for (const scenario of scenarios) {
                const entityId = Bun.randomUUIDv7();
                // db-await-in-loop: finish each deletion lifecycle before the online ownership phase.
                await session`INSERT INTO entities VALUES (${entityId}, ${workspaceId})`;
                await session`INSERT INTO flow_run_steps VALUES (${workspaceId}, ${entityId})`;
                await session`INSERT INTO audit_logs (id, workspace_id, resource_type, resource_id, performer_id, run_id)
              VALUES (${scenario.id}, ${workspaceId}, 'entity', ${entityId}, ${scenario.performer}, ${scenario.run})`;
                await session`INSERT INTO audit_logs (id, workspace_id, resource_type, resource_id, metadata)
              VALUES (${scenario.fieldId}, ${workspaceId}, 'field', 'field-id', ${JSON.stringify({ entityId })}::text::jsonb)`;
                await session`INSERT INTO notifications (id, workspace_id, kind, entity_type, entity_id)
              VALUES (${scenario.id}, ${workspaceId}, 'mention', 'entity', ${entityId})`;
                await session`DELETE FROM entities WHERE id = ${entityId}`;
              }
              expect(await session`SELECT * FROM entities`).toHaveLength(0);
              expect(
                await session`SELECT * FROM flow_run_steps WHERE review_task_entity_id IS NOT NULL`,
              ).toHaveLength(0);
              const ordinaryEntityId = Bun.randomUUIDv7();
              const ordinaryId = "00000000-0000-0000-0000-000000000000";
              await session`INSERT INTO entities VALUES (${ordinaryEntityId}, ${workspaceId})`;
              await session`INSERT INTO audit_logs (id, workspace_id, resource_type, resource_id) VALUES (${ordinaryId}, ${workspaceId}, 'entity', ${ordinaryEntityId})`;
              await session`INSERT INTO notifications (id, workspace_id, kind, entity_type, entity_id) VALUES (${ordinaryId}, ${workspaceId}, 'mention', 'entity', ${ordinaryEntityId})`;
              for (const name of [
                "20261031202238_retained_activity_feature_ownership",
                "20261031202338_retained_audit_feature_ownership",
                "20261031202438_retained_notification_feature_ownership",
              ]) {
                // db-await-in-loop: each shipped expand migration is one table and one transaction.
                await session`BEGIN`;
                await session.unsafe(await migrationSql(name));
                await session`COMMIT`;
              }
              const connection = adapter(session);
              let now = Date.now();
              const repair = createRetainedActivityOwnerBackfill({
                clock: () => now,
                readVerdict: async () => ({ kind: "normal", signals: [] }),
                sleep: async () => undefined,
              });
              const marker = `${repair.name}:probe`;
              await session`INSERT INTO database_backfill_states (name, cursor, batch) VALUES (${marker}, NULL, '{"holdUntil":null,"heldSince":null}')`;
              expect((await repair.readCompletion(connection)).type).toBe(
                "incomplete",
              );
              await session`DELETE FROM database_backfill_states WHERE name = ${marker}`;
              const tables = createOnlineTableGate({
                connection,
                gate: {
                  config: readOnlineIndexConfig({}),
                  ebs: { type: "disabled" },
                  log: () => undefined,
                },
                reserveObserver: async () =>
                  adapter(await openClient().sql.reserve()),
              });
              const heldRepair = createRetainedActivityOwnerBackfill({
                clock: () => now,
                readVerdict: async () => ({ kind: "unknown", signals: [] }),
                sleep: async () => undefined,
              });
              expect(
                await rejectionOf(heldRepair.repair(connection, tables)),
              ).toBeInstanceOf(BackfillHeldError);
              const heldCompletion =
                await heldRepair.readCompletion(connection);
              expect(heldCompletion).toMatchObject({
                type: "pending",
                cursor: null,
              });
              if (
                heldCompletion.type !== "pending" ||
                heldCompletion.holdUntil === null
              ) {
                panic("Missing retained activity hold deadline");
              }
              now = heldCompletion.holdUntil + 1;
              expect(await repair.repair(connection, tables)).toEqual({
                type: "complete",
              });
              expect(await repair.readCompletion(connection)).toEqual({
                type: "complete",
              });
              expect(await repair.repair(connection, tables)).toEqual({
                type: "complete",
              });
              const completedPhases = await session<
                { name: string }[]
              >`SELECT name FROM database_backfill_states WHERE name LIKE ${`${repair.name}:%`} ORDER BY name`;
              expect(completedPhases).toHaveLength(5);
              const removedCheckpoint =
                completedPhases.at(0) ??
                panic("Missing retained activity checkpoint");
              await session`DELETE FROM database_backfill_states WHERE name = ${removedCheckpoint.name}`;
              expect(await repair.readCompletion(connection)).toMatchObject({
                type: "incomplete",
              });
              expect(await repair.repair(connection, tables)).toEqual({
                type: "complete",
              });
              expect(await repair.readCompletion(connection)).toEqual({
                type: "complete",
              });
              for (const scenario of scenarios) {
                // db-await-in-loop: inspect the independently retained audit and notification outcomes.
                const audits = await session<
                  FeatureOwnerRow[]
                >`SELECT feature_owner FROM audit_logs WHERE id IN (${scenario.id}, ${scenario.fieldId})`;
                expect(audits.map((row) => row.feature_owner)).toEqual([
                  scenario.owner,
                  scenario.owner,
                ]);
                const notices = await session<
                  FeatureOwnerRow[]
                >`SELECT feature_owner FROM notifications WHERE id = ${scenario.id}`;
                expect(notices.map((row) => row.feature_owner)).toEqual([
                  scenario.owner,
                ]);
              }
              expect([
                ...(await session<
                  FeatureOwnerRow[]
                >`SELECT feature_owner FROM audit_logs WHERE id = ${ordinaryId}`),
              ]).toEqual([{ feature_owner: "shared" }]);
              expect([
                ...(await session<
                  FeatureOwnerRow[]
                >`SELECT feature_owner FROM notifications WHERE id = ${ordinaryId}`),
              ]).toEqual([{ feature_owner: "shared" }]);
              const validations = await session<
                { convalidated: boolean }[]
              >`SELECT convalidated FROM pg_constraint WHERE conname IN ('entities_feature_owner_check', 'audit_logs_feature_owner_check', 'notifications_feature_owner_check')`;
              expect(validations).toHaveLength(3);
              expect(
                validations.every(({ convalidated }) => convalidated),
              ).toBe(true);
              const newId = Bun.randomUUIDv7();
              await session`INSERT INTO audit_logs (id, resource_type, resource_id) VALUES (${newId}, 'entity', 'missing')`;
              await session`INSERT INTO notifications (id, kind) VALUES (${newId}, 'mention')`;
              expect([
                ...(await session<
                  FeatureOwnerRow[]
                >`SELECT feature_owner FROM audit_logs WHERE id = ${newId}`),
              ]).toEqual([{ feature_owner: "unknown" }]);
              expect([
                ...(await session<
                  FeatureOwnerRow[]
                >`SELECT feature_owner FROM notifications WHERE id = ${newId}`),
              ]).toEqual([{ feature_owner: "unknown" }]);
              await session.unsafe(
                `UPDATE audit_logs SET organization_id = 'migration-org', user_id = 'migration-user'; UPDATE notifications SET organization_id = 'migration-org', user_id = 'migration-user'; INSERT INTO member VALUES ('migration-org', 'migration-user'); INSERT INTO "user" VALUES ('migration-user', true, NULL); ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY; ALTER TABLE notifications ENABLE ROW LEVEL SECURITY; GRANT USAGE ON SCHEMA public TO stella; GRANT SELECT ON ALL TABLES IN SCHEMA public TO stella; GRANT UPDATE ON notifications TO stella;`,
              );
              await session`SELECT set_config('app.organization_id', 'migration-org', false), set_config('app.user_id', 'migration-user', false), set_config('app.workspace_ids', ${`{${workspaceId}}`}, false)`;
              await session.unsafe("SET ROLE stella");
              expect(await session`SELECT id FROM audit_logs`).toEqual([
                { id: ordinaryId },
              ]);
              expect(await session`SELECT id FROM notifications`).toEqual([
                { id: ordinaryId },
              ]);
              await session.unsafe("RESET ROLE");
              await session`INSERT INTO feature_enrolments VALUES ('migration-org', 'migration-user', 'flows')`;
              await session.unsafe("SET ROLE stella");
              expect(await session`SELECT id FROM audit_logs`).toHaveLength(7);
              expect(await session`SELECT id FROM notifications`).toHaveLength(
                4,
              );
              const flow =
                scenarios.at(0) ?? panic("Missing flow provenance case");
              const unknown =
                scenarios.find(({ label }) => label === "no-provenance") ??
                panic("Missing unknown provenance case");
              expect(
                await session`UPDATE notifications SET user_id = user_id WHERE id = ${flow.id} RETURNING id`,
              ).toHaveLength(1);
              expect(
                await session`UPDATE notifications SET user_id = user_id WHERE id = ${unknown.id} RETURNING id`,
              ).toHaveLength(0);
            } finally {
              await session.unsafe("ROLLBACK");
              await session.unsafe("RESET ROLE");
              await session.release();
            }
          });
        },
      );
    }, 60_000);
  },
);
