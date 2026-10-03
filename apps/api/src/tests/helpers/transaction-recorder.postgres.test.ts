import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { integer, pgTable } from "drizzle-orm/pg-core";

import { withGatedTestClients } from "@/api/tests/gated-test-database";

import {
  assertLockRanks,
  createTransactionRecorder,
} from "./transaction-recorder";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const table = pgTable("recorder_rows", { id: integer().primaryKey() });

if (runPostgresTests && databaseUrl) {
  describe("real transaction recording", () => {
    test("records raw and builder lock modes, bound parameters, and only the first successful write", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db } = openClient();
        const recorder = createTransactionRecorder({
          tables: { recorder_rows: "workspace" },
        });
        await recorder.wrap(db.transaction.bind(db))(async (tx) => {
          await tx.execute(
            sql`CREATE TEMP TABLE recorder_rows (id integer PRIMARY KEY)`,
          );
          await tx.insert(table).values({ id: 1 });
          await tx.update(table).set({ id: 1 }).where(eq(table.id, 1));
          await tx.select().from(table).where(eq(table.id, 1)).for("key share");
          await tx.execute(
            sql`SELECT * FROM recorder_rows WHERE id = ${1} FOR NO KEY UPDATE`,
          );
          await tx.transaction(async (nested) => {
            await nested.execute(sql`SELECT * FROM recorder_rows FOR SHARE`);
          });
          await tx.execute(sql`SELECT * FROM recorder_rows FOR UPDATE`);
          await tx.execute(
            sql`SELECT * FROM recorder_rows WHERE false FOR UPDATE`,
          );
          await tx.execute(
            sql`SELECT '--', 'FOR UPDATE', 'UPDATE recorder_rows SET id = 2'`,
          );
        });
        const trace =
          recorder.transactions.at(0) ?? panic("Missing transaction trace");
        expect(trace.events.map(({ type, mode }) => [type, mode])).toEqual([
          ["firstWrite", "insert into"],
          ["rowLock", "key share"],
          ["rowLock", "no key update"],
          ["rowLock", "share"],
          ["rowLock", "update"],
        ]);
        expect(
          trace.events.find(({ mode }) => mode === "no key update")?.params,
        ).toEqual([1]);
        assertLockRanks(trace);
      });
    });

    test("records successful advisory acquisitions and excludes failed try-locks and rejected queries", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const holder = openClient();
        const contender = openClient();
        const pid = (
          await holder.db.execute(sql`SELECT pg_backend_pid() AS pid`)
        ).at(0)?.["pid"];
        if (typeof pid !== "number") {
          panic("Missing fixture backend pid");
        }
        const key = 8_000_000_000 + pid;
        const recorder = createTransactionRecorder({
          resolveAdvisory: () => "workspace",
        });
        await holder.db.transaction(async (tx) => {
          await tx.execute(sql`SELECT pg_advisory_xact_lock(${key})`);
          await recorder.wrap(contender.db.transaction.bind(contender.db))(
            async (other) => {
              await other.execute(
                sql`SELECT pg_try_advisory_xact_lock(${key})`,
              );
              await other.execute(
                sql`SELECT pg_try_advisory_xact_lock(${key + 1})`,
              );
              await other.execute(
                sql`SELECT pg_advisory_xact_lock_shared(${key + 2})`,
              );
              await other.execute(sql`SELECT pg_advisory_lock(${key + 3})`);
              await other.execute(
                sql`SELECT pg_advisory_lock_shared(${key + 4})`,
              );
              await other.execute(sql`SELECT pg_try_advisory_lock(${key + 5})`);
              await other.execute(
                sql`SELECT pg_try_advisory_lock_shared(${key + 6})`,
              );
              await other.execute(
                sql`SELECT pg_try_advisory_xact_lock_shared(${key + 7})`,
              );
            },
          );
        });
        const outcome = await Result.tryPromise(async () => {
          await recorder.wrap(contender.db.transaction.bind(contender.db))(
            async (tx) => {
              await tx.execute(
                sql`SELECT * FROM missing_recorder_table FOR UPDATE`,
              );
            },
          );
        });
        expect(outcome.isErr()).toBe(true);
        expect(
          recorder.transactions.map(({ events }) =>
            events.map(({ mode }) => mode),
          ),
        ).toEqual([
          [
            "pg_try_advisory_xact_lock",
            "pg_advisory_xact_lock_shared",
            "pg_advisory_lock",
            "pg_advisory_lock_shared",
            "pg_try_advisory_lock",
            "pg_try_advisory_lock_shared",
            "pg_try_advisory_xact_lock_shared",
          ],
          [],
        ]);
      });
    });

    test("detects inversion in statements executed on the real transaction", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db } = openClient();
        const recorder = createTransactionRecorder({
          tables: {
            recorder_entities: "entity",
            recorder_workspaces: "workspace",
          },
        });
        await recorder.wrap(db.transaction.bind(db))(async (tx) => {
          await tx.execute(
            sql`CREATE TEMP TABLE recorder_entities (id integer PRIMARY KEY)`,
          );
          await tx.execute(
            sql`CREATE TEMP TABLE recorder_workspaces (id integer PRIMARY KEY)`,
          );
          await tx.execute(sql`INSERT INTO recorder_entities VALUES (1)`);
          await tx.execute(sql`INSERT INTO recorder_workspaces VALUES (1)`);
          await tx.execute(sql`SELECT * FROM recorder_entities FOR UPDATE`);
          await tx.execute(
            sql`SELECT * FROM recorder_workspaces FOR KEY SHARE`,
          );
        });
        const trace =
          recorder.transactions.at(0) ?? panic("Missing transaction trace");
        expect(() => assertLockRanks(trace)).toThrow(
          "Lock rank inversion: entity before workspace",
        );
      });
    });
  });
} else {
  describe.skip("real transaction recording", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {});
  });
}
