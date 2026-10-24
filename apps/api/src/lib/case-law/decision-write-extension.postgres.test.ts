import { describe, expect, test } from "bun:test";
import { type SQL, sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import { rejectionOf } from "@stll/property-testing/rejection";

import { createSafeId } from "@/api/lib/branded-types";
import { runDecisionWriteExtension } from "@/api/lib/case-law/decision-write-extension";
import { withExecutorSavepoint } from "@/api/lib/db/aggregate-lock";
import { executedRows } from "@/api/lib/db/executed-rows";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import type { GatedTestDb } from "@/api/tests/gated-test-database";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

const withSession = async (run: (db: GatedTestDb) => Promise<void>) => {
  if (!databaseUrl || !runPostgresTests) {
    return;
  }
  await withGatedTestClients(databaseUrl, async ({ openClient }) => {
    const { db } = openClient({ max: 1 });
    await db.execute(sql`CREATE TEMP TABLE decision_write_extension_scope (
      id uuid PRIMARY KEY,
      kind text NOT NULL
    )`);
    await run(db);
  });
};

const rowsOf = async (db: GatedTestDb) =>
  executedRows(
    await db.execute(
      sql`SELECT kind FROM decision_write_extension_scope ORDER BY kind`,
    ),
  );

if (!databaseUrl || !runPostgresTests) {
  describe.skip("decision write extension savepoints (postgres)", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {
      expect(runPostgresTests && Boolean(databaseUrl)).toBe(false);
    });
  });
} else {
  describe("decision write extension savepoints (postgres)", () => {
    test("a SQL error rolls back extension output and leaves the outer transaction usable", async () => {
      await withSession(async (db) => {
        const decisionId = createSafeId<"caseLawDecision">();
        await db.transaction(async (tx) => {
          await tx.execute(
            sql`INSERT INTO decision_write_extension_scope VALUES (${decisionId}::uuid, 'canonical')`,
          );
          const outcome = await runDecisionWriteExtension(tx, decisionId, {
            extension: async ({ tx: extensionTx }) => {
              await extensionTx.execute(
                sql`INSERT INTO decision_write_extension_scope VALUES (${createSafeId<"caseLawDecision">()}::uuid, 'extension')`,
              );
              await extensionTx.execute(sql`SELECT 1 / 0`);
              return { type: "applied" };
            },
          });
          expect(outcome).toEqual({ type: "deferred", reason: "failed" });
          await tx.execute(
            sql`INSERT INTO decision_write_extension_scope VALUES (${createSafeId<"caseLawDecision">()}::uuid, 'following')`,
          );
        });
        expect(await rowsOf(db)).toEqual([
          { kind: "canonical" },
          { kind: "following" },
        ]);
      });
    });

    test("applied extension output commits with its canonical row", async () => {
      await withSession(async (db) => {
        const decisionId = createSafeId<"caseLawDecision">();
        await db.transaction(async (tx) => {
          await tx.execute(
            sql`INSERT INTO decision_write_extension_scope VALUES (${decisionId}::uuid, 'canonical')`,
          );
          expect(
            await runDecisionWriteExtension(tx, decisionId, {
              extension: async ({ tx: extensionTx }) => {
                await extensionTx.execute(
                  sql`INSERT INTO decision_write_extension_scope VALUES (${createSafeId<"caseLawDecision">()}::uuid, 'extension')`,
                );
                return { type: "applied" };
              },
            }),
          ).toEqual({ type: "applied" });
        });
        expect(await rowsOf(db)).toEqual([
          { kind: "canonical" },
          { kind: "extension" },
        ]);
      });
    });

    test("an outer failure rolls back canonical and applied extension output together", async () => {
      await withSession(async (db) => {
        const decisionId = createSafeId<"caseLawDecision">();
        const failure = await rejectionOf(
          db.transaction(async (tx) => {
            await tx.execute(
              sql`INSERT INTO decision_write_extension_scope VALUES (${decisionId}::uuid, 'canonical')`,
            );
            expect(
              await runDecisionWriteExtension(tx, decisionId, {
                extension: async ({ tx: extensionTx }) => {
                  await extensionTx.execute(
                    sql`INSERT INTO decision_write_extension_scope VALUES (${createSafeId<"caseLawDecision">()}::uuid, 'extension')`,
                  );
                  return { type: "applied" };
                },
              }),
            ).toEqual({ type: "applied" });
            await tx.execute(sql`SELECT 1 / 0`);
          }),
        );
        expect(failure).toBeInstanceOf(Error);
        expect(await rowsOf(db)).toEqual([]);
      });
    });

    test("a query exceeding its deadline cancels without aborting the canonical transaction", async () => {
      await withSession(async (db) => {
        const decisionId = createSafeId<"caseLawDecision">();
        await db.transaction(async (tx) => {
          await tx.execute(
            sql`SELECT set_config('statement_timeout', '5s', true), set_config('lock_timeout', '2s', true)`,
          );
          const settings = executedRows(
            await tx.execute(
              sql`SELECT current_setting('statement_timeout') AS statement_timeout, current_setting('lock_timeout') AS lock_timeout`,
            ),
          );
          await tx.execute(
            sql`INSERT INTO decision_write_extension_scope VALUES (${decisionId}::uuid, 'canonical')`,
          );
          const dialect = new PgDialect();
          const sleepingQueries: string[] = [];
          const observedTx = {
            execute: async (query: SQL) => {
              const statement = dialect.sqlToQuery(query).sql;
              if (statement.includes("pg_sleep")) {
                sleepingQueries.push(statement);
              }
              return await tx.execute(query);
            },
          };
          const started = performance.now();
          const outcome = await runDecisionWriteExtension(
            observedTx,
            decisionId,
            {
              deadlineMs: 100,
              extension: async ({ tx: extensionTx }) => {
                await extensionTx.execute(
                  sql`INSERT INTO decision_write_extension_scope VALUES (${createSafeId<"caseLawDecision">()}::uuid, 'extension')`,
                );
                await extensionTx.execute(sql`SELECT pg_sleep(3)`);
                return { type: "applied" };
              },
            },
          );
          expect(outcome.type).toBe("deferred");
          expect(sleepingQueries).toHaveLength(1);
          expect(performance.now() - started).toBeLessThan(2500);
          expect(
            executedRows(
              await tx.execute(
                sql`SELECT current_setting('statement_timeout') AS statement_timeout, current_setting('lock_timeout') AS lock_timeout`,
              ),
            ),
          ).toEqual(settings);
          await tx.execute(
            sql`INSERT INTO decision_write_extension_scope VALUES (${createSafeId<"caseLawDecision">()}::uuid, 'following')`,
          );
        });
        expect(await rowsOf(db)).toEqual([
          { kind: "canonical" },
          { kind: "following" },
        ]);
      });
    });

    test("reentrant extension admission cannot corrupt the active savepoint", async () => {
      await withSession(async (db) => {
        const decisionId = createSafeId<"caseLawDecision">();
        await db.transaction(async (tx) => {
          await tx.execute(
            sql`INSERT INTO decision_write_extension_scope VALUES (${decisionId}::uuid, 'canonical')`,
          );
          expect(
            await runDecisionWriteExtension(tx, decisionId, {
              extension: async ({ tx: extensionTx }) => {
                expect(
                  await rejectionOf(
                    runDecisionWriteExtension(tx, decisionId, {
                      extension: async () => ({ type: "applied" }),
                    }),
                  ),
                ).toMatchObject({
                  message:
                    "Await the executor savepoint before reusing its transaction",
                });
                await extensionTx.execute(
                  sql`INSERT INTO decision_write_extension_scope VALUES (${createSafeId<"caseLawDecision">()}::uuid, 'extension')`,
                );
                return { type: "applied" };
              },
            }),
          ).toEqual({ type: "applied" });
        });
        expect(await rowsOf(db)).toEqual([
          { kind: "canonical" },
          { kind: "extension" },
        ]);
      });
    });

    test("a cleanup failure refuses publication and aborts the outer write", async () => {
      await withSession(async (db) => {
        const decisionId = createSafeId<"caseLawDecision">();
        const failure = new Error("release failed");
        const dialect = new PgDialect();
        expect(
          await rejectionOf(
            db.transaction(async (tx) => {
              await tx.execute(
                sql`INSERT INTO decision_write_extension_scope VALUES (${decisionId}::uuid, 'canonical')`,
              );
              const failingCleanup = {
                execute: async (query: SQL) => {
                  if (
                    dialect
                      .sqlToQuery(query)
                      .sql.startsWith("RELEASE SAVEPOINT")
                  ) {
                    throw failure;
                  }
                  return await tx.execute(query);
                },
              };
              await runDecisionWriteExtension(failingCleanup, decisionId, {
                extension: async ({ tx: extensionTx }) => {
                  await extensionTx.execute(
                    sql`INSERT INTO decision_write_extension_scope VALUES (${createSafeId<"caseLawDecision">()}::uuid, 'extension')`,
                  );
                  return { type: "applied" };
                },
              });
            }),
          ),
        ).toBe(failure);
        expect(await rowsOf(db)).toEqual([]);
      });
    });

    test("a typed savepoint refusal keeps only writes outside its scope", async () => {
      await withSession(async (db) => {
        await db.transaction(async (tx) => {
          await tx.execute(
            sql`INSERT INTO decision_write_extension_scope VALUES (${createSafeId<"caseLawDecision">()}::uuid, 'canonical')`,
          );
          expect(
            await withExecutorSavepoint(tx, async () => {
              await tx.execute(
                sql`INSERT INTO decision_write_extension_scope VALUES (${createSafeId<"caseLawDecision">()}::uuid, 'extension')`,
              );
              return { type: "rollback", value: "pending" };
            }),
          ).toMatchObject({ value: "pending" });
          await tx.execute(
            sql`INSERT INTO decision_write_extension_scope VALUES (${createSafeId<"caseLawDecision">()}::uuid, 'following')`,
          );
        });
        expect(await rowsOf(db)).toEqual([
          { kind: "canonical" },
          { kind: "following" },
        ]);
      });
    });

    test("overlapping savepoint admission is refused and the first scope still commits", async () => {
      await withSession(async (db) => {
        await db.transaction(async (tx) => {
          const entered = Promise.withResolvers<undefined>();
          const release = Promise.withResolvers<undefined>();
          const first = withExecutorSavepoint(tx, async () => {
            await tx.execute(
              sql`INSERT INTO decision_write_extension_scope VALUES (${createSafeId<"caseLawDecision">()}::uuid, 'first')`,
            );
            entered.resolve(undefined);
            await release.promise;
            return { type: "commit", value: "first" };
          });
          try {
            await Promise.race([entered.promise, first]);
            expect(
              await rejectionOf(
                withExecutorSavepoint(tx, async () => ({
                  type: "commit",
                  value: "second",
                })),
              ),
            ).toMatchObject({
              message:
                "Await the executor savepoint before reusing its transaction",
            });
          } finally {
            release.resolve(undefined);
            await first;
          }
          await tx.execute(
            sql`INSERT INTO decision_write_extension_scope VALUES (${createSafeId<"caseLawDecision">()}::uuid, 'following')`,
          );
        });
        expect(await rowsOf(db)).toEqual([
          { kind: "first" },
          { kind: "following" },
        ]);
      });
    });

    test("overlapping decision extensions cannot change the active timeout scope", async () => {
      await withSession(async (db) => {
        await db.transaction(async (tx) => {
          await tx.execute(
            sql`SELECT set_config('statement_timeout', '0', true), set_config('lock_timeout', '0', true)`,
          );
          const settingsBefore = executedRows(
            await tx.execute(
              sql`SELECT current_setting('statement_timeout') AS statement_timeout, current_setting('lock_timeout') AS lock_timeout`,
            ),
          );
          const dialect = new PgDialect();
          const timeoutSettings = Promise.withResolvers<undefined>();
          const releaseFirst = Promise.withResolvers<undefined>();
          const statements: string[] = [];
          let paused = false;
          let firstObservedSettings: unknown[] | undefined;
          const observedTx = {
            execute: async (query: SQL) => {
              const statement = dialect.sqlToQuery(query).sql;
              statements.push(statement);
              const result = await tx.execute(query);
              if (statement.includes("set_config") && !paused) {
                paused = true;
                timeoutSettings.resolve(undefined);
                await releaseFirst.promise;
              }
              return result;
            },
          };
          const decisionId = createSafeId<"caseLawDecision">();
          const first = runDecisionWriteExtension(observedTx, decisionId, {
            deadlineMs: 5000,
            extension: async ({ tx: extensionTx }) => {
              firstObservedSettings = executedRows(
                await extensionTx.execute(
                  sql`SELECT current_setting('statement_timeout')::interval > interval '0' AND current_setting('statement_timeout')::interval <= interval '5 seconds' AS statement_timeout_bounded, current_setting('lock_timeout')::interval > interval '0' AND current_setting('lock_timeout')::interval <= interval '5 seconds' AS lock_timeout_bounded`,
                ),
              );
              return { type: "applied" };
            },
          });

          try {
            await Promise.race([timeoutSettings.promise, first]);
            const statementCountAtPause = statements.length;
            expect(paused).toBe(true);
            expect(statements.at(-1)?.includes("set_config")).toBe(true);
            expect(
              await rejectionOf(
                runDecisionWriteExtension(observedTx, decisionId, {
                  extension: async () => ({ type: "applied" }),
                }),
              ),
            ).toMatchObject({
              message:
                "Await the executor savepoint before reusing its transaction",
            });
            expect(statements).toHaveLength(statementCountAtPause);
          } finally {
            releaseFirst.resolve(undefined);
            await first;
          }

          expect(
            statements.some((statement) => statement.includes("set_config")),
          ).toBe(true);
          expect(firstObservedSettings).toEqual([
            {
              statement_timeout_bounded: true,
              lock_timeout_bounded: true,
            },
          ]);
          expect(await first).toEqual({ type: "applied" });
          const observedSettings = executedRows(
            await tx.execute(
              sql`SELECT current_setting('statement_timeout') AS statement_timeout, current_setting('lock_timeout') AS lock_timeout`,
            ),
          );
          expect(observedSettings).toEqual(settingsBefore);
        });
      });
    });
  });
}
