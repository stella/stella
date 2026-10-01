import { describe, expect, test } from "bun:test";

import { defaultConfig } from "@stll/db-load-gate/health";
import { Temporal } from "@stll/time";

import { createScriptBackfillRuntime } from "@/api/db/backfill-runtime";
import { brandPersistedLegislationDocumentId } from "@/api/lib/safe-id-boundaries";
import { withGatedTestClients } from "@/api/tests/gated-test-database";

import { backfillStatuteSlugsPage } from "./slug-backfill";

const databaseUrl = process.env["DATABASE_URL"];
const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

describe.skipIf(!enabled || databaseUrl === undefined)(
  "slug backfill poison-page recovery",
  () => {
    test("a failed page rolls back its writes, advances, and is retried by the next pass", async () => {
      if (databaseUrl === undefined) {
        throw new TypeError("DATABASE_URL required");
      }
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { sql: client, db } = openClient();
        const writer = openClient().sql;
        const schema = `slug_${Bun.randomUUIDv7().replaceAll("-", "")}`;
        await client.unsafe(`CREATE SCHEMA ${schema}`);
        try {
          await client.unsafe(`SET search_path TO ${schema}, public`);
          await writer.unsafe(`SET search_path TO ${schema}, public`);
          await client.unsafe(
            `CREATE TABLE legislation_documents (id uuid PRIMARY KEY, eli text NOT NULL, title text NOT NULL, slug varchar(512), CONSTRAINT poison_page CHECK (title <> 'poison' OR slug IS NULL))`,
          );
          await client.unsafe(
            `CREATE TABLE database_backfill_states (name text PRIMARY KEY, cursor text, batch jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())`,
          );
          await client.unsafe(
            `INSERT INTO legislation_documents (id, eli, title) SELECT ('019dd47d-f507-7c84-b827-' || lpad(id::text, 12, '0'))::uuid, CASE WHEN id > 4 THEN '/eli/cz/sb' ELSE '/eli/cz/sb/2012/' || id END, CASE WHEN id = 2 THEN 'poison' ELSE 'Law' END FROM generate_series(1, 6) id`,
          );
          const captured: unknown[] = [];
          const decisions: unknown[] = [];
          const runtime = await createScriptBackfillRuntime({
            db,
            name: "statute-slugs",
            tableName: "legislation_documents",
            initialSize: 2,
            config: {
              ...defaultConfig,
              minSize: 2,
              maxSize: 2,
              minSleepMs: 0,
              maxSleepMs: 0,
              busyWindows: [],
            },
            clock: () =>
              Temporal.Instant.from("2026-10-01T12:00:00Z").epochMilliseconds,
            readVerdict: async () => ({
              kind: "normal",
              signals: [
                {
                  indicator: "ebs_balance",
                  kind: "not_configured",
                  value: null,
                  threshold: null,
                  observedAt: null,
                  reason: "Explicit test opt-out",
                },
              ],
            }),
            log: (record) => {
              decisions.push(record);
            },
          });
          let writeFromApp = false;
          const step = async () =>
            await runtime.step(async ({ tx, cursor, size }) => {
              let scopedCalls = 0;
              const page = await backfillStatuteSlugsPage({
                db: async (work) => {
                  scopedCalls += 1;
                  if (writeFromApp && scopedCalls === 2) {
                    await writer.unsafe(
                      "UPDATE legislation_documents SET slug = 'app-assigned' WHERE id = '019dd47d-f507-7c84-b827-000000000001'",
                    );
                    writeFromApp = false;
                  }
                  return await work(tx);
                },
                after:
                  cursor === null
                    ? null
                    : brandPersistedLegislationDocumentId(cursor),
                size,
                capture: (error) => {
                  captured.push(error);
                },
              });
              return { cursor: page.cursor, done: page.done, value: page };
            });
          try {
            const poisoned = await step();
            expect(poisoned.value).toMatchObject({
              written: 0,
              failed: 2,
              done: false,
            });
            expect(captured).toHaveLength(1);
            expect(
              await client.unsafe(
                "SELECT id FROM legislation_documents WHERE slug IS NOT NULL",
              ),
            ).toHaveLength(0);
            expect(
              await client.unsafe(
                "SELECT cursor FROM database_backfill_states WHERE name = 'statute-slugs'",
              ),
            ).toEqual([{ cursor: "019dd47d-f507-7c84-b827-000000000002" }]);
            expect((await step()).value).toMatchObject({
              written: 2,
              failed: 0,
            });
            expect((await step()).value).toMatchObject({
              written: 0,
              skipped: 2,
              failed: 0,
              done: false,
            });
            expect((await step()).done).toBe(true);
            expect(
              await client.unsafe(
                "SELECT id FROM legislation_documents WHERE slug IS NOT NULL",
              ),
            ).toHaveLength(2);
            await client.unsafe(
              "UPDATE legislation_documents SET title = 'Law' WHERE title = 'poison'",
            );
            writeFromApp = true;
            expect((await step()).value).toMatchObject({
              written: 1,
              failed: 0,
            });
            expect(
              await client.unsafe(
                "SELECT slug FROM legislation_documents WHERE id = '019dd47d-f507-7c84-b827-000000000001'",
              ),
            ).toEqual([{ slug: "app-assigned" }]);
            expect((await step()).value).toMatchObject({
              written: 0,
              skipped: 2,
              failed: 0,
              done: false,
            });
            expect((await step()).done).toBe(true);
            const mismatch = await client.unsafe(
              "SELECT id FROM legislation_documents WHERE slug IS DISTINCT FROM CASE WHEN eli = '/eli/cz/sb' THEN NULL WHEN id = '019dd47d-f507-7c84-b827-000000000001' THEN 'app-assigned' ELSE (regexp_replace(eli, '^.*/', '') || '-2012-sb-law') END",
            );
            expect(mismatch).toHaveLength(0);
            for (const record of decisions) {
              expect(record).toMatchObject({
                verdict: { signals: expect.any(Array) },
                config: { hardFloor: defaultConfig.hardFloor },
              });
            }
          } finally {
            await runtime.close();
          }
        } finally {
          await client.unsafe(`DROP SCHEMA ${schema} CASCADE`);
        }
      });
    });
  },
);
