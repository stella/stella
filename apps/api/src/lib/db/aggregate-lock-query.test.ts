import { panic, Result } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  and,
  eq,
  getTableName,
  sql,
  TransactionRollbackError,
} from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import { rejectionOf } from "@stll/property-testing/rejection";

import { organization } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import { workspaces } from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import {
  withAggregateLock,
  withAggregateRowQuery,
  withAggregateSavepoint,
  withAggregateTransaction,
  ROW_LOCK_MODES,
} from "@/api/lib/db/aggregate-lock";
import {
  timestampCasToken,
  timestampMatchesCasToken,
} from "@/api/lib/db/timestamp-cas";
import { getPgErrorCode } from "@/api/lib/pg-error";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";

const db = await getTestDb();
const organizationId = mintAuthProviderId<"organization">();
const workspaceId = createSafeId<"workspace">();
const otherWorkspaceId = createSafeId<"workspace">();
const workspaceIdentity = {
  aggregate: "workspace",
  id: { id: workspaceId, organizationId },
} as const;

beforeAll(async () => {
  await db.insert(organization).values({
    id: organizationId,
    name: "Aggregate query fixture",
    slug: `aggregate-query-${organizationId}`,
    createdAt: new Date(),
  });
  await db.insert(workspaces).values(
    [workspaceId, otherWorkspaceId].map((id) => ({
      id,
      organizationId,
      name: "Selected projection",
      reference: `QUERY-${id}`,
      clientId: null,
    })),
  );
});
afterAll(async () => {
  await db
    .delete(workspaces)
    .where(eq(workspaces.organizationId, organizationId));
  await db.delete(organization).where(eq(organization.id, organizationId));
  await releaseTestDb();
});

describe("aggregate queries preserve their decisive read", () => {
  test("an exact microsecond CAS returns the original projection; a stale CAS returns no rows", async () => {
    const captured =
      (
        await db
          .update(workspaces)
          .set({
            lastActivityAt: sql`date_trunc('milliseconds', now()) + interval '123 microseconds'`,
          })
          .where(eq(workspaces.id, workspaceId))
          .returning({ token: timestampCasToken(workspaces.lastActivityAt) })
      ).at(0) ?? panic("Missing workspace fixture");
    await withAggregateTransaction(db, async (rawTx) => {
      const tx = asTestRaw<Transaction>(rawTx);
      const query = () =>
        tx
          .select({
            id: workspaces.id,
            organizationId: workspaces.organizationId,
            caption: workspaces.name,
          })
          .from(workspaces)
          .where(
            and(
              eq(workspaces.id, workspaceId),
              eq(workspaces.organizationId, organizationId),
              timestampMatchesCasToken(
                workspaces.lastActivityAt,
                captured.token,
              ),
            ),
          );
      const result = await withAggregateRowQuery({
        ...workspaceIdentity,
        tx,
        mode: "update",
        select: query,
      });
      expect(result).toEqual({
        status: "locked",
        rows: [
          { id: workspaceId, organizationId, caption: "Selected projection" },
        ],
      });
      await tx
        .update(workspaces)
        .set({
          lastActivityAt: sql`${workspaces.lastActivityAt} + interval '1 microsecond'`,
        })
        .where(eq(workspaces.id, workspaceId));
      const stale = await withAggregateRowQuery({
        ...workspaceIdentity,
        tx,
        mode: "update",
        select: query,
      });
      expect(stale).toEqual({ status: "missing", rows: [] });
    });
  });

  test("a missing selected row records no lock rank", async () => {
    await withAggregateTransaction(db, async (rawTx) => {
      const tx = asTestRaw<Transaction>(rawTx);
      const result = await withAggregateRowQuery({
        ...workspaceIdentity,
        tx,
        mode: "update",
        select: (queryTx) =>
          queryTx
            .select({
              id: workspaces.id,
              organizationId: workspaces.organizationId,
            })
            .from(workspaces)
            .where(
              and(
                eq(workspaces.id, workspaceId),
                eq(workspaces.name, "absent projection"),
              ),
            ),
      });
      expect(result).toEqual({ status: "missing", rows: [] });
      expect(
        await withAggregateLock({
          aggregate: "organization",
          id: organizationId,
          mode: "update",
          tx,
        }),
      ).toEqual({ status: "locked" });
    });
  });

  test("rejects rows outside the requested identity", async () => {
    const error = await rejectionOf(
      withAggregateTransaction(db, async (rawTx) => {
        const tx = asTestRaw<Transaction>(rawTx);
        return await withAggregateRowQuery({
          ...workspaceIdentity,
          tx,
          mode: "update",
          select: (queryTx) =>
            queryTx
              .select({
                id: workspaces.id,
                organizationId: workspaces.organizationId,
              })
              .from(workspaces)
              .where(eq(workspaces.id, otherWorkspaceId)),
        });
      }),
    );
    expect(error).toMatchObject({
      message:
        "Aggregate query returned an undeclared physical or tenant resource",
    });
  });

  test("rejects a non-registered target table", async () => {
    const error = await rejectionOf(
      withAggregateTransaction(db, async (rawTx) => {
        const tx = asTestRaw<Transaction>(rawTx);
        return await withAggregateRowQuery({
          ...workspaceIdentity,
          tx,
          mode: "update",
          select: (queryTx) =>
            queryTx
              .select({ id: organization.id })
              .from(organization)
              .where(eq(organization.id, organizationId)),
        });
      }),
    );
    expect(error).toMatchObject({
      message: "Aggregate query target does not match its registered resource",
    });
  });
});

describe("outer aggregate query target validation", () => {
  test("rejects a non-registered outer target with a nested projection", async () => {
    const error = await rejectionOf(
      withAggregateTransaction(db, async (rawTx) => {
        const tx = asTestRaw<Transaction>(rawTx);
        return await withAggregateRowQuery({
          ...workspaceIdentity,
          tx,
          mode: "update",
          select: (queryTx) =>
            queryTx
              .select({
                count: sql`(SELECT count(*) FROM ${workspaces})`.mapWith(
                  Number,
                ),
              })
              .from(organization)
              .where(eq(organization.id, organizationId)),
        });
      }),
    );
    expect(error).toMatchObject({
      message: "Aggregate query target does not match its registered resource",
    });
  });

  test("scalar subquery FROM and JOIN clauses do not change the outer locked resource", async () => {
    await withAggregateTransaction(db, async (rawTx) => {
      const tx = asTestRaw<Transaction>(rawTx);
      // Names preserve nested qualifiers that single-table projection rendering removes from PgColumn chunks.
      const firmId = sql`${sql.identifier("public")}.${sql.identifier(getTableName(organization))}.${sql.identifier(organization.id.name)}`;
      const matterFirm = sql`${sql.identifier("public")}.${sql.identifier(getTableName(workspaces))}.${sql.identifier(workspaces.organizationId.name)}`;
      const result = await withAggregateRowQuery({
        ...workspaceIdentity,
        tx,
        mode: "update",
        select: (queryTx) =>
          queryTx
            .select({
              id: workspaces.id,
              organizationId: workspaces.organizationId,
              count:
                sql`(SELECT count(*) FROM ${organization} INNER JOIN ${workspaces} ON ${matterFirm} = ${firmId} WHERE ${firmId} = ${organizationId})`.mapWith(
                  Number,
                ),
            })
            .from(workspaces)
            .where(eq(workspaces.id, workspaceId)),
      });
      expect(result).toEqual({
        status: "locked",
        rows: [{ id: workspaceId, organizationId, count: 2 }],
      });
    });
  });

  test("quoted strings, dollar quotes, comments and quoted projection identifiers do not declare targets", async () => {
    await withAggregateTransaction(db, async (rawTx) => {
      const tx = asTestRaw<Transaction>(rawTx);
      const result = await withAggregateRowQuery({
        ...workspaceIdentity,
        tx,
        mode: "update",
        select: (queryTx) =>
          queryTx
            .select({
              id: workspaces.id,
              organizationId: workspaces.organizationId,
              literal: sql`'FROM organization JOIN member'`.mapWith(String),
              dollar:
                sql`$aggregate$FROM organization JOIN member$aggregate$`.mapWith(
                  String,
                ),
              caption:
                sql`/* FROM organization /* JOIN member */ */ ${workspaces.name}`
                  .mapWith(String)
                  .as("FROM organization JOIN member"),
            })
            .from(workspaces)
            .where(eq(workspaces.id, workspaceId)),
      });
      expect(result).toEqual({
        status: "locked",
        rows: [
          {
            id: workspaceId,
            organizationId,
            literal: "FROM organization JOIN member",
            dollar: "FROM organization JOIN member",
            caption: "Selected projection",
          },
        ],
      });
    });
  });
});

describe("aggregate query projection ownership", () => {
  test("renamed nested genuine columns preserve projection while proving identity and tenant scope", async () => {
    await withAggregateTransaction(db, async (rawTx) => {
      const tx = asTestRaw<Transaction>(rawTx);
      const result = await withAggregateRowQuery({
        ...workspaceIdentity,
        tx,
        mode: "update",
        select: (queryTx) =>
          queryTx
            .select({
              matter: { key: workspaces.id, tenant: workspaces.organizationId },
              caption: workspaces.name,
            })
            .from(workspaces)
            .where(eq(workspaces.id, workspaceId)),
      });
      expect(result).toEqual({
        status: "locked",
        rows: [
          {
            matter: { key: workspaceId, tenant: organizationId },
            caption: "Selected projection",
          },
        ],
      });
    });
  });

  test.each(["id", "tenant"] as const)(
    "rejects a %s literal in place of a registered column and leaves history idle",
    async (field) => {
      await withAggregateTransaction(db, async (rawTx) => {
        const tx = asTestRaw<Transaction>(rawTx);
        const id =
          field === "id" ? sql`${workspaceId}`.mapWith(String) : workspaces.id;
        const tenant =
          field === "tenant"
            ? sql`${organizationId}`.mapWith(String)
            : workspaces.organizationId;
        expect(
          await rejectionOf(
            withAggregateRowQuery({
              ...workspaceIdentity,
              tx,
              mode: "update",
              select: (queryTx) =>
                queryTx
                  .select({ id, organizationId: tenant })
                  .from(workspaces)
                  .where(eq(workspaces.id, workspaceId)),
            }),
          ),
        ).toMatchObject({
          message:
            "Aggregate query must project its registered physical and tenant columns",
        });
        expect(
          await withAggregateLock({
            aggregate: "organization",
            id: organizationId,
            mode: "update",
            tx,
          }),
        ).toEqual({ status: "locked" });
      });
    },
  );

  test("rejects a key column from a different joined table", async () => {
    await withAggregateTransaction(db, async (rawTx) => {
      const tx = asTestRaw<Transaction>(rawTx);
      expect(
        await rejectionOf(
          withAggregateRowQuery({
            ...workspaceIdentity,
            tx,
            mode: "update",
            lockConfig: { of: workspaces },
            select: (queryTx) =>
              queryTx
                .select({
                  id: organization.id,
                  organizationId: workspaces.organizationId,
                })
                .from(workspaces)
                .innerJoin(
                  organization,
                  eq(organization.id, workspaces.organizationId),
                )
                .where(eq(workspaces.id, workspaceId)),
          }),
        ),
      ).toMatchObject({
        message:
          "Aggregate query must project its registered physical and tenant columns",
      });
      expect(
        await withAggregateLock({
          aggregate: "organization",
          id: organizationId,
          mode: "update",
          tx,
        }),
      ).toEqual({ status: "locked" });
    });
  });
});

describe("returned aggregate identity validation", () => {
  test.each(["identity", "tenant", "cardinality"] as const)(
    "a blocking %s refusal retains the acquired identities and leaves history idle",
    async (mismatch) => {
      await withAggregateTransaction(db, async (rawTx) => {
        const tx = asTestRaw<Transaction>(rawTx);
        const returnedIds =
          mismatch === "cardinality"
            ? [workspaceId, otherWorkspaceId]
            : [mismatch === "identity" ? otherWorkspaceId : workspaceId];
        expect(
          await rejectionOf(
            withAggregateRowQuery({
              aggregate: "workspace",
              id: {
                id: workspaceId,
                organizationId:
                  mismatch === "tenant"
                    ? mintAuthProviderId<"organization">()
                    : organizationId,
              },
              tx,
              mode: "key share",
              select: (queryTx) =>
                queryTx
                  .select({
                    id: workspaces.id,
                    organizationId: workspaces.organizationId,
                  })
                  .from(workspaces)
                  .where(
                    mismatch === "cardinality"
                      ? eq(workspaces.organizationId, organizationId)
                      : eq(
                          workspaces.id,
                          mismatch === "identity"
                            ? otherWorkspaceId
                            : workspaceId,
                        ),
                  ),
            }),
          ),
        ).toMatchObject({
          message:
            mismatch === "cardinality"
              ? "Aggregate query returned more than one physical row"
              : "Aggregate query returned an undeclared physical or tenant resource",
        });
        for (const id of returnedIds) {
          expect(
            await rejectionOf(
              withAggregateLock({
                aggregate: "workspace",
                id: { id, organizationId },
                tx,
                mode: "update",
              }),
            ),
          ).toMatchObject({
            message:
              "Take the strongest aggregate row mode first; use NOWAIT for upgrades",
          });
          await withAggregateSavepoint(tx, async (child) => {
            expect(
              await withAggregateLock({
                aggregate: "workspace",
                id: { id, organizationId },
                tx: child,
                mode: "key share",
              }),
            ).toEqual({ status: "locked" });
          });
        }
        expect(
          await rejectionOf(
            withAggregateLock({
              aggregate: "organization",
              id: organizationId,
              tx,
              mode: "key share",
            }),
          ),
        ).toMatchObject({ message: "Aggregate lock rank inversion" });
      });
    },
  );

  test("a returned tenant mismatch rejects the read and retains no parent lock", async () => {
    await withAggregateTransaction(db, async (rawTx) => {
      const tx = asTestRaw<Transaction>(rawTx);
      const incorrectOrganizationId = mintAuthProviderId<"organization">();
      expect(
        await rejectionOf(
          withAggregateRowQuery({
            aggregate: "workspace",
            id: { id: workspaceId, organizationId: incorrectOrganizationId },
            tx,
            mode: "update",
            wait: "nowait",
            select: (queryTx) =>
              queryTx
                .select({
                  id: workspaces.id,
                  organizationId: workspaces.organizationId,
                })
                .from(workspaces)
                .where(eq(workspaces.id, workspaceId)),
          }),
        ),
      ).toMatchObject({
        message:
          "Aggregate query returned an undeclared physical or tenant resource",
      });
      expect(
        await withAggregateLock({
          aggregate: "organization",
          id: organizationId,
          mode: "update",
          tx,
        }),
      ).toEqual({ status: "locked" });
    });
  });

  test("extra rows are rejected before any matched row's fence reaches the parent", async () => {
    await withAggregateTransaction(db, async (rawTx) => {
      const tx = asTestRaw<Transaction>(rawTx);
      expect(
        await rejectionOf(
          withAggregateRowQuery({
            ...workspaceIdentity,
            tx,
            mode: "update",
            wait: "nowait",
            select: (queryTx) =>
              queryTx
                .select({
                  id: workspaces.id,
                  organizationId: workspaces.organizationId,
                })
                .from(workspaces)
                .where(eq(workspaces.organizationId, organizationId))
                .orderBy(workspaces.id),
          }),
        ),
      ).toMatchObject({
        message: "Aggregate query returned more than one physical row",
      });
      expect(
        await withAggregateLock({
          aggregate: "organization",
          id: organizationId,
          mode: "update",
          tx,
        }),
      ).toEqual({ status: "locked" });
    });
  });
});

describe("nested query lock rejection", () => {
  test.each(ROW_LOCK_MODES)(
    "nested FOR %s is refused before acquisition",
    async (mode) => {
      await withAggregateTransaction(db, async (rawTx) => {
        const tx = asTestRaw<Transaction>(rawTx);
        expect(
          await rejectionOf(
            withAggregateRowQuery({
              ...workspaceIdentity,
              tx,
              mode: "update",
              select: (queryTx) =>
                queryTx
                  .select({
                    id: workspaces.id,
                    organizationId: workspaces.organizationId,
                    nested: sql`(SELECT ${organization.id} FROM ${organization} WHERE ${organization.id} = ${organizationId} ${sql.raw(`FOR ${mode.toUpperCase()}`)})`,
                  })
                  .from(workspaces)
                  .where(eq(workspaces.id, workspaceId)),
            }),
          ),
        ).toMatchObject({
          message: "Nested aggregate row locking clauses are not tracked",
        });
        expect(
          await withAggregateLock({
            aggregate: "organization",
            id: organizationId,
            mode: "update",
            tx,
          }),
        ).toEqual({ status: "locked" });
      });
    },
  );

  test.each(["target", "of"] as const)(
    "invalid %s validation leaves history idle",
    async (invalid) => {
      await withAggregateTransaction(db, async (rawTx) => {
        const tx = asTestRaw<Transaction>(rawTx);
        const identity =
          invalid === "target"
            ? ({ aggregate: "organization", id: organizationId } as const)
            : workspaceIdentity;
        expect(
          await rejectionOf(
            withAggregateRowQuery({
              ...identity,
              tx,
              mode: "update",
              lockConfig: invalid === "of" ? { of: organization } : undefined,
              select: (queryTx) =>
                queryTx
                  .select({
                    id: workspaces.id,
                    organizationId: workspaces.organizationId,
                  })
                  .from(workspaces)
                  .where(eq(workspaces.id, workspaceId)),
            }),
          ),
        ).toMatchObject({
          message:
            invalid === "target"
              ? "Aggregate query target does not match its registered resource"
              : "Aggregate query lock target does not match its registered resource",
        });
        expect(
          await withAggregateLock({
            aggregate: "organization",
            id: organizationId,
            mode: "update",
            tx,
          }),
        ).toEqual({ status: "locked" });
      });
    },
  );
});

describe("aggregate query targets and lock modes", () => {
  test("a same-row blocking query upgrade is rejected; NOWAIT upgrade remains available", async () => {
    await withAggregateTransaction(db, async (rawTx) => {
      const tx = asTestRaw<Transaction>(rawTx);
      const select = (queryTx: Transaction) =>
        queryTx
          .select({
            id: workspaces.id,
            organizationId: workspaces.organizationId,
          })
          .from(workspaces)
          .where(eq(workspaces.id, workspaceId));
      expect(
        await withAggregateRowQuery({
          ...workspaceIdentity,
          tx,
          mode: "key share",
          select,
        }),
      ).toMatchObject({ status: "locked" });
      expect(
        await rejectionOf(
          withAggregateRowQuery({
            ...workspaceIdentity,
            tx,
            mode: "update",
            select,
          }),
        ),
      ).toMatchObject({
        message:
          "Take the strongest aggregate row mode first; use NOWAIT for upgrades",
      });
      expect(
        await withAggregateRowQuery({
          ...workspaceIdentity,
          tx,
          mode: "update",
          wait: "nowait",
          select,
        }),
      ).toMatchObject({ status: "locked" });
    });
  });
  test("joined projections lock only their explicit registered OF target", async () => {
    await withAggregateTransaction(db, async (rawTx) => {
      const tx = asTestRaw<Transaction>(rawTx);
      const result = await withAggregateRowQuery({
        ...workspaceIdentity,
        tx,
        mode: "share",
        lockConfig: { of: workspaces },
        select: (queryTx) =>
          queryTx
            .select({
              id: workspaces.id,
              organizationId: workspaces.organizationId,
              firm: organization.name,
            })
            .from(workspaces)
            .innerJoin(
              organization,
              eq(organization.id, workspaces.organizationId),
            )
            .where(eq(workspaces.id, workspaceId)),
      });
      expect(result).toEqual({
        status: "locked",
        rows: [
          { id: workspaceId, organizationId, firm: "Aggregate query fixture" },
        ],
      });
    });
    const error = await rejectionOf(
      withAggregateTransaction(db, async (rawTx) => {
        const tx = asTestRaw<Transaction>(rawTx);
        return await withAggregateRowQuery({
          ...workspaceIdentity,
          tx,
          mode: "share",
          lockConfig: { of: organization },
          select: (queryTx) =>
            queryTx
              .select({
                id: workspaces.id,
                organizationId: workspaces.organizationId,
              })
              .from(workspaces)
              .innerJoin(
                organization,
                eq(organization.id, workspaces.organizationId),
              )
              .where(eq(workspaces.id, workspaceId)),
        });
      }),
    );
    expect(error).toMatchObject({
      message:
        "Aggregate query lock target does not match its registered resource",
    });
  });

  test("NOWAIT query failures propagate unchanged and leave the parent transaction usable", async () => {
    await withAggregateTransaction(db, async (rawTx) => {
      const tx = asTestRaw<Transaction>(rawTx);
      const failure = new TransactionRollbackError();
      expect(
        await rejectionOf(
          withAggregateRowQuery({
            ...workspaceIdentity,
            tx,
            mode: "update",
            wait: "nowait",
            select: () => {
              throw failure;
            },
          }),
        ),
      ).toBe(failure);
      expect(
        await withAggregateLock({
          aggregate: "organization",
          id: organizationId,
          mode: "update",
          tx,
        }),
      ).toEqual({ status: "locked" });
    });
  });

  test("rejects a blocking mode upgrade after a higher-ranked acquisition", async () => {
    await withAggregateTransaction(db, async (rawTx) => {
      const tx = asTestRaw<Transaction>(rawTx);
      await withAggregateLock({
        aggregate: "organization",
        id: organizationId,
        mode: "key share",
        tx,
      });
      await withAggregateRowQuery({
        ...workspaceIdentity,
        tx,
        mode: "update",
        select: (queryTx) =>
          queryTx
            .select({
              id: workspaces.id,
              organizationId: workspaces.organizationId,
            })
            .from(workspaces)
            .where(eq(workspaces.id, workspaceId)),
      });
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
        message:
          "Take the strongest aggregate row mode first; use NOWAIT for upgrades",
      });
      expect(
        await withAggregateLock({
          aggregate: "organization",
          id: organizationId,
          mode: "key share",
          tx,
        }),
      ).toEqual({ status: "locked" });
    });
  });
});

describe("NOWAIT acquisition fencing", () => {
  test("an exposed child transaction cannot acquire another fence while its exact query is unresolved", async () => {
    await withAggregateTransaction(db, async (rawTx) => {
      const tx = asTestRaw<Transaction>(rawTx);
      const ready = Promise.withResolvers<undefined>();
      const release = Promise.withResolvers<undefined>();
      let exposedChild: Transaction | undefined;
      const acquisition = withAggregateRowQuery({
        ...workspaceIdentity,
        tx,
        mode: "update",
        wait: "nowait",
        select: (child) => {
          exposedChild = child;
          const query = child
            .select({
              id: workspaces.id,
              organizationId: workspaces.organizationId,
            })
            .from(workspaces)
            .where(eq(workspaces.id, workspaceId));
          return {
            toSQL: () => query.toSQL(),
            as: (alias: string) => query.as(alias),
            for: async (...args: Parameters<typeof query.for>) => {
              const rows = await query.for(...args);
              ready.resolve(undefined);
              await release.promise;
              return rows;
            },
          };
        },
      });
      try {
        await Promise.race([ready.promise, acquisition]);
        const child =
          exposedChild ?? panic("Missing exposed query transaction");
        expect(
          await rejectionOf(
            withAggregateLock({
              aggregate: "organization",
              id: organizationId,
              mode: "update",
              tx: child,
            }),
          ),
        ).toMatchObject({
          message:
            "Await each aggregate lock acquisition before starting another",
        });
      } finally {
        release.resolve(undefined);
      }
      expect(await acquisition).toEqual({
        status: "locked",
        rows: [{ id: workspaceId, organizationId }],
      });
      expect(
        await withAggregateLock({ ...workspaceIdentity, mode: "update", tx }),
      ).toEqual({ status: "locked" });
    });
  });
});

describe("top-level aggregate transaction entry", () => {
  test.each(["tracked", "public-rollback"] as const)(
    "%s handles cannot enter the top-level owner or dispatch a nested transaction",
    async (handleKind) => {
      let queries = 0;
      let nestedTransactions = 0;
      const execute = async (_statement: SQL) => {
        queries += 1;
        return [{ id: organizationId }];
      };
      const probe = {
        execute,
        transaction: async <Value>(
          run: (tx: { execute: typeof execute }) => Promise<Value>,
        ) => {
          nestedTransactions += 1;
          return await run({ execute });
        },
      };
      if (handleKind === "public-rollback") {
        const publicHandle = {
          ...probe,
          rollback: () => {
            throw new TransactionRollbackError();
          },
        };
        expect(
          await rejectionOf(
            withAggregateTransaction(
              publicHandle,
              async (tx) => await tx.execute(sql`SELECT 1`),
            ),
          ),
        ).toMatchObject({
          message: expect.stringContaining("aggregate savepoint"),
        });
        expect(nestedTransactions).toBe(0);
        expect(queries).toBe(0);
        expect(
          await withAggregateLock({
            aggregate: "organization",
            id: organizationId,
            mode: "update",
            tx: publicHandle,
          }),
        ).toEqual({ status: "locked" });
        expect(queries).toBe(1);
        return;
      }
      const database = {
        transaction: async <Value>(run: (tx: typeof probe) => Promise<Value>) =>
          await run(probe),
      };
      await withAggregateTransaction(database, async (parent) => {
        await withAggregateLock({
          ...workspaceIdentity,
          mode: "update",
          tx: parent,
        });
        expect(
          await rejectionOf(
            withAggregateTransaction(
              parent,
              async (child) => await child.execute(sql`SELECT 1`),
            ),
          ),
        ).toMatchObject({
          message: expect.stringContaining("aggregate savepoint"),
        });
        expect(nestedTransactions).toBe(0);
        expect(queries).toBe(1);
        expect(
          await withAggregateLock({
            ...workspaceIdentity,
            mode: "update",
            tx: parent,
          }),
        ).toEqual({ status: "locked" });
        expect(queries).toBe(2);
      });
    },
  );
});

describe("aggregate transaction lifetime", () => {
  test.each(["commit", "rollback"] as const)(
    "%s: child locks are retained only after savepoint commit",
    async (disposition) => {
      await withAggregateTransaction(db, async (rawTx) => {
        const tx = asTestRaw<Transaction>(rawTx);
        const child = withAggregateSavepoint(tx, async (savepoint) => {
          await withAggregateRowQuery({
            ...workspaceIdentity,
            tx: savepoint,
            mode: "update",
            select: (queryTx) =>
              queryTx
                .select({
                  id: workspaces.id,
                  organizationId: workspaces.organizationId,
                })
                .from(workspaces)
                .where(eq(workspaces.id, workspaceId)),
          });
          if (disposition === "rollback") {
            savepoint.rollback();
          }
        });
        if (disposition === "rollback") {
          expect(await rejectionOf(child)).toBeInstanceOf(
            TransactionRollbackError,
          );
          expect(
            await withAggregateLock({
              aggregate: "organization",
              id: organizationId,
              mode: "update",
              tx,
            }),
          ).toEqual({ status: "locked" });
          return;
        }
        await child;
        expect(
          await rejectionOf(
            withAggregateLock({
              aggregate: "organization",
              id: organizationId,
              mode: "update",
              tx,
            }),
          ),
        ).toMatchObject({ message: "Aggregate lock rank inversion" });
      });
    },
  );

  test("callback rollback closes the escaped root transaction without locks", async () => {
    let escaped: Transaction | undefined;
    expect(
      await rejectionOf(
        withAggregateTransaction(db, async (rawTx) => {
          escaped = asTestRaw<Transaction>(rawTx);
          escaped.rollback();
        }),
      ),
    ).toBeInstanceOf(TransactionRollbackError);
    const tx = escaped ?? panic("Missing escaped rollback transaction");
    expect(
      await rejectionOf(
        withAggregateLock({ ...workspaceIdentity, mode: "update", tx }),
      ),
    ).toMatchObject({ message: "Aggregate savepoint transaction is closed" });
  });

  test("escaped empty lock handles stay closed; nonlocking savepoints preserve driver behavior", async () => {
    let parent: Transaction | undefined;
    let child: Transaction | undefined;
    await withAggregateTransaction(db, async (rawTx) => {
      parent = asTestRaw<Transaction>(rawTx);
      await withAggregateSavepoint(parent, async (savepoint) => {
        child = savepoint;
      });
    });
    for (const escaped of [parent, child]) {
      const tx = escaped ?? panic("Missing escaped transaction");
      expect(
        await rejectionOf(
          withAggregateLock({ ...workspaceIdentity, mode: "update", tx }),
        ),
      ).toMatchObject({ message: "Aggregate savepoint transaction is closed" });
      // db-await-in-loop: compare both escaped levels against the same driver's public savepoint behavior.
      const direct = await Result.tryPromise(
        async () => await tx.transaction(async () => undefined),
      );
      // db-await-in-loop: this nonlocking operation must retain the driver's result on a closed handle.
      const owned = await Result.tryPromise(
        async () => await withAggregateSavepoint(tx, async () => undefined),
      );
      expect(owned.isOk()).toBe(direct.isOk());
      if (owned.isErr() && direct.isErr()) {
        expect(getPgErrorCode(owned.error)).toBe(getPgErrorCode(direct.error));
      }
    }
  });

  test("structural callback inference and commit failure preserve the value/error contract and close history", async () => {
    const tx = { label: "subset", execute: async () => [] };
    const commitFailure = new TransactionRollbackError();
    const database = {
      transaction: async <Value>(
        run: (transaction: typeof tx) => Promise<Value>,
      ) => {
        const value = await run(tx);
        return value;
      },
    };
    expect(
      await withAggregateTransaction(database, async (subset) => ({
        label: subset.label,
      })),
    ).toEqual({ label: "subset" });
    expect(
      await rejectionOf(
        withAggregateLock({ ...workspaceIdentity, mode: "update", tx }),
      ),
    ).toMatchObject({ message: "Aggregate savepoint transaction is closed" });
    const freshTx = { label: "fresh subset", execute: async () => [] };
    const failingDatabase = {
      transaction: async <Value>(
        run: (transaction: typeof freshTx) => Promise<Value>,
      ) => {
        await run(freshTx);
        throw commitFailure;
      },
    };
    expect(
      await rejectionOf(
        withAggregateTransaction(
          failingDatabase,
          async (subset) => subset.label,
        ),
      ),
    ).toBe(commitFailure);
    expect(
      await rejectionOf(
        withAggregateLock({
          ...workspaceIdentity,
          mode: "update",
          tx: freshTx,
        }),
      ),
    ).toMatchObject({ message: "Aggregate savepoint transaction is closed" });
  });
});
