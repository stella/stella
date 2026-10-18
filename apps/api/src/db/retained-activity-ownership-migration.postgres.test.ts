import { panic } from "better-result";
import { describe, expect, test } from "bun:test";

import { withGatedTestClients } from "@/api/tests/gated-test-database";

const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

describe.skipIf(!enabled)(
  "retained activity ownership migration (postgres)",
  () => {
    test("deleted review tasks never become shared activity when their live links are gone", async () => {
      const migration = await Bun.file(
        new URL(
          "../../drizzle/20261018120000_retained_activity_feature_ownership/migration.sql",
          import.meta.url,
        ),
      ).text();
      await withGatedTestClients(
        process.env["DATABASE_URL"] ?? panic("Missing PostgreSQL test URL"),
        async ({ openClient }) => {
          const session = await openClient().sql.reserve();
          const schema = `retained_owner_${Bun.randomUUIDv7().replaceAll("-", "")}`;
          try {
            await session.unsafe(
              `BEGIN; CREATE SCHEMA ${schema}; SET LOCAL search_path TO ${schema}, public`,
            );
            // Minimal pre-migration relations preserve the deletion behavior that erased ownership evidence.
            await session.unsafe(`
            CREATE TABLE member (organization_id text, user_id text);
            CREATE TABLE "user" (id text, email_verified boolean, deleted_at timestamptz);
            CREATE TABLE feature_enrolments (organization_id text, user_id text, feature_id text);
            CREATE TABLE entities (id uuid PRIMARY KEY, workspace_id uuid NOT NULL);
            CREATE TABLE flow_runs (id uuid PRIMARY KEY, workspace_id uuid NOT NULL);
            CREATE TABLE flow_run_steps (
              workspace_id uuid NOT NULL,
              review_task_entity_id uuid REFERENCES entities(id) ON DELETE SET NULL
            );
            CREATE TABLE audit_logs (
              id text PRIMARY KEY, workspace_id uuid, organization_id text,
              user_id text, resource_type text NOT NULL, resource_id text NOT NULL,
              performer_id text, run_id text, metadata jsonb, changes jsonb
            );
            CREATE TABLE notifications (
              id text PRIMARY KEY, workspace_id uuid, organization_id text,
              user_id text, kind text NOT NULL, entity_type text, entity_id text
            );
            CREATE POLICY audit_logs_select ON audit_logs FOR SELECT USING (true);
            CREATE POLICY user_select ON notifications FOR SELECT USING (true);
            CREATE POLICY user_update ON notifications FOR UPDATE USING (true) WITH CHECK (true);
          `);
            const workspaceId = Bun.randomUUIDv7();
            const otherWorkspaceId = Bun.randomUUIDv7();
            const runId = Bun.randomUUIDv7();
            await session`INSERT INTO flow_runs VALUES (${runId}, ${workspaceId})`;
            const cases = [
              {
                id: "performer-flow",
                performer: "flow:definition",
                run: null,
                owner: "flows",
              },
              {
                id: "performer-run",
                performer: "flow-run:execution",
                run: null,
                owner: "flows",
              },
              { id: "run-id", performer: null, run: runId, owner: "flows" },
              {
                id: "no-provenance",
                performer: null,
                run: null,
                owner: "unknown",
              },
              {
                id: "foreign-run",
                performer: null,
                run: Bun.randomUUIDv7(),
                owner: "unknown",
              },
            ] as const;
            const foreignRun =
              cases.at(-1) ?? panic("Missing foreign-run case");
            await session`INSERT INTO flow_runs VALUES (${foreignRun.run}, ${otherWorkspaceId})`;
            for (const scenario of cases) {
              const entityId = Bun.randomUUIDv7();
              // db-await-in-loop: each lifecycle must finish before migration begins.
              await session`INSERT INTO entities VALUES (${entityId}, ${workspaceId})`;
              await session`INSERT INTO flow_run_steps VALUES (${workspaceId}, ${entityId})`;
              await session`INSERT INTO audit_logs (id, workspace_id, resource_type, resource_id, performer_id, run_id)
              VALUES (${scenario.id}, ${workspaceId}, 'entity', ${entityId}, ${scenario.performer}, ${scenario.run})`;
              await session`INSERT INTO audit_logs (id, workspace_id, resource_type, resource_id, metadata)
              VALUES (${`${scenario.id}-field`}, ${workspaceId}, 'field', 'field-id', ${JSON.stringify({ entityId })}::text::jsonb)`;
              await session`INSERT INTO notifications (id, workspace_id, kind, entity_type, entity_id)
              VALUES (${scenario.id}, ${workspaceId}, 'mention', 'entity', ${entityId})`;
              await session`DELETE FROM entities WHERE id = ${entityId}`;
            }
            expect(await session`SELECT * FROM entities`).toHaveLength(0);
            expect(
              await session`SELECT * FROM flow_run_steps WHERE review_task_entity_id IS NOT NULL`,
            ).toHaveLength(0);
            const ordinaryId = Bun.randomUUIDv7();
            await session`INSERT INTO entities VALUES (${ordinaryId}, ${workspaceId})`;
            await session`INSERT INTO audit_logs (id, workspace_id, resource_type, resource_id)
            VALUES ('ordinary', ${workspaceId}, 'entity', ${ordinaryId})`;
            await session`INSERT INTO notifications (id, workspace_id, kind, entity_type, entity_id)
            VALUES ('ordinary', ${workspaceId}, 'mention', 'entity', ${ordinaryId})`;

            await session.unsafe(migration);

            for (const scenario of cases) {
              // db-await-in-loop: assert each deleted lifecycle's retained rows independently.
              const audits =
                await session`SELECT feature_owner FROM audit_logs WHERE id IN (${scenario.id}, ${`${scenario.id}-field`})`;
              expect(audits).toHaveLength(2);
              expect(audits.map((row) => row.feature_owner)).toEqual([
                scenario.owner,
                scenario.owner,
              ]);
              const notices =
                await session`SELECT feature_owner FROM notifications WHERE id = ${scenario.id}`;
              expect(notices.map((row) => row.feature_owner)).toEqual([
                scenario.owner,
              ]);
            }
            expect(
              (
                await session`SELECT feature_owner FROM audit_logs WHERE id = 'ordinary'`
              ).map((row) => row.feature_owner),
            ).toEqual(["shared"]);
            expect(
              (
                await session`SELECT feature_owner FROM notifications WHERE id = 'ordinary'`
              ).map((row) => row.feature_owner),
            ).toEqual(["shared"]);
            await session`INSERT INTO audit_logs (id, resource_type, resource_id) VALUES ('new-unclassified', 'entity', 'missing')`;
            await session`INSERT INTO notifications (id, kind) VALUES ('new-unclassified', 'mention')`;
            expect(
              (
                await session`SELECT feature_owner FROM audit_logs WHERE id = 'new-unclassified'`
              ).map((row) => row.feature_owner),
            ).toEqual(["unknown"]);
            expect(
              (
                await session`SELECT feature_owner FROM notifications WHERE id = 'new-unclassified'`
              ).map((row) => row.feature_owner),
            ).toEqual(["unknown"]);
            // Exercise the policies installed by the shipped migration as the application role.
            await session`UPDATE audit_logs SET organization_id = 'migration-org', user_id = 'migration-user'`;
            await session`UPDATE notifications SET organization_id = 'migration-org', user_id = 'migration-user'`;
            await session`INSERT INTO member VALUES ('migration-org', 'migration-user')`;
            await session`INSERT INTO "user" VALUES ('migration-user', true, NULL)`;
            await session.unsafe(`
              ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
              ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
              GRANT USAGE ON SCHEMA ${schema} TO stella;
              GRANT SELECT ON ALL TABLES IN SCHEMA ${schema} TO stella;
              GRANT UPDATE ON notifications TO stella;
            `);
            await session`SELECT set_config('app.organization_id', 'migration-org', true),
              set_config('app.user_id', 'migration-user', true),
              set_config('app.workspace_ids', ${`{${workspaceId}}`}, true)`;
            await session.unsafe("SET LOCAL ROLE stella");
            expect(
              (await session`SELECT id FROM audit_logs ORDER BY id`).map(
                (row) => row.id,
              ),
            ).toEqual(["ordinary"]);
            expect(
              (await session`SELECT id FROM notifications ORDER BY id`).map(
                (row) => row.id,
              ),
            ).toEqual(["ordinary"]);
            expect(
              await session`UPDATE notifications SET user_id = user_id WHERE id = 'performer-flow' RETURNING id`,
            ).toHaveLength(0);
            await session.unsafe("RESET ROLE");
            await session`INSERT INTO feature_enrolments VALUES ('migration-org', 'migration-user', 'flows')`;
            await session.unsafe("SET LOCAL ROLE stella");
            expect(await session`SELECT id FROM audit_logs`).toHaveLength(7);
            expect(
              (await session`SELECT id FROM notifications ORDER BY id`).map(
                (row) => row.id,
              ),
            ).toEqual([
              "ordinary",
              "performer-flow",
              "performer-run",
              "run-id",
            ]);
            expect(
              await session`UPDATE notifications SET user_id = user_id WHERE id = 'performer-flow' RETURNING id`,
            ).toHaveLength(1);
            expect(
              await session`UPDATE notifications SET user_id = user_id WHERE id = 'no-provenance' RETURNING id`,
            ).toHaveLength(0);
            await session.unsafe("RESET ROLE");
            await session`DELETE FROM feature_enrolments`;
            await session.unsafe("SET LOCAL ROLE stella");
            expect(
              (await session`SELECT id FROM audit_logs`).map((row) => row.id),
            ).toEqual(["ordinary"]);
            expect(
              (await session`SELECT id FROM notifications`).map(
                (row) => row.id,
              ),
            ).toEqual(["ordinary"]);
          } finally {
            await session.unsafe("ROLLBACK");
            session.release();
          }
        },
      );
    }, 60_000);
  },
);
