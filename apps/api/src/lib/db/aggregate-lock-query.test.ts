import { panic, Result } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, getTableName, sql, TransactionRollbackError } from "drizzle-orm";
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

// This adapter deliberately violates its row contract while preserving genuine SDK projection metadata.
const malformedWorkspaceQuery = (
  tx: Transaction,
  rows: { id: typeof workspaceId; organizationId: typeof organizationId }[],
) => {
  const query = tx
    .select({ id: workspaces.id, organizationId: workspaces.organizationId })
    .from(workspaces);
  return {
    toSQL: () => query.toSQL(),
    as: (alias: string) => query.as(alias),
    where: (predicate: SQL) => {
      const scoped = query.where(predicate);
      return {
        toSQL: () => scoped.toSQL(),
        as: (alias: string) => scoped.as(alias),
        for: async (...args: Parameters<typeof scoped.for>) => {
          await scoped.for(...args);
          return rows;
        },
      };
    },
  };
};

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
          .from(workspaces);
      const result = await withAggregateRowQuery({
        ...workspaceIdentity,
        tx,
        mode: "update",
        select: query,
        where: timestampMatchesCasToken(
          workspaces.lastActivityAt,
          captured.token,
        ),
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
        where: timestampMatchesCasToken(
          workspaces.lastActivityAt,
          captured.token,
        ),
      });
      expect(stale).toEqual({ status: "missing", rows: [] });
    });
  });

  test.each(["block", "nowait"] as const)(
    "a missing %s query reserves ordering without confirming a held mode",
    async (wait) => {
      await withAggregateTransaction(db, async (rawTx) => {
        const tx = asTestRaw<Transaction>(rawTx);
        const result = await withAggregateRowQuery({
          ...workspaceIdentity,
          tx,
          wait,
          mode: "key share",
          where: eq(workspaces.name, "absent projection"),
          select: (queryTx) =>
            queryTx
              .select({
                id: workspaces.id,
                organizationId: workspaces.organizationId,
              })
              .from(workspaces),
        });
        expect(result).toEqual({ status: "missing", rows: [] });
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
        expect(
          await withAggregateLock({
            ...workspaceIdentity,
            tx,
            mode: "update",
          }),
        ).toEqual({ status: "locked" });
        await withAggregateSavepoint(tx, async (child) => {
          expect(
            await withAggregateLock({
              ...workspaceIdentity,
              tx: child,
              mode: "key share",
            }),
          ).toEqual({ status: "locked" });
        });
      });
    },
  );

  test.each(["block", "nowait"] as const)(
    "a missing %s query cannot cover a same-key request below the high-water",
    async (wait) => {
      await withAggregateTransaction(db, async (rawTx) => {
        const tx = asTestRaw<Transaction>(rawTx);
        const select = (queryTx: Transaction) =>
          queryTx
            .select({
              id: workspaces.id,
              organizationId: workspaces.organizationId,
            })
            .from(workspaces);
        expect(
          await withAggregateSavepoint(
            tx,
            async (child) =>
              await withAggregateRowQuery({
                ...workspaceIdentity,
                tx: child,
                mode: "update",
                wait,
                where: sql`FALSE`,
                select,
              }),
          ),
        ).toEqual({ status: "missing", rows: [] });
        expect(
          await withAggregateLock({
            aggregate: "contactCapacity",
            id: { organizationId },
            tx,
          }),
        ).toEqual({ status: "locked" });
        expect(
          await rejectionOf(
            withAggregateLock({ ...workspaceIdentity, tx, mode: "update" }),
          ),
        ).toMatchObject({ message: "Aggregate lock rank inversion" });
        expect(
          await rejectionOf(
            withAggregateRowQuery({
              ...workspaceIdentity,
              tx,
              mode: "update",
              select,
            }),
          ),
        ).toMatchObject({ message: "Aggregate lock rank inversion" });
        expect(
          await withAggregateRowQuery({
            ...workspaceIdentity,
            tx,
            mode: "update",
            wait: "nowait",
            select,
          }),
        ).toMatchObject({ status: "locked" });
        expect(
          await withAggregateLock({ ...workspaceIdentity, tx, mode: "update" }),
        ).toEqual({ status: "locked" });
      });
    },
  );

  test("additional predicates cannot select another physical identity", async () => {
    await withAggregateTransaction(db, async (rawTx) => {
      const tx = asTestRaw<Transaction>(rawTx);
      expect(
        await withAggregateRowQuery({
          ...workspaceIdentity,
          tx,
          mode: "update",
          where: eq(workspaces.id, otherWorkspaceId),
          select: (queryTx) =>
            queryTx
              .select({
                id: workspaces.id,
                organizationId: workspaces.organizationId,
              })
              .from(workspaces),
        }),
      ).toEqual({ status: "missing", rows: [] });
      expect(
        await rejectionOf(
          withAggregateLock({
            aggregate: "organization",
            id: organizationId,
            tx,
            mode: "update",
          }),
        ),
      ).toMatchObject({ message: "Aggregate lock rank inversion" });
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
            queryTx.select({ id: organization.id }).from(organization),
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
              .from(organization),
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
            .from(workspaces),
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
            .from(workspaces),
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
            .from(workspaces),
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
                queryTx.select({ id, organizationId: tenant }).from(workspaces),
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
                ),
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

describe("owner-scoped query predicates", () => {
  test("broad predicates return only the declared row; a different tenant returns none", async () => {
    await withAggregateTransaction(db, async (rawTx) => {
      const tx = asTestRaw<Transaction>(rawTx);
      const select = (queryTx: Transaction) =>
        queryTx
          .select({
            id: workspaces.id,
            organizationId: workspaces.organizationId,
          })
          .from(workspaces);
      expect(
        await withAggregateRowQuery({
          ...workspaceIdentity,
          tx,
          mode: "update",
          where: eq(workspaces.organizationId, organizationId),
          select,
        }),
      ).toEqual({
        status: "locked",
        rows: [{ id: workspaceId, organizationId }],
      });
      expect(
        await withAggregateRowQuery({
          aggregate: "workspace",
          id: {
            id: workspaceId,
            organizationId: mintAuthProviderId<"organization">(),
          },
          tx,
          mode: "update",
          select,
        }),
      ).toEqual({ status: "missing", rows: [] });
    });
  });

  test.each(["filtered", "locked", "joined-locked", "offset"] as const)(
    "%s caller builders fail before scoping or execution and leave history idle",
    async (shape) => {
      await withAggregateTransaction(db, async (rawTx) => {
        const tx = asTestRaw<Transaction>(rawTx);
        let scoped = false;
        expect(
          await rejectionOf(
            withAggregateRowQuery({
              ...workspaceIdentity,
              tx,
              mode: "update",
              lockConfig: { of: workspaces },
              select: (queryTx) => {
                const base = queryTx
                  .select({
                    id: workspaces.id,
                    organizationId: workspaces.organizationId,
                  })
                  .from(workspaces)
                  .$dynamic();
                const query = (() => {
                  switch (shape) {
                    case "offset":
                      return base.offset(1);
                    case "filtered":
                      return base.where(eq(workspaces.id, workspaceId));
                    case "joined-locked":
                      return base
                        .innerJoin(
                          organization,
                          eq(organization.id, workspaces.organizationId),
                        )
                        .for("key share", { of: organization });
                    case "locked":
                      return base.for("share");
                    default:
                      shape satisfies never;
                      return panic("Unknown query contract fixture");
                  }
                })();
                return {
                  toSQL: () => query.toSQL(),
                  as: (alias: string) => query.as(alias),
                  where: (predicate: SQL) => {
                    scoped = true;
                    return query.where(predicate);
                  },
                };
              },
            }),
          ),
        ).toMatchObject({
          message: {
            offset: "Aggregate query must not include an offset",
            filtered:
              "Pass additional aggregate predicates through the where option",
            locked: "Aggregate query must not include a locking clause",
            "joined-locked":
              "Aggregate query must not include a locking clause",
          }[shape],
        });
        expect(scoped).toBe(false);
        expect(
          await withAggregateLock({
            aggregate: "organization",
            id: organizationId,
            tx,
            mode: "update",
          }),
        ).toEqual({ status: "locked" });
      });
    },
  );
});

describe("returned aggregate identity validation", () => {
  test.each(["identity", "tenant", "cardinality"] as const)(
    "a blocking malformed %s response records returned identities and leaves history idle",
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
                malformedWorkspaceQuery(
                  queryTx,
                  returnedIds.map((id) => ({ id, organizationId })),
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
              malformedWorkspaceQuery(queryTx, [
                { id: workspaceId, organizationId },
              ]),
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
              malformedWorkspaceQuery(
                queryTx,
                [workspaceId, otherWorkspaceId].map((id) => ({
                  id,
                  organizationId,
                })),
              ),
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
    "nested FOR %s in an additional predicate is refused before acquisition",
    async (mode) => {
      await withAggregateTransaction(db, async (rawTx) => {
        const tx = asTestRaw<Transaction>(rawTx);
        expect(
          await rejectionOf(
            withAggregateRowQuery({
              ...workspaceIdentity,
              tx,
              mode: "update",
              where: sql`EXISTS (SELECT 1 FROM ${organization} ${sql.raw(`FOR ${mode.toUpperCase()}`)})`,
              select: (queryTx) =>
                queryTx
                  .select({
                    id: workspaces.id,
                    organizationId: workspaces.organizationId,
                  })
                  .from(workspaces),
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
                  .from(workspaces),
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
              ...(invalid === "of" ? { lockConfig: { of: organization } } : {}),
              select: (queryTx) =>
                queryTx
                  .select({
                    id: workspaces.id,
                    organizationId: workspaces.organizationId,
                  })
                  .from(workspaces),
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
          .from(workspaces);
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
            ),
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
              ),
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
            .from(workspaces),
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
            .from(workspaces);
          return {
            toSQL: () => query.toSQL(),
            as: (alias: string) => query.as(alias),
            where: (predicate: SQL) => {
              const scoped = query.where(predicate);
              return {
                toSQL: () => scoped.toSQL(),
                as: (alias: string) => scoped.as(alias),
                for: async (...args: Parameters<typeof scoped.for>) => {
                  const rows = await scoped.for(...args);
                  ready.resolve(undefined);
                  await release.promise;
                  return rows;
                },
              };
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
    "%s: empty-query reservations follow savepoint lifetime",
    async (disposition) => {
      await withAggregateTransaction(db, async (rawTx) => {
        const tx = asTestRaw<Transaction>(rawTx);
        const child = withAggregateSavepoint(tx, async (savepoint) => {
          expect(
            await withAggregateRowQuery({
              ...workspaceIdentity,
              tx: savepoint,
              mode: "update",
              where: sql`FALSE`,
              select: (queryTx) =>
                queryTx
                  .select({
                    id: workspaces.id,
                    organizationId: workspaces.organizationId,
                  })
                  .from(workspaces),
            }),
          ).toEqual({ status: "missing", rows: [] });
          if (disposition === "rollback") {
            savepoint.rollback();
          }
        });
        const lower = {
          aggregate: "organization",
          id: organizationId,
          mode: "update",
          tx,
        } as const;
        if (disposition === "rollback") {
          expect(await rejectionOf(child)).toBeInstanceOf(
            TransactionRollbackError,
          );
          expect(await withAggregateLock(lower)).toEqual({ status: "locked" });
          return;
        }
        await child;
        expect(await rejectionOf(withAggregateLock(lower))).toMatchObject({
          message: "Aggregate lock rank inversion",
        });
      });
    },
  );

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
                .from(workspaces),
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
