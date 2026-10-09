import { panic, Panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { DrizzleQueryError, eq, sql } from "drizzle-orm";
import { integer, pgTable } from "drizzle-orm/pg-core";

import { organization, user } from "@/api/db/auth-schema";
import { SETTING_WORKSPACE_IDS } from "@/api/db/rls";
import type { Transaction } from "@/api/db/root";
import type { SafeDb, SafeDbRetryConfig } from "@/api/db/safe-db";
import { workspaces } from "@/api/db/schema";
import { createSafeDb, markRlsDatabase } from "@/api/db/scoped";
import { createSafeId } from "@/api/lib/branded-types";
import { DatabaseError } from "@/api/lib/errors/tagged-errors";
import { withGatedTestClients } from "@/api/tests/gated-test-database";

import { mintAuthProviderId } from "./auth-provider-id";
import { withInterleaving } from "./transaction-interleaving";
import {
  assertLockRanks,
  createTransactionRecorder,
  NO_ADVISORY_LOCKS,
} from "./transaction-recorder";
import type { TransactionTrace } from "./transaction-recorder";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const table = pgTable("recorder_rows", { id: integer().primaryKey() });

if (!databaseUrl || !runPostgresTests) {
  describe.skip("real transaction recording", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {});
  });
} else {
  describe("real transaction recording", () => {
    test("records alias UPDATE writes against the real table", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db } = openClient();
        // @ts-expect-error Every transaction recorder must choose its advisory-lock collaborator.
        createTransactionRecorder({});
        const recorder = createTransactionRecorder({
          resolveAdvisory: NO_ADVISORY_LOCKS,
          tables: { recorder_entities: "entity" },
        });
        await db.transaction(async (tx) => {
          await tx.execute(
            sql`CREATE TEMP TABLE recorder_entities (id integer PRIMARY KEY)`,
          );
          await tx.execute(sql`INSERT INTO recorder_entities VALUES (1)`);
          const trace: TransactionTrace = { events: [] };
          const restore = recorder.instrument(tx, trace);
          try {
            for (const statement of [
              sql`UPDATE recorder_entities AS e SET id = e.id`,
              sql`UPDATE recorder_entities e SET id = e.id`,
              sql`UPDATE recorder_entities AS "set" SET id = "set".id`,
              sql`UPDATE recorder_entities SET id = id`,
            ]) {
              trace.events.length = 0;
              await tx.execute(statement);
              expect(
                trace.events.map((event) => [
                  event.type,
                  event.aggregate,
                  event.mode,
                  "table" in event ? event.table : undefined,
                ]),
              ).toEqual([
                ["firstWrite", "entity", "update", "recorder_entities"],
                ["writeLock", "entity", "update", "recorder_entities"],
              ]);
            }
          } finally {
            restore();
          }
        });
      });
    });

    test("attributes outer row locks to their enclosing SELECT across closed subqueries", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db } = openClient();
        const recorder = createTransactionRecorder({
          resolveAdvisory: NO_ADVISORY_LOCKS,
          tables: {
            recorder_workspaces: "workspace",
            recorder_entities: "entity",
          },
        });
        await db.transaction(async (tx) => {
          await tx.execute(
            sql`CREATE TEMP TABLE recorder_workspaces (id integer PRIMARY KEY)`,
          );
          await tx.execute(
            sql`CREATE TEMP TABLE recorder_entities (id integer PRIMARY KEY)`,
          );
          await tx.execute(sql`INSERT INTO recorder_workspaces VALUES (1)`);
          await tx.execute(sql`INSERT INTO recorder_entities VALUES (1)`);
          const trace: TransactionTrace = { events: [] };
          const restore = recorder.instrument(tx, trace);
          try {
            for (const statement of [
              sql`SELECT * FROM recorder_workspaces WHERE id IN (SELECT id FROM recorder_entities) FOR UPDATE`,
              sql`SELECT (SELECT id FROM recorder_entities) AS entity_id FROM recorder_workspaces FOR UPDATE`,
              sql`SELECT * FROM recorder_workspaces WHERE EXISTS (SELECT 1 FROM recorder_entities WHERE id IN (SELECT id FROM recorder_entities)) FOR UPDATE`,
              sql`WITH locked AS (SELECT * FROM recorder_workspaces WHERE id IN (SELECT id FROM recorder_entities) FOR UPDATE) SELECT * FROM locked`,
              sql`SELECT * FROM recorder_workspaces w WHERE id IN (SELECT id FROM recorder_entities) FOR UPDATE OF w`,
            ]) {
              trace.events.length = 0;
              const rows = await tx.execute(statement);
              expect(rows).toHaveLength(1);
              expect(
                trace.events.map((event) => [
                  event.type,
                  event.aggregate,
                  "table" in event ? event.table : undefined,
                ]),
              ).toEqual([["rowLock", "workspace", "recorder_workspaces"]]);
            }
          } finally {
            restore();
          }
        });
      });
    });

    test("records raw and builder lock modes, bound parameters, and only the first successful write", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db } = openClient();
        const recorder = createTransactionRecorder({
          resolveAdvisory: NO_ADVISORY_LOCKS,
          tables: { recorder_rows: "workspace" },
        });
        await recorder.wrap(db.transaction.bind(db))(async (tx) => {
          await tx.execute(
            sql`CREATE TEMP TABLE recorder_rows (id integer PRIMARY KEY)`,
          );
          await tx.update(table).set({ id: 99 }).where(eq(table.id, 99));
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
            sql`WITH locked AS (SELECT * FROM recorder_rows FOR UPDATE) SELECT * FROM locked`,
          );
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
          ["writeLock", "insert into"],
          ["writeLock", "update"],
          ["rowLock", "key share"],
          ["rowLock", "no key update"],
          ["rowLock", "share"],
          ["rowLock", "update"],
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
          resolveAdvisory: NO_ADVISORY_LOCKS,
          tables: {
            recorder_entities: "entity",
            recorder_workspaces: "workspace",
          },
        });
        await db.transaction(async (tx) => {
          await tx.execute(
            sql`CREATE TEMP TABLE recorder_entities (id integer PRIMARY KEY)`,
          );
          await tx.execute(
            sql`CREATE TEMP TABLE recorder_workspaces (id integer PRIMARY KEY)`,
          );
          await tx.execute(sql`INSERT INTO recorder_entities VALUES (1)`);
          await tx.execute(sql`INSERT INTO recorder_workspaces VALUES (1)`);
          const trace: TransactionTrace = { events: [] };
          const restore = recorder.instrument(tx, trace);
          try {
            await tx.execute(sql`SELECT * FROM recorder_entities FOR UPDATE`);
            await tx.execute(
              sql`SELECT * FROM recorder_workspaces FOR KEY SHARE`,
            );
            expect(() => assertLockRanks(trace)).toThrow(
              "Lock rank inversion: entity before workspace",
            );
          } finally {
            restore();
          }
        });
      });
    });

    test.each(["UPDATE", "DELETE"] as const)(
      "detects %s write acquisition before a workspace lock and repeated write inversions",
      async (operation) => {
        await withGatedTestClients(databaseUrl, async ({ openClient }) => {
          const { db } = openClient();
          const recorder = createTransactionRecorder({
            resolveAdvisory: NO_ADVISORY_LOCKS,
            tables: {
              recorder_entities: "entity",
              recorder_workspaces: "workspace",
            },
          });
          await db.transaction(async (tx) => {
            await tx.execute(
              sql`CREATE TEMP TABLE recorder_entities (id integer PRIMARY KEY)`,
            );
            await tx.execute(
              sql`CREATE TEMP TABLE recorder_workspaces (id integer PRIMARY KEY)`,
            );
            await tx.execute(
              sql`INSERT INTO recorder_entities VALUES (1), (2)`,
            );
            await tx.execute(
              sql`INSERT INTO recorder_workspaces VALUES (1), (2)`,
            );
            const trace: TransactionTrace = { events: [] };
            const restore = recorder.instrument(tx, trace);
            const write = (target: string, id: number) =>
              operation === "UPDATE"
                ? sql`UPDATE ${sql.identifier(target)} SET id = id WHERE id = ${id}`
                : sql`DELETE FROM ${sql.identifier(target)} WHERE id = ${id}`;
            try {
              await tx.execute(write("recorder_entities", 1));
              await tx.execute(
                sql`SELECT * FROM recorder_workspaces WHERE id = 1 FOR KEY SHARE`,
              );
              expect(() => assertLockRanks(trace)).toThrow(
                "Lock rank inversion: entity before workspace",
              );
              trace.events.length = 0;
              await tx.execute(write("recorder_workspaces", 1));
              await tx.execute(
                sql`SELECT * FROM recorder_entities WHERE id = 2 FOR UPDATE`,
              );
              await tx.execute(write("recorder_workspaces", 2));
              expect(() => assertLockRanks(trace)).toThrow(
                "Lock rank inversion: entity before workspace",
              );
              expect(
                trace.events.filter(({ type }) => type === "firstWrite"),
              ).toHaveLength(1);
              expect(
                trace.events.filter(({ type }) => type === "writeLock"),
              ).toHaveLength(2);
            } finally {
              restore();
            }
          });
        });
      },
    );

    test("records the real safeDb primitive during an RLS-scoped interleaving and preserves Result and retry options", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const owner = openClient();
        const orgId = mintAuthProviderId<"organization">();
        const userId = mintAuthProviderId<"user">();
        const workspaceId = createSafeId<"workspace">();
        const hiddenWorkspaceId = createSafeId<"workspace">();
        const tableName = `recorder_rls_${Bun.randomUUIDv7().replaceAll("-", "")}`;
        const rows = sql.identifier(tableName);
        await owner.db.insert(organization).values({
          id: orgId,
          name: "Recorder fixture",
          slug: orgId,
          createdAt: new Date(),
        });
        try {
          await owner.db.insert(user).values({
            id: userId,
            name: "Recorder actor",
            email: `${userId}@example.test`,
          });
          await owner.db.insert(workspaces).values({
            id: workspaceId,
            organizationId: orgId,
            name: "Recorder matter",
            reference: workspaceId,
          });
          await owner.db.execute(
            sql`CREATE TABLE ${rows} (workspace_id uuid PRIMARY KEY, value integer NOT NULL)`,
          );
          await owner.db.execute(
            sql`ALTER TABLE ${rows} ENABLE ROW LEVEL SECURITY`,
          );
          await owner.db.execute(
            sql`CREATE POLICY recorder_scope ON ${rows} TO stella USING (workspace_id = ANY(current_setting('${sql.raw(SETTING_WORKSPACE_IDS)}', true)::uuid[])) WITH CHECK (workspace_id = ANY(current_setting('${sql.raw(SETTING_WORKSPACE_IDS)}', true)::uuid[]))`,
          );
          await owner.db.execute(
            sql`GRANT SELECT, UPDATE ON ${rows} TO stella`,
          );
          const recorder = createTransactionRecorder({
            tables: { workspaces: "workspace", [tableName]: "run" },
            resolveAdvisory: () => "workspace",
          });
          const retry = {
            retry: { times: 0, delayMs: 0, backoff: "constant" },
          } satisfies SafeDbRetryConfig;
          const passedRetry: (SafeDbRetryConfig | undefined)[] = [];
          const runner = () => {
            const configured = createSafeDb(
              markRlsDatabase(openClient().db),
              [workspaceId],
              orgId,
              userId,
            );
            const observed: SafeDb = async (work, options) => {
              passedRetry.push(options);
              return await configured(work, options);
            };
            const safeDb = recorder.wrapSafeDb(observed);
            return {
              safeDb,
              transaction: async <T>(work: (tx: Transaction) => Promise<T>) =>
                (await safeDb(work, retry)).unwrap(),
            };
          };
          const first = runner();
          const second = runner();
          const participant = (transaction: typeof first.transaction) => ({
            transaction,
            steps: [
              {
                name: "write",
                run: async (tx: Transaction) => {
                  const read = tx.query.workspaces.findFirst({
                    where: { id: { eq: workspaceId } },
                    columns: { id: true },
                  });
                  // The installed relational builder has no locking method.
                  expect("for" in read).toBe(false);
                  expect(await read).toEqual({ id: workspaceId });
                  await tx
                    .select({ id: workspaces.id })
                    .from(workspaces)
                    .where(eq(workspaces.id, workspaceId))
                    .for("key share");
                  await tx.execute(
                    sql`SELECT pg_advisory_xact_lock(hashtextextended(${workspaceId}, 0))`,
                  );
                  const visible = await tx
                    .select({ workspaceId: sql<string>`workspace_id` })
                    .from(sql`${rows}`);
                  expect(visible).toEqual([{ workspaceId }]);
                  await tx.execute(
                    sql`WITH locked AS (SELECT * FROM ${rows} FOR UPDATE) SELECT * FROM locked`,
                  );
                  await tx.execute(
                    sql`UPDATE ${rows} SET value = value + 1 WHERE workspace_id = ${workspaceId}`,
                  );
                },
              },
            ],
          });
          let invariantCalls = 0;
          const results = await withInterleaving({
            databaseUrl,
            a: participant(first.transaction),
            b: participant(second.transaction),
            schedules: [["a.write", "b.write", "a.commit", "b.commit"]],
            reset: async () => {
              await owner.db.execute(sql`TRUNCATE ${rows}`);
              await owner.db.execute(
                sql`INSERT INTO ${rows} VALUES (${workspaceId}, 0), (${hiddenWorkspaceId}, 0)`,
              );
            },
            readState: async () =>
              await owner.db
                .select({
                  workspaceId: sql<string>`workspace_id`,
                  value: sql<number>`value`,
                })
                .from(sql`${rows}`),
            invariant: ({ state, outcomes, blocked }) => {
              invariantCalls += 1;
              expect(outcomes).toEqual({
                a: { status: "committed" },
                b: { status: "committed" },
              });
              expect(blocked).toContain("b.write");
              expect(
                state.find((row) => row.workspaceId === workspaceId)?.value,
              ).toBe(2);
              expect(
                state.find((row) => row.workspaceId === hiddenWorkspaceId)
                  ?.value,
              ).toBe(0);
            },
          });
          expect(results).toHaveLength(1);
          expect(invariantCalls).toBe(1);
          expect(passedRetry).toEqual([retry, retry]);
          expect(recorder.transactions).toHaveLength(2);
          for (const trace of recorder.transactions) {
            expect(
              trace.events.map(({ type, aggregate }) => [type, aggregate]),
            ).toEqual([
              ["rowLock", "workspace"],
              ["advisoryLock", "workspace"],
              ["rowLock", "run"],
              ["firstWrite", "run"],
              ["writeLock", "run"],
            ]);
            assertLockRanks(trace);
          }
          const failure = await first.safeDb(
            async (tx) =>
              await tx.execute(sql`SELECT * FROM missing_recorder_table`),
            retry,
          );
          expect(failure.isErr()).toBe(true);
          if (failure.isErr()) {
            expect(DatabaseError.is(failure.error)).toBe(true);
          }
        } finally {
          await owner.db.execute(sql`DROP TABLE IF EXISTS ${rows}`);
          await owner.db.delete(organization).where(eq(organization.id, orgId));
          await owner.db.delete(user).where(eq(user.id, userId));
        }
      });
    });

    test("rejects ambiguous joined locks and records one explicit OF target", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db } = openClient();
        await db.execute(
          sql`CREATE TEMP TABLE recorder_workspaces (id integer PRIMARY KEY)`,
        );
        await db.execute(
          sql`CREATE TEMP TABLE recorder_entities (id integer PRIMARY KEY)`,
        );
        await db.execute(sql`INSERT INTO recorder_workspaces VALUES (1)`);
        await db.execute(sql`INSERT INTO recorder_entities VALUES (1)`);
        const recorder = createTransactionRecorder({
          resolveAdvisory: NO_ADVISORY_LOCKS,
          tables: {
            recorder_workspaces: "workspace",
            recorder_entities: "entity",
          },
        });
        const outcome = await Result.tryPromise(
          async () =>
            await recorder.wrap(db.transaction.bind(db))(
              async (tx) =>
                await tx.execute(
                  sql`SELECT * FROM recorder_workspaces JOIN recorder_entities USING (id) FOR UPDATE`,
                ),
            ),
        );
        expect(outcome.isErr()).toBe(true);
        if (outcome.isErr()) {
          expect(outcome.error.cause).toBeInstanceOf(DrizzleQueryError);
          if (outcome.error.cause instanceof DrizzleQueryError) {
            const cause = outcome.error.cause.cause;
            expect(Panic.is(cause)).toBe(true);
            if (Panic.is(cause)) {
              expect(cause.message).toContain(
                "Record row locks with one explicit table target per statement",
              );
            }
          }
        }
        await recorder.wrap(db.transaction.bind(db))(async (tx) => {
          await tx.execute(
            sql`SELECT * FROM recorder_workspaces JOIN recorder_entities USING (id) FOR UPDATE OF recorder_workspaces`,
          );
        });
        expect(
          recorder.transactions.map(({ events }) =>
            events.map(({ type, aggregate }) => [type, aggregate]),
          ),
        ).toEqual([[], [["rowLock", "workspace"]]]);
      });
    });

    test.each([
      {
        name: "CTE row lock and write",
        statement: sql`WITH locked AS (SELECT * FROM recorder_entities FOR UPDATE) UPDATE recorder_workspaces SET id = recorder_workspaces.id FROM locked`,
        message: "Record writes and explicit locks in separate statements",
      },
      {
        name: "advisory lock and write",
        statement: sql`UPDATE recorder_workspaces SET id = id WHERE pg_advisory_xact_lock(880000001) IS NULL`,
        message: "Record writes and explicit locks in separate statements",
      },
      {
        name: "multiple CTE writes",
        statement: sql`WITH changed AS (UPDATE recorder_entities SET id = id RETURNING id) UPDATE recorder_workspaces SET id = recorder_workspaces.id FROM changed`,
        message: "Record writes in separate statements",
      },
    ])(
      "rejects ambiguous acquisition order: $name",
      async ({ statement, message }) => {
        await withGatedTestClients(databaseUrl, async ({ openClient }) => {
          const { db } = openClient();
          const recorder = createTransactionRecorder({
            tables: {
              recorder_entities: "entity",
              recorder_workspaces: "workspace",
            },
            resolveAdvisory: () => "workspace",
          });
          const outcome = await Result.tryPromise(
            async () =>
              await db.transaction(async (tx) => {
                await tx.execute(
                  sql`CREATE TEMP TABLE recorder_entities (id integer PRIMARY KEY)`,
                );
                await tx.execute(
                  sql`CREATE TEMP TABLE recorder_workspaces (id integer PRIMARY KEY)`,
                );
                await tx.execute(sql`INSERT INTO recorder_entities VALUES (1)`);
                await tx.execute(
                  sql`INSERT INTO recorder_workspaces VALUES (1)`,
                );
                const trace: TransactionTrace = { events: [] };
                const restore = recorder.instrument(tx, trace);
                try {
                  await tx.execute(statement);
                } finally {
                  restore();
                  expect(trace.events).toEqual([]);
                }
              }),
          );
          expect(outcome.isErr()).toBe(true);
          if (outcome.isErr()) {
            expect(outcome.error.cause).toBeInstanceOf(DrizzleQueryError);
            if (outcome.error.cause instanceof DrizzleQueryError) {
              const cause = outcome.error.cause.cause;
              expect(Panic.is(cause)).toBe(true);
              if (Panic.is(cause)) {
                expect(cause.message).toContain(message);
              }
            }
          }
        });
      },
    );
  });
}
