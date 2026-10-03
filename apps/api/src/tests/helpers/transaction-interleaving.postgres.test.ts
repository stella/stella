import { panic, TaggedError } from "better-result";
import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import { withGatedTestClients } from "@/api/tests/gated-test-database";

import {
  InterleavingTimeout,
  withInterleaving,
} from "./transaction-interleaving";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgres = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

class FixtureRefusal extends TaggedError("FixtureRefusal")<{
  message: string;
}> {}

if (!databaseUrl || !runPostgres) {
  describe.skip("transaction interleaving (postgres)", () => {
    test("requires DATABASE_URL and STELLA_RUN_POSTGRES_TESTS=true", () => {});
  });
} else {
  const withFixture = async <T>(
    run: (fixture: {
      rows: ReturnType<typeof sql.raw>;
      reset: () => Promise<void>;
      readState: () => Promise<{ id: number; status: string }[]>;
    }) => Promise<T>,
  ) =>
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const { db } = openClient();
      const rows = sql.raw(
        `interleaving_${Bun.randomUUIDv7().replaceAll("-", "")}`,
      );
      await db.execute(
        sql`CREATE TABLE ${rows} (id integer PRIMARY KEY, status text NOT NULL)`,
      );
      try {
        return await run({
          rows,
          reset: async () => {
            await db.execute(sql`TRUNCATE ${rows}`);
            await db.execute(sql`INSERT INTO ${rows} VALUES (0, 'active')`);
          },
          readState: async () =>
            await db
              .select({ id: sql<number>`id`, status: sql<string>`status` })
              .from(rows)
              .orderBy(sql`id`),
        });
      } finally {
        await db.execute(sql`DROP TABLE ${rows}`);
      }
    });

  describe("transaction interleaving (postgres)", () => {
    test("finds an unlocked count cap violation and preserves the locked cap in every schedule", async () => {
      await withFixture(async ({ rows, reset, readState }) => {
        const runCap = async (mode: "unlocked" | "locked") => {
          const counts = { a: 0, b: 0 };
          const participant = (actor: "a" | "b", id: number) => ({
            steps: [
              {
                name: "count",
                run: async (tx: Transaction) => {
                  if (mode === "locked") {
                    await tx.execute(
                      sql`SELECT * FROM ${rows} WHERE id = 0 FOR UPDATE`,
                    );
                  }
                  const count = await tx
                    .select({ count: sql<number>`count(*)::int` })
                    .from(rows)
                    .where(sql`id <> 0`);
                  counts[actor] =
                    count.at(0)?.count ?? panic("Count fixture missing");
                },
              },
              {
                name: "insert",
                run: async (tx: Transaction) => {
                  if (counts[actor] === 0) {
                    await tx.execute(
                      sql`INSERT INTO ${rows} VALUES (${id}, 'active')`,
                    );
                  }
                },
              },
            ],
          });
          return await withInterleaving({
            databaseUrl,
            a: participant("a", 1),
            b: participant("b", 2),
            reset,
            readState,
            invariant: ({ outcomes, state }) => {
              expect(outcomes).toEqual({
                a: { status: "committed" },
                b: { status: "committed" },
              });
              if (mode === "locked") {
                expect(state.filter(({ id }) => id !== 0)).toHaveLength(1);
              }
            },
          });
        };
        const red = await runCap("unlocked");
        expect(red).toHaveLength(20);
        const violation =
          red.find(({ state }) => state.length === 3) ??
          panic("Unlocked cap violation not found");
        const firstCommit = violation.executed.findIndex((token) =>
          token.endsWith(".commit"),
        );
        expect(violation.executed.indexOf("a.count")).toBeLessThan(firstCommit);
        expect(violation.executed.indexOf("b.count")).toBeLessThan(firstCommit);
        const green = await runCap("locked");
        expect(green).toHaveLength(red.length);
        expect(green.some(({ blocked }) => blocked.length > 0)).toBe(true);
      });
    }, 30_000);

    test("finds a stale status write and preserves conditional transitions in every schedule", async () => {
      await withFixture(async ({ rows, reset, readState }) => {
        const runStatus = async (mode: "unconditional" | "cas") => {
          const observed = { a: "", b: "" };
          const participant = (actor: "a" | "b", status: string) => ({
            steps: [
              {
                name: "read",
                run: async (tx: Transaction) => {
                  const current = await tx
                    .select({ status: sql<string>`status` })
                    .from(rows)
                    .where(sql`id = 0`);
                  observed[actor] =
                    current.at(0)?.status ?? panic("Status fixture missing");
                },
              },
              {
                name: "write",
                run: async (tx: Transaction) => {
                  if (observed[actor] !== "active") {
                    return;
                  }
                  const predicate =
                    mode === "cas" ? sql`AND status = 'active'` : sql``;
                  await tx.execute(
                    sql`UPDATE ${rows} SET status = ${status} WHERE id = 0 ${predicate}`,
                  );
                  await tx.execute(
                    sql`INSERT INTO ${rows} (id, status) SELECT ${actor === "a" ? 1 : 2}, ${status} WHERE EXISTS (SELECT 1 FROM ${rows} WHERE id = 0 AND status = ${status})`,
                  );
                },
              },
            ],
          });
          return await withInterleaving({
            databaseUrl,
            a: participant("a", "approved"),
            b: participant("b", "cancelled"),
            reset,
            readState,
            invariant: ({ outcomes, state }) => {
              expect(outcomes).toEqual({
                a: { status: "committed" },
                b: { status: "committed" },
              });
              if (mode === "cas") {
                expect(state).toHaveLength(2);
              }
            },
          });
        };
        const red = await runStatus("unconditional");
        expect(red).toHaveLength(20);
        expect(red.some(({ state }) => state.length === 3)).toBe(true);
        const green = await runStatus("cas");
        expect(green).toHaveLength(red.length);
        expect(green.some(({ blocked }) => blocked.length > 0)).toBe(true);
      });
    }, 30_000);

    test("both distinct transactions are open before the first step of every schedule", async () => {
      const snapshots: { pid: number; xid: string }[][] = [];
      const participant = {
        steps: [
          {
            name: "probe",
            run: async (tx: Transaction) => {
              snapshots.push(
                await tx
                  .select({
                    pid: sql<number>`pid`,
                    xid: sql<string>`backend_xid::text`,
                  })
                  .from(sql`pg_stat_activity`)
                  .where(sql`backend_xid IS NOT NULL`),
              );
            },
          },
        ],
      };
      const results = await withInterleaving({
        databaseUrl,
        a: participant,
        b: participant,
        reset: async () => {
          snapshots.length = 0;
        },
        readState: async () => snapshots,
        invariant: ({ sessions, state, outcomes }) => {
          expect(sessions.a.pid).not.toBe(sessions.b.pid);
          expect(sessions.a.xid).not.toBe(sessions.b.xid);
          const first = state.at(0) ?? panic("Overlap probe missing");
          expect(first).toContainEqual(sessions.a);
          expect(first).toContainEqual(sessions.b);
          expect(outcomes).toEqual({
            a: { status: "committed" },
            b: { status: "committed" },
          });
        },
      });
      expect(results).toHaveLength(6);
    }, 10_000);

    test("a real deadlock finishes within the deadline with one recorded victim", async () => {
      await withFixture(async ({ rows, reset, readState }) => {
        const participant = (first: number, second: number) => ({
          steps: [
            {
              name: "first",
              run: async (tx: Transaction) =>
                await tx.execute(
                  sql`SELECT * FROM ${rows} WHERE id = ${first} FOR UPDATE`,
                ),
            },
            {
              name: "second",
              run: async (tx: Transaction) =>
                await tx.execute(
                  sql`SELECT * FROM ${rows} WHERE id = ${second} FOR UPDATE`,
                ),
            },
          ],
        });
        const started = performance.now();
        const results = await withInterleaving({
          databaseUrl,
          a: participant(0, 1),
          b: participant(1, 0),
          schedules: [
            [
              "a.first",
              "b.first",
              "a.second",
              "b.second",
              "a.commit",
              "b.commit",
            ],
          ],
          reset: async () => {
            await reset();
            await withGatedTestClients(databaseUrl, async ({ openClient }) => {
              await openClient().db.execute(
                sql`INSERT INTO ${rows} VALUES (1, 'active')`,
              );
            });
          },
          readState,
          invariant: ({ outcomes, blocked, state }) => {
            expect(
              Object.values(outcomes)
                .map(({ status }) => status)
                .toSorted(),
            ).toEqual(["committed", "deadlock"]);
            expect(blocked).toContain("a.second");
            expect(state).toHaveLength(2);
          },
        });
        expect(results).toHaveLength(1);
        expect(performance.now() - started).toBeLessThan(5000);
      });
    }, 10_000);

    test("an application failure rolls back its writes and does not prevent the competitor committing", async () => {
      await withFixture(async ({ rows, reset, readState }) => {
        await withInterleaving({
          databaseUrl,
          a: {
            steps: [
              {
                name: "refuse",
                run: async (tx) => {
                  await tx.execute(
                    sql`INSERT INTO ${rows} VALUES (1, 'active')`,
                  );
                  throw new FixtureRefusal({ message: "Fixture refused" });
                },
              },
            ],
          },
          b: {
            steps: [
              {
                name: "insert",
                run: async (tx) =>
                  await tx.execute(
                    sql`INSERT INTO ${rows} VALUES (2, 'active')`,
                  ),
              },
            ],
          },
          reset,
          readState,
          invariant: ({ outcomes, state }) => {
            expect(outcomes.a.status).toBe("app-error");
            expect(outcomes.b.status).toBe("committed");
            expect(state.map(({ id }) => id)).toEqual([0, 2]);
          },
        });
      });
    }, 10_000);

    test("serialization failures are recorded without retrying a transaction", async () => {
      await withFixture(async ({ rows, reset, readState }) => {
        await withGatedTestClients(databaseUrl, async ({ openClient }) => {
          const connections = { a: openClient(), b: openClient() };
          const attempts = { a: 0, b: 0 };
          const participant = (actor: "a" | "b") => ({
            transaction: async <T>(run: (tx: Transaction) => Promise<T>) => {
              attempts[actor] += 1;
              return await connections[actor].db.transaction(async (tx) => {
                await tx.execute(
                  sql`SET TRANSACTION ISOLATION LEVEL SERIALIZABLE`,
                );
                return await run(tx);
              });
            },
            steps: [
              {
                name: "read",
                run: async (tx: Transaction) =>
                  await tx.execute(sql`SELECT * FROM ${rows} WHERE id = 0`),
              },
              {
                name: "write",
                run: async (tx: Transaction) =>
                  await tx.execute(
                    sql`UPDATE ${rows} SET status = ${actor} WHERE id = 0`,
                  ),
              },
            ],
          });
          await withInterleaving({
            databaseUrl,
            a: participant("a"),
            b: participant("b"),
            reset,
            readState,
            schedules: [
              [
                "a.read",
                "b.read",
                "a.write",
                "a.commit",
                "b.write",
                "b.commit",
              ],
            ],
            invariant: ({ outcomes, state }) => {
              expect(outcomes.a.status).toBe("committed");
              expect(outcomes.b.status).toBe("serialization-error");
              expect(state).toEqual([{ id: 0, status: "a" }]);
              expect(attempts).toEqual({ a: 1, b: 1 });
            },
          });
        });
      });
    }, 10_000);

    test("a stalled application step cannot hang the harness", async () => {
      const stalled = Promise.withResolvers<undefined>();
      const started = performance.now();
      await expect(
        withInterleaving({
          databaseUrl,
          timeoutMs: 300,
          a: {
            steps: [{ name: "stall", run: async () => await stalled.promise }],
          },
          b: { steps: [] },
          reset: async () => {},
          readState: async () => null,
          invariant: () => panic("Stalled schedule must not complete"),
        }),
      ).rejects.toBeInstanceOf(InterleavingTimeout);
      stalled.resolve(undefined);
      expect(performance.now() - started).toBeLessThan(2000);
    }, 5000);
  });
}
