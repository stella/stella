import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { eq, inArray, sql, TransactionRollbackError } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import { rejectionOf } from "@stll/property-testing/rejection";

import { organization } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import { withResultSavepoint } from "@/api/db/safe-db";
import { entities, workspaces } from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { executedRows } from "@/api/lib/db/executed-rows";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { PG_ERROR, getPgErrorCode } from "@/api/lib/pg-error";
import { isRecord } from "@/api/lib/type-guards";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import type { GatedTestDb } from "@/api/tests/gated-test-database";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { withInterleaving } from "@/api/tests/helpers/transaction-interleaving";

import {
  withAggregateLock,
  withAggregateRowQuery,
  withAggregateSavepoint,
} from "./aggregate-lock";

const databaseUrl = process.env["DATABASE_URL"];
const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

type LockTransaction = Pick<Transaction, "execute">;

type PublicRowFixture = {
  organizationId: SafeId<"organization">;
  otherOrganizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
};
type WithPublicRowFixtureOptions = {
  db: GatedTestDb;
  workspace: "missing" | "present";
  run: (fixture: PublicRowFixture) => Promise<void>;
};
const withPublicRowFixture = async ({
  db,
  workspace,
  run,
}: WithPublicRowFixtureOptions): Promise<void> => {
  const organizationId = mintAuthProviderId<"organization">();
  const otherOrganizationId = mintAuthProviderId<"organization">();
  const workspaceId = createSafeId<"workspace">();
  try {
    await db.insert(organization).values([
      {
        id: organizationId,
        name: "Aggregate lock fixture",
        slug: `lock-${organizationId}`,
        createdAt: new Date(),
      },
      {
        id: otherOrganizationId,
        name: "Other aggregate lock fixture",
        slug: `lock-${otherOrganizationId}`,
        createdAt: new Date(),
      },
    ]);
    if (workspace === "present") {
      await db.insert(workspaces).values({
        id: workspaceId,
        organizationId,
        name: "Aggregate lock fixture",
        reference: workspaceId,
      });
    }
    await run({ organizationId, otherOrganizationId, workspaceId });
  } finally {
    await db
      .delete(organization)
      .where(inArray(organization.id, [organizationId, otherOrganizationId]));
  }
};

type AggregateAcquireTransaction = Parameters<
  typeof withAggregateLock
>[0]["tx"];

const advisoryCases = () => {
  const organizationId = mintAuthProviderId<"organization">();
  const otherOrganizationId = mintAuthProviderId<"organization">();
  const userId = mintAuthProviderId<"user">();
  const otherUserId = mintAuthProviderId<"user">();
  return [
    {
      name: "contact capacity",
      acquire: async (tx: AggregateAcquireTransaction) =>
        await withAggregateLock({
          aggregate: "contactCapacity",
          id: { organizationId },
          tx,
        }),
      acquireOther: async (tx: AggregateAcquireTransaction) =>
        await withAggregateLock({
          aggregate: "contactCapacity",
          id: { organizationId: otherOrganizationId },
          tx,
        }),
      tryLegacy: (tx: LockTransaction) =>
        tx.execute(
          sql`SELECT pg_try_advisory_xact_lock(hashtext('contact_capacity'), hashtext(${organizationId})) AS acquired`,
        ),
      acquireLegacy: (tx: LockTransaction) =>
        tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext('contact_capacity'), hashtext(${organizationId}))`,
        ),
      legacyMetadata: (tx: LockTransaction) =>
        tx.execute(
          sql`SELECT hashtext('contact_capacity') AS key1, hashtext(${organizationId}) AS key2`,
        ),
    },
    {
      name: "personal catalog",
      acquire: async (tx: AggregateAcquireTransaction) =>
        await withAggregateLock({
          aggregate: "personalCatalog",
          id: { organizationId, userId },
          tx,
        }),
      acquireOther: async (tx: AggregateAcquireTransaction) =>
        await withAggregateLock({
          aggregate: "personalCatalog",
          id: { organizationId, userId: otherUserId },
          tx,
        }),
      tryLegacy: (tx: LockTransaction) =>
        tx.execute(
          sql`SELECT pg_try_advisory_xact_lock(hashtext(${organizationId}), hashtext(${userId})) AS acquired`,
        ),
      acquireLegacy: (tx: LockTransaction) =>
        tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext(${organizationId}), hashtext(${userId}))`,
        ),
      legacyMetadata: (tx: LockTransaction) =>
        tx.execute(
          sql`SELECT hashtext(${organizationId}) AS key1, hashtext(${userId}) AS key2`,
        ),
    },
  ];
};

if (!databaseUrl || !enabled) {
  describe.skip("aggregate locks (postgres)", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {});
  });
} else {
  describe("aggregate locks (postgres)", () => {
    test("empty selected rows retain ordering without claiming physical coverage", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db } = openClient();
        await withPublicRowFixture({
          db,
          workspace: "present",
          run: async ({ organizationId, workspaceId }) => {
            const entityId = createSafeId<"entity">();
            await db.insert(entities).values({
              id: entityId,
              workspaceId,
              kind: "document",
              name: "Aggregate lock fixture",
            });
            await withInterleaving({
              databaseUrl,
              schedules: [
                [
                  "a.selectWorkspace",
                  "a.lockEntity",
                  "b.lockWorkspace",
                  "b.waitEntity",
                  "a.refuseWorkspace",
                  "a.commit",
                  "b.commit",
                ],
              ],
              a: {
                steps: [
                  {
                    name: "selectWorkspace",
                    run: async (tx) => {
                      expect(
                        await withAggregateRowQuery({
                          aggregate: "workspace",
                          id: { id: workspaceId, organizationId },
                          mode: "update",
                          tx,
                          select: (queryTx) =>
                            queryTx
                              .select({
                                id: workspaces.id,
                                organizationId: workspaces.organizationId,
                              })
                              .from(workspaces),
                          where: sql`FALSE`,
                        }),
                      ).toEqual({ status: "missing", rows: [] });
                      expect(
                        await rejectionOf(
                          withAggregateLock({
                            aggregate: "organization",
                            id: organizationId,
                            mode: "update",
                            tx,
                          }),
                        ),
                      ).toMatchObject({
                        message: "Aggregate lock rank inversion",
                      });
                    },
                  },
                  {
                    name: "lockEntity",
                    run: async (tx) => {
                      expect(
                        await withAggregateLock({
                          aggregate: "entity",
                          id: { id: entityId, workspaceId },
                          mode: "update",
                          tx,
                        }),
                      ).toEqual({ status: "locked" });
                    },
                  },
                  {
                    name: "refuseWorkspace",
                    run: async (tx) => {
                      expect(
                        await rejectionOf(
                          withAggregateLock({
                            aggregate: "workspace",
                            id: { id: workspaceId, organizationId },
                            mode: "update",
                            tx,
                          }),
                        ),
                      ).toMatchObject({
                        message: "Aggregate lock rank inversion",
                      });
                      expect(
                        executedRows(
                          await tx.execute(sql`SELECT 1 AS healthy`),
                        ).at(0),
                      ).toEqual({ healthy: 1 });
                    },
                  },
                ],
              },
              b: {
                steps: [
                  {
                    name: "lockWorkspace",
                    run: async (tx) => {
                      expect(
                        await withAggregateLock({
                          aggregate: "workspace",
                          id: { id: workspaceId, organizationId },
                          mode: "update",
                          tx,
                        }),
                      ).toEqual({ status: "locked" });
                    },
                  },
                  {
                    name: "waitEntity",
                    run: async (tx) => {
                      expect(
                        await withAggregateLock({
                          aggregate: "entity",
                          id: { id: entityId, workspaceId },
                          mode: "update",
                          tx,
                        }),
                      ).toEqual({ status: "locked" });
                    },
                  },
                ],
              },
              reset: async () => {
                const source = await db
                  .select({ id: entities.id })
                  .from(entities)
                  .where(eq(entities.id, entityId));
                expect(source).toEqual([{ id: entityId }]);
              },
              readState: async () =>
                await db
                  .select({
                    id: entities.id,
                    workspaceId: entities.workspaceId,
                  })
                  .from(entities)
                  .where(eq(entities.id, entityId)),
              invariant: ({ blocked, outcomes, state }) => {
                expect(blocked).toContain("b.waitEntity");
                expect(outcomes.a).toEqual({ status: "committed" });
                expect(outcomes.b).toEqual({ status: "committed" });
                expect(state).toEqual([{ id: entityId, workspaceId }]);
              },
            });
          },
        });
      });
    });

    test("missing rows consume no rank and workspace locks preserve tenant scope on reacquisition", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db } = openClient();
        await withPublicRowFixture({
          db,
          workspace: "missing",
          run: async ({ organizationId, otherOrganizationId, workspaceId }) => {
            await db.transaction(async (tx) => {
              expect(
                await withAggregateLock({
                  aggregate: "workspace",
                  mode: "update",
                  id: { id: workspaceId, organizationId },
                  tx,
                }),
              ).toEqual({ status: "missing" });
              expect(
                await withAggregateLock({
                  aggregate: "organization",
                  mode: "update",
                  id: organizationId,
                  tx,
                }),
              ).toEqual({ status: "locked" });
              await tx.insert(workspaces).values({
                id: workspaceId,
                organizationId,
                name: "Aggregate lock fixture",
                reference: workspaceId,
                status: "archived",
              });
              expect(
                await withAggregateLock({
                  aggregate: "workspace",
                  mode: "update",
                  id: { id: workspaceId, organizationId },
                  tx,
                }),
              ).toEqual({ status: "locked" });
              const state = await tx.execute(
                sql`SELECT status FROM public.workspaces WHERE id = ${workspaceId}::uuid`,
              );
              expect(state.at(0)?.["status"]).toBe("archived");
              expect(
                await withAggregateLock({
                  aggregate: "workspace",
                  mode: "update",
                  id: { id: workspaceId, organizationId: otherOrganizationId },
                  tx,
                }),
              ).toEqual({ status: "missing" });
              expect(
                await withAggregateLock({
                  aggregate: "workspace",
                  mode: "update",
                  id: { id: workspaceId, organizationId },
                  tx,
                }),
              ).toEqual({ status: "locked" });
            });
          },
        });
      });
    });

    test.each([
      "parent inversion",
      "ancestor inversion",
      "rollback",
      "commit",
      "closed level",
      "parent overlap",
    ] as const)(
      "savepoint history preserves physical transaction ordering: %s",
      async (mode) => {
        await withGatedTestClients(databaseUrl, async ({ openClient }) => {
          const { db } = openClient();
          await withPublicRowFixture({
            db,
            workspace: "present",
            run: async ({ organizationId, workspaceId }) => {
              await db.transaction(async (tx) => {
                const lower = {
                  aggregate: "organization",
                  mode: "update",
                  id: organizationId,
                } as const;
                const higher = {
                  aggregate: "workspace",
                  mode: "update",
                  id: { id: workspaceId, organizationId },
                } as const;
                switch (mode) {
                  case "parent inversion":
                  case "ancestor inversion": {
                    await withAggregateLock({ ...higher, tx });
                    const refusal = await rejectionOf(
                      withAggregateSavepoint(tx, async (child) =>
                        mode === "parent inversion"
                          ? await withAggregateLock({ ...lower, tx: child })
                          : await withAggregateSavepoint(
                              child,
                              async (grandchild) =>
                                await withAggregateLock({
                                  ...lower,
                                  tx: grandchild,
                                }),
                            ),
                      ),
                    );
                    expect(refusal).toMatchObject({
                      message: "Aggregate lock rank inversion",
                    });
                    expect(await withAggregateLock({ ...higher, tx })).toEqual({
                      status: "locked",
                    });
                    expect(
                      await rejectionOf(withAggregateLock({ ...lower, tx })),
                    ).toMatchObject({
                      message: "Aggregate lock rank inversion",
                    });
                    return;
                  }
                  case "rollback": {
                    const refusal = await rejectionOf(
                      withAggregateSavepoint(tx, async (child) => {
                        expect(
                          await withAggregateLock({ ...higher, tx: child }),
                        ).toEqual({ status: "locked" });
                        child.rollback();
                      }),
                    );
                    expect(refusal).toBeInstanceOf(TransactionRollbackError);
                    expect(await withAggregateLock({ ...lower, tx })).toEqual({
                      status: "locked",
                    });
                    return;
                  }
                  case "commit": {
                    expect(
                      await withAggregateSavepoint(
                        tx,
                        async (child) =>
                          await withAggregateLock({ ...higher, tx: child }),
                      ),
                    ).toEqual({ status: "locked" });
                    expect(
                      await rejectionOf(withAggregateLock({ ...lower, tx })),
                    ).toMatchObject({
                      message: "Aggregate lock rank inversion",
                    });
                    return;
                  }
                  case "closed level": {
                    const child = await withAggregateSavepoint(
                      tx,
                      async (savepoint) => savepoint,
                    );
                    expect(
                      await rejectionOf(
                        withAggregateLock({ ...lower, tx: child }),
                      ),
                    ).toMatchObject({
                      message: "Aggregate savepoint transaction is closed",
                    });
                    return;
                  }
                  case "parent overlap": {
                    await withAggregateSavepoint(tx, async (child) => {
                      expect(
                        await rejectionOf(withAggregateLock({ ...lower, tx })),
                      ).toMatchObject({
                        message:
                          "Await the aggregate savepoint before reusing its parent transaction",
                      });
                      expect(
                        await withAggregateLock({ ...lower, tx: child }),
                      ).toEqual({ status: "locked" });
                    });
                    return;
                  }
                  default:
                    mode satisfies never;
                    panic("Unknown savepoint fixture mode");
                }
              });
            },
          });
        });
      },
    );

    test("non-locking typed savepoints preserve success, refusal and nested rollback", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db } = openClient();
        await db.transaction(async (tx) => {
          await tx.execute(
            sql`CREATE TEMPORARY TABLE savepoint_no_locks (id integer PRIMARY KEY) ON COMMIT DROP`,
          );
          const refusal = new HandlerError({
            status: 400,
            message: "Fixture refused",
          });
          const success = await withResultSavepoint(tx, async (child) => {
            await child.execute(sql`INSERT INTO savepoint_no_locks VALUES (1)`);
            const rejected = await withResultSavepoint(
              child,
              async (nested) => {
                await nested.execute(
                  sql`INSERT INTO savepoint_no_locks VALUES (2)`,
                );
                return Result.err(refusal);
              },
            );
            expect(rejected.isErr()).toBe(true);
            if (rejected.isErr()) {
              expect(rejected.error).toBe(refusal);
            }
            return Result.ok("committed");
          });
          expect(success).toEqual(Result.ok("committed"));
          const rejected = await withResultSavepoint(tx, async (child) => {
            await child.execute(sql`INSERT INTO savepoint_no_locks VALUES (3)`);
            return Result.err(refusal);
          });
          expect(rejected.isErr()).toBe(true);
          if (rejected.isErr()) {
            expect(rejected.error).toBe(refusal);
          }
          await tx.execute(sql`INSERT INTO savepoint_no_locks VALUES (4)`);
          const rows = await tx.execute(
            sql`SELECT id FROM savepoint_no_locks ORDER BY id`,
          );
          expect(rows.map((row) => row["id"])).toEqual([1, 4]);
        });
      });
    });

    test("non-locking released savepoint handles retain the driver's nested-savepoint behavior", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db } = openClient();
        await db.transaction(async (tx) => {
          await tx.execute(
            sql`CREATE TEMPORARY TABLE released_savepoint_effects (id integer PRIMARY KEY) ON COMMIT DROP`,
          );
          const released = await withAggregateSavepoint(
            tx,
            async (child) => child,
          );
          await withAggregateSavepoint(released, async (nested) => {
            await nested.execute(
              sql`INSERT INTO released_savepoint_effects (id) VALUES (1)`,
            );
          });
          const committed = await tx.execute(
            sql`SELECT id FROM released_savepoint_effects`,
          );
          expect(committed.at(0)?.["id"]).toBe(1);
          await tx.execute(
            sql`INSERT INTO released_savepoint_effects (id) VALUES (2)`,
          );
          const parent = await tx.execute(
            sql`SELECT count(*)::int AS count FROM released_savepoint_effects`,
          );
          expect(parent.at(0)?.["count"]).toBe(2);
        });
      });
    });

    test("rejects a lower-ranked lock before sending its statement", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const statements: string[] = [];
        const { db } = openClient({
          logger: {
            logQuery: (query) => {
              statements.push(query);
            },
          },
        });
        await db.transaction(async (tx) => {
          const organizationId = mintAuthProviderId<"organization">();
          const userId = mintAuthProviderId<"user">();
          await withAggregateLock({
            aggregate: "personalCatalog",
            id: { organizationId, userId },
            tx,
          });
          const countBeforeInversion = statements.length;
          expect(
            await rejectionOf(
              withAggregateLock({
                aggregate: "organization",
                mode: "update",
                id: organizationId,
                tx,
              }),
            ),
          ).toMatchObject({ message: "Aggregate lock rank inversion" });
          expect(statements.length).toBe(countBeforeInversion);
        });
      });
    });

    for (const name of ["contact capacity", "personal catalog"]) {
      test(`${name} preserves real-driver physical metadata and canonical-to-legacy contention`, async () => {
        const fixture =
          advisoryCases().find((candidate) => candidate.name === name) ??
          panic("Missing advisory fixture");
        await withGatedTestClients(databaseUrl, async ({ openClient }) => {
          const holder = openClient();
          const contender = openClient();
          await holder.db.transaction(async (tx) => {
            const captured: unknown[] = [];
            const execute = async (statement: SQL) => {
              const result = await tx.execute(statement);
              captured.push(result);
              return result;
            };
            expect(await fixture.acquire({ execute })).toEqual({
              status: "locked",
            });
            const returned = executedRows(captured.at(0)).at(0);
            if (!isRecord(returned)) {
              panic("Canonical advisory SQL must return real metadata");
            }
            expect(typeof returned["key1"]).toBe("number");
            expect(typeof returned["key2"]).toBe("number");
            expect(Object.hasOwn(returned, "acquired")).toBe(true);
            const legacy = (await fixture.legacyMetadata(tx)).at(0);
            expect(returned["key1"]).toBe(legacy?.["key1"]);
            expect(returned["key2"]).toBe(legacy?.["key2"]);
            await contender.db.transaction(async (otherTx) => {
              expect(
                (await fixture.tryLegacy(otherTx)).at(0)?.["acquired"],
              ).toBe(false);
            });
          });
          await contender.db.transaction(async (tx) => {
            expect((await fixture.tryLegacy(tx)).at(0)?.["acquired"]).toBe(
              true,
            );
          });
        });
      });

      test(`${name} serializes its physical key and permits independent keys`, async () => {
        const fixture = advisoryCases().find(
          (candidate) => candidate.name === name,
        );
        if (!fixture) {
          panic("Missing advisory fixture");
        }
        await withGatedTestClients(databaseUrl, async ({ openClient }) => {
          const holder = openClient();
          const contender = openClient({
            connection: { lock_timeout: 1000, statement_timeout: 5000 },
          });
          await holder.db.transaction(async (tx) => {
            expect(await fixture.acquire(tx)).toEqual({ status: "locked" });
            await contender.db.transaction(async (otherTx) => {
              const rows = await fixture.tryLegacy(otherTx);
              expect(rows.at(0)?.["acquired"]).toBe(false);
              expect(await fixture.acquireOther(otherTx)).toEqual({
                status: "locked",
              });
            });
            const blocked = await Result.tryPromise(
              async () =>
                await contender.db.transaction(
                  async (otherTx) => await fixture.acquire(otherTx),
                ),
            );
            expect(blocked.isErr()).toBe(true);
            if (blocked.isErr()) {
              expect(getPgErrorCode(blocked.error)).toBe(
                PG_ERROR.LOCK_NOT_AVAILABLE,
              );
            }
          });
          await contender.db.transaction(async (tx) => {
            const rows = await fixture.tryLegacy(tx);
            expect(rows.at(0)?.["acquired"]).toBe(true);
          });
        });
      });

      test(`${name} contends with legacy writers and releases after rollback`, async () => {
        const fixture = advisoryCases().find(
          (candidate) => candidate.name === name,
        );
        if (!fixture) {
          panic("Missing advisory fixture");
        }
        await withGatedTestClients(databaseUrl, async ({ openClient }) => {
          const holder = openClient();
          const contender = openClient({
            connection: { lock_timeout: 1000, statement_timeout: 5000 },
          });
          await holder.db.transaction(async (tx) => {
            await fixture.acquireLegacy(tx);
            const blocked = await Result.tryPromise(
              async () =>
                await contender.db.transaction(
                  async (otherTx) => await fixture.acquire(otherTx),
                ),
            );
            expect(blocked.isErr()).toBe(true);
            if (blocked.isErr()) {
              expect(getPgErrorCode(blocked.error)).toBe(
                PG_ERROR.LOCK_NOT_AVAILABLE,
              );
            }
          });
          const rolledBack = await Result.tryPromise(
            async () =>
              await holder.db.transaction(async (tx) => {
                expect(await fixture.acquire(tx)).toEqual({ status: "locked" });
                tx.rollback();
              }),
          );
          expect(rolledBack.isErr()).toBe(true);
          if (rolledBack.isErr()) {
            expect(rolledBack.error.cause).toBeInstanceOf(
              TransactionRollbackError,
            );
          }
          await contender.db.transaction(async (tx) => {
            const rows = await fixture.tryLegacy(tx);
            expect(rows.at(0)?.["acquired"]).toBe(true);
            expect(await fixture.acquire(tx)).toEqual({ status: "locked" });
          });
        });
      });
    }
  });
}
