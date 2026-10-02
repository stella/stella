import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";

import { defaultConfig } from "@stll/db-load-gate/health";
import { createHeavyWorkSlot } from "@stll/db-load-gate/slot";
import { Temporal } from "@stll/time";

import {
  BackfillHeldError,
  createScriptBackfillRuntime,
} from "@/api/db/backfill-runtime";
import { getPgErrorCode } from "@/api/lib/pg-error";
import { brandPersistedLegislationDocumentId } from "@/api/lib/safe-id-boundaries";
import { withGatedTestClients } from "@/api/tests/gated-test-database";

import { backfillStatuteSlugsPage } from "./slug-backfill";

const DIVISION_BY_ZERO_SQLSTATE = "22012";
const databaseUrl = process.env["DATABASE_URL"];
const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

describe.skipIf(!enabled)("slug backfill poison-page recovery", () => {
  for (const outcome of ["commit", "rollback", "timeout"] as const) {
    test(`script batch ${outcome} retains transaction ownership and retries canceled slug ranges`, async () => {
      if (databaseUrl === undefined) {
        throw new TypeError("DATABASE_URL required");
      }
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { sql: client, db } = openClient();
        const rootClient = openClient();
        const observer = rootClient.sql;
        const indexConnection = await openClient().sql.reserve();
        const index = createHeavyWorkSlot({
          kind: "index_build",
          session: {
            query: async (statement, parameters) =>
              await indexConnection.unsafe<{ acquired: boolean }[]>(statement, [
                ...parameters,
              ]),
          },
        });
        const schema = `slug_fault_${Bun.randomUUIDv7().replaceAll("-", "")}`;
        await client.unsafe(`CREATE SCHEMA ${schema}`);
        await client.unsafe(`SET search_path TO ${schema}, public`);
        await observer.unsafe(`SET search_path TO ${schema}, public`);
        await client.unsafe(
          `CREATE TABLE legislation_documents (id uuid PRIMARY KEY, eli text NOT NULL, title text NOT NULL, slug varchar(512))`,
        );
        await client.unsafe(
          `CREATE TABLE database_backfill_states (name text PRIMARY KEY, cursor text, batch jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())`,
        );
        await client.unsafe(
          `INSERT INTO legislation_documents (id, eli, title) SELECT ('019dd47d-f507-7c84-b827-' || lpad(id::text, 12, '0'))::uuid, '/eli/cz/sb/2012/' || id, 'Law' FROM generate_series(1, 4) id`,
        );
        const records: unknown[] = [];
        let now = Temporal.Instant.from(
          "2026-10-01T12:00:00Z",
        ).epochMilliseconds;
        const runtime = createScriptBackfillRuntime({
          db: {
            transaction: db.transaction.bind(db),
            execute: rootClient.db.execute.bind(rootClient.db),
          },
          name: "slug-fault",
          tableName: "legislation_documents",
          initialSize: 4,
          config: {
            ...defaultConfig,
            minSize: 1,
            maxSize: 4,
            minSleepMs: 0,
            maxSleepMs: 0,
            busyWindows: [],
          },
          clock: () => now,
          readVerdict: async () => ({ kind: "normal", signals: [] }),
          log: (record) => {
            records.push(record);
          },
        });
        const captured: unknown[] = [];
        const otherRoot = openClient();
        const other = createScriptBackfillRuntime({
          db: {
            transaction: rootClient.db.transaction.bind(rootClient.db),
            execute: otherRoot.db.execute.bind(otherRoot.db),
          },
          name: "slug-other",
          tableName: "legislation_documents",
          initialSize: 4,
          config: {
            ...defaultConfig,
            minSize: 1,
            maxSize: 4,
            minSleepMs: 0,
            maxSleepMs: 0,
            busyWindows: [],
          },
          clock: () => now,
          readVerdict: async () => ({ kind: "normal", signals: [] }),
          log: (record) => {
            records.push(record);
          },
        });
        let otherWorked = false;
        const otherStep = async () =>
          await other.step(async ({ cursor }) => {
            otherWorked = true;
            return { cursor, done: true, value: "other" };
          });
        let fail = true;
        let triggerInstalled = false;
        const ranges: (string | null)[] = [];
        const step = async () =>
          await runtime.step(async ({ tx, cursor, size }) => {
            ranges.push(cursor);
            // Work has started on the adapter's transaction; an independent
            // physical index session must remain excluded until its boundary.
            if (fail) {
              const rejection: unknown = await otherStep().then(
                () => null,
                (error: unknown) => error,
              );
              expect(rejection).toBeInstanceOf(BackfillHeldError);
              expect(otherWorked).toBe(false);
              expect((await index.tryAcquire()).unwrap()).toBe(false);
            }
            const pageResult = await backfillStatuteSlugsPage({
              db: async (work) => {
                if (outcome === "timeout" && fail && !triggerInstalled) {
                  triggerInstalled = true;
                  await tx.execute(
                    sql`CREATE FUNCTION pg_temp.reject_slug() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id = '019dd47d-f507-7c84-b827-000000000002'::uuid THEN UPDATE legislation_documents SET title = 'rolled-back-write' WHERE id = '019dd47d-f507-7c84-b827-000000000001'::uuid; RAISE EXCEPTION 'slug timeout injected' USING ERRCODE = '57014'; END IF; RETURN NEW; END $$`,
                  );
                  await tx.execute(
                    sql.raw(
                      "CREATE TRIGGER reject_slug BEFORE UPDATE ON legislation_documents FOR EACH ROW EXECUTE FUNCTION pg_temp.reject_slug()",
                    ),
                  );
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
            if (outcome === "rollback" && fail) {
              await tx.execute(sql`SELECT 1 / 0`);
            }
            if (pageResult.isErr()) {
              throw pageResult.error.cause;
            }
            const page = pageResult.value;
            return { cursor: page.cursor, done: page.done, value: page };
          });
        try {
          if (outcome === "commit") {
            await step();
          } else {
            const rejection: unknown = await step().then(
              () => null,
              (error: unknown) => error,
            );
            expect(rejection).toBeInstanceOf(Error);
            if (outcome === "timeout") {
              expect(rejection).toBeInstanceOf(BackfillHeldError);
            } else {
              // Drizzle wraps the driver message; assert the underlying PostgreSQL fault.
              expect(getPgErrorCode(rejection)).toBe(DIVISION_BY_ZERO_SQLSTATE);
            }
          }
          expect((await index.tryAcquire()).unwrap()).toBe(true);
          await index.close();
          now += defaultConfig.holdBackoffMs;
          expect((await otherStep()).value).toBe("other");
          expect(otherWorked).toBe(true);
          const checkpoint = (
            await observer.unsafe<
              { cursor: string | null; batch: { size: number } }[]
            >(
              `SELECT cursor, batch FROM ${schema}.database_backfill_states WHERE name = 'slug-fault'`,
            )
          ).at(0);
          expect(records.length).toBeGreaterThan(0);
          expect(captured).toHaveLength(0);
          if (outcome === "timeout") {
            expect(
              await observer.unsafe<{ id: string }[]>(
                `SELECT id FROM ${schema}.legislation_documents WHERE title <> 'Law'`,
              ),
            ).toHaveLength(0);
            expect(checkpoint).toMatchObject({
              cursor: null,
              batch: { size: 3 },
            });
            expect(
              await observer.unsafe<{ id: string }[]>(
                `SELECT id FROM ${schema}.legislation_documents WHERE slug IS NOT NULL`,
              ),
            ).toHaveLength(0);
          }
          if (outcome === "rollback") {
            expect(checkpoint).toBeUndefined();
            expect(
              await observer.unsafe<{ id: string }[]>(
                `SELECT id FROM ${schema}.legislation_documents WHERE slug IS NOT NULL`,
              ),
            ).toHaveLength(0);
          }
          fail = false;
          if (outcome !== "commit") {
            const retried = await step();
            expect(ranges).toEqual([null, null]);
            expect(retried.value.written).toBe(outcome === "timeout" ? 3 : 4);
          }
          await step();
          await step();
          expect(
            await observer.unsafe<{ id: string; slug: string | null }[]>(
              `(SELECT id, slug FROM ${schema}.legislation_documents EXCEPT SELECT id, regexp_replace(eli, '^.*/', '') || '-2012-sb-law' FROM ${schema}.legislation_documents) UNION ALL (SELECT id, regexp_replace(eli, '^.*/', '') || '-2012-sb-law' FROM ${schema}.legislation_documents EXCEPT SELECT id, slug FROM ${schema}.legislation_documents)`,
            ),
          ).toHaveLength(0);
          for (const record of records) {
            // Bun replaces nested values with asymmetric matchers; preserve shared verdicts.
            expect(structuredClone(record)).toMatchObject({
              config: { hardFloor: defaultConfig.hardFloor },
              verdict: { signals: expect.any(Array) },
            });
          }
        } finally {
          await runtime.close();
          await other.close();
          await index.close();
          indexConnection.release();
          await client.unsafe(`DROP SCHEMA ${schema} CASCADE`);
        }
      });
    });
  }
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
        const runtime = createScriptBackfillRuntime({
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
            const pageResult = await backfillStatuteSlugsPage({
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
            if (pageResult.isErr()) {
              throw pageResult.error.cause;
            }
            const page = pageResult.value;
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
            await client.unsafe<{ id: string }[]>(
              "SELECT id FROM legislation_documents WHERE slug IS NOT NULL",
            ),
          ).toHaveLength(0);
          expect(
            await client.unsafe<{ cursor: string | null }[]>(
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
            await client.unsafe<{ id: string }[]>(
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
            await client.unsafe<{ slug: string | null }[]>(
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
          const mismatch = await client.unsafe<{ id: string }[]>(
            "SELECT id FROM legislation_documents WHERE slug IS DISTINCT FROM CASE WHEN eli = '/eli/cz/sb' THEN NULL WHEN id = '019dd47d-f507-7c84-b827-000000000001' THEN 'app-assigned' ELSE (regexp_replace(eli, '^.*/', '') || '-2012-sb-law') END",
          );
          expect(mismatch).toHaveLength(0);
          for (const record of decisions) {
            // Bun replaces nested values with asymmetric matchers; preserve shared verdicts.
            expect(structuredClone(record)).toMatchObject({
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
});
