import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { asc, eq, sql } from "drizzle-orm";
import type { SQLWrapper } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import { organization } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import { safeDbFromScoped } from "@/api/db/safe-db";
import { entities, workspaces } from "@/api/db/schema";
import {
  setSharedLockTimeout,
  setSharedStatementTimeout,
} from "@/api/db/shared-pool-timeouts";
import { createSafeId } from "@/api/lib/branded-types";
import { TREE_PARENT_CYCLE_ERROR_CODE } from "@/api/lib/db/tree-parent-guard";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import type { GatedTestDb } from "@/api/tests/gated-test-database";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";

import { moveEntityHandler } from "./move";
import type { MoveEntityHandlerProps } from "./move";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

const seedHierarchy = async (db: GatedTestDb, order: readonly number[]) => {
  const organizationId = mintAuthProviderId<"organization">();
  const workspaceId = createSafeId<"workspace">();
  const ids = Array.from({ length: 4 }, () =>
    createSafeId<"entity">(),
  ).toSorted();
  const [a, b, c, d] = order.map((index) => ids[index]);
  if (!a || !b || !c || !d) {
    return panic("Hierarchy fixture must contain four folder ids");
  }
  await db.insert(organization).values({
    id: organizationId,
    name: "Hierarchy tests",
    slug: `hierarchy-${organizationId}`,
    createdAt: new Date(),
  });
  await db.insert(workspaces).values({
    id: workspaceId,
    organizationId,
    name: "Hierarchy tests",
    reference: workspaceId,
  });
  await db.insert(entities).values([
    { id: a, workspaceId, name: "A", kind: "folder" },
    { id: c, workspaceId, name: "C", kind: "folder" },
  ]);
  await db.insert(entities).values([
    { id: b, workspaceId, name: "B", kind: "folder", parentId: a },
    { id: d, workspaceId, name: "D", kind: "folder", parentId: c },
  ]);
  return { organizationId, workspaceId, a, b, c, d };
};

const expectTerminatingChains = async (
  db: GatedTestDb,
  workspaceId: MoveEntityHandlerProps["workspaceId"],
) => {
  const rows = await db
    .select({ id: entities.id, parentId: entities.parentId })
    .from(entities)
    .where(eq(entities.workspaceId, workspaceId));
  const parents = new Map(rows.map(({ id, parentId }) => [id, parentId]));
  for (const row of rows) {
    const seen = new Set<string>();
    let id: typeof row.id | null = row.id;
    while (id !== null) {
      expect(seen.has(id)).toBe(false);
      seen.add(id);
      const parentId = parents.get(id);
      if (parentId === undefined) {
        panic("Hierarchy contains a missing parent");
      }
      id = parentId;
    }
  }
};

type RunMoveOptions = {
  db: GatedTestDb;
  workspaceId: MoveEntityHandlerProps["workspaceId"];
  body: MoveEntityHandlerProps["body"];
  instrument?: (tx: Transaction) => Transaction;
};

const runMove = async ({
  db,
  workspaceId,
  body,
  instrument = (tx) => tx,
}: RunMoveOptions) =>
  await Result.gen(async function* () {
    return yield* moveEntityHandler({
      workspaceId,
      body,
      safeDb: safeDbFromScoped(
        async (run) =>
          await db.transaction(async (tx) => {
            await setSharedLockTimeout(tx, 5000);
            await setSharedStatementTimeout(tx, 10_000);
            return await run(instrument(tx));
          }),
      ),
      recordAuditEvent: async () => undefined,
      syncSearchActivity: async () => undefined,
    });
  });

type StatementBarrier = {
  before: (statement: string) => void;
  after: (statement: string) => Promise<void>;
  lockMode: "take" | "omit";
};

// Each real query still executes on its own Postgres transaction. Only the
// await boundary is delayed, so removing the workspace lock exposes two stale
// ancestor reads before either UPDATE; keeping it serializes those reads.
const withStatementBarrier = (tx: Transaction, barrier: StatementBarrier) =>
  new Proxy(tx, {
    get(target, key, receiver) {
      if (key !== "execute") {
        return Reflect.get(target, key, receiver);
      }
      return (query: SQLWrapper | string) => {
        const compiled =
          typeof query === "string"
            ? query
            : new PgDialect().sqlToQuery(query.getSQL()).sql;
        // The control runs the old path on real Postgres: omit only the matter
        // lock, with every entity read/write and ancestry check unchanged.
        const omitted =
          barrier.lockMode === "omit" && isWorkspaceLock(compiled);
        const text = omitted ? "SELECT 1" : compiled;
        const raw = target.execute(omitted ? sql`SELECT 1` : query);
        const execute = raw.execute.bind(raw);
        raw.execute = async (values) => {
          barrier.before(text);
          const result = await execute(values);
          await barrier.after(text);
          return result;
        };
        return raw;
      };
    },
  });

const isAncestorRead = (statement: string) =>
  statement.includes("WITH RECURSIVE ancestors");
const isWorkspaceLock = (statement: string) =>
  statement.includes('FROM "workspaces"') && statement.includes("FOR UPDATE");

const expectDescendantRefusal = (
  result: Awaited<ReturnType<typeof runMove>>,
) => {
  expect(result.isErr()).toBe(true);
  if (result.isOk()) {
    panic("Expected descendant refusal");
  }
  expect(result.error).toMatchObject({
    status: 400,
    message: "Cannot move a folder into one of its descendants",
  });
};

const permutations = (remaining: readonly number[]): number[][] => {
  if (remaining.length === 0) {
    return [[]];
  }
  return remaining.flatMap((value) =>
    permutations(remaining.filter((item) => item !== value)).map((rest) =>
      [value].concat(rest),
    ),
  );
};

// These suites need independent sessions and row locks, which PGlite cannot
// represent. The Postgres-gated CI runner supplies a fully migrated database.
if (!databaseUrl || !runPostgresTests) {
  describe.skip("folder moves on Postgres", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {
      expect(true).toBe(true);
    });
  });
} else {
  describe("folder moves on Postgres", () => {
    const cases = [
      ...permutations([0, 1, 2, 3]).flatMap((order) =>
        (["A", "C"] as const).map((firstMove) => ({
          order,
          firstMove,
          lockMode: "take" as const,
        })),
      ),
      {
        order: [0, 1, 2, 3],
        firstMove: "A" as const,
        lockMode: "omit" as const,
      },
    ];
    for (const { order, firstMove, lockMode } of cases) {
      test(`${lockMode === "take" ? "concurrent moves terminate" : "without the handler lock the trigger refuses the loop"} for ids ${order.join(",")} with ${firstMove} first`, async () => {
        await withGatedTestClients(databaseUrl, async ({ openClient }) => {
          const firstDb = openClient().db;
          const secondDb = openClient().db;
          const hierarchy = await seedHierarchy(firstDb, order);
          const firstRead = Promise.withResolvers<undefined>();
          const releaseFirst = Promise.withResolvers<undefined>();
          let ancestorReads = 0;
          const firstBody =
            firstMove === "A"
              ? { entityId: hierarchy.a, parentId: hierarchy.d }
              : { entityId: hierarchy.c, parentId: hierarchy.b };
          const secondBody =
            firstMove === "A"
              ? { entityId: hierarchy.c, parentId: hierarchy.b }
              : { entityId: hierarchy.a, parentId: hierarchy.d };
          const first = runMove({
            db: firstDb,
            workspaceId: hierarchy.workspaceId,
            body: firstBody,
            instrument: (tx) =>
              withStatementBarrier(tx, {
                lockMode,
                before: () => undefined,
                after: async (statement) => {
                  if (isAncestorRead(statement)) {
                    ancestorReads += 1;
                    firstRead.resolve(undefined);
                    await releaseFirst.promise;
                  }
                },
              }),
          });
          try {
            await Promise.race([
              firstRead.promise,
              first.then((result) => {
                if (result.isErr()) {
                  throw result.error;
                }
                return panic("First move finished before its ancestor read");
              }),
            ]);
            const second = runMove({
              db: secondDb,
              workspaceId: hierarchy.workspaceId,
              body: secondBody,
              instrument: (tx) =>
                withStatementBarrier(tx, {
                  lockMode,
                  before: (statement) => {
                    if (isWorkspaceLock(statement)) {
                      releaseFirst.resolve(undefined);
                    }
                  },
                  after: async (statement) => {
                    if (isAncestorRead(statement)) {
                      ancestorReads += 1;
                      releaseFirst.resolve(undefined);
                    }
                  },
                }),
            }).finally(() => releaseFirst.resolve(undefined));
            const results = await Promise.all([first, second]);
            expect(ancestorReads).toBe(2);
            switch (lockMode) {
              case "take":
                expect(results.filter((result) => result.isOk())).toHaveLength(
                  1,
                );
                expect(results[0].isOk()).toBe(true);
                expectDescendantRefusal(results[1]);
                await expectTerminatingChains(firstDb, hierarchy.workspaceId);
                break;
              case "omit": {
                // Both ancestor reads passed before either move wrote, so the
                // handler alone would persist A -> D -> C -> B -> A. The
                // `entities_parent_acyclic` trigger takes the matter lock at
                // the write and refuses whichever move comes second, with the
                // same 400 the pre-check gives.
                const refused = results.filter((result) => result.isErr());
                expect(refused).toHaveLength(1);
                const [loser] = refused;
                if (!loser) {
                  panic("Expected one refused move");
                }
                expectDescendantRefusal(loser);
                expect(
                  loser.isErr() &&
                    HandlerError.is(loser.error) &&
                    loser.error.code,
                ).toBe(TREE_PARENT_CYCLE_ERROR_CODE);
                await expectTerminatingChains(firstDb, hierarchy.workspaceId);
                break;
              }
              default:
                lockMode satisfies never;
                panic("Unhandled lock control");
            }
          } finally {
            releaseFirst.resolve(undefined);
            await first;
            await firstDb
              .delete(organization)
              .where(eq(organization.id, hierarchy.organizationId));
          }
        });
      }, 20_000);
    }

    test("sequential descendant refusal preserves status, message and parents", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const db = openClient().db;
        const hierarchy = await seedHierarchy(db, [0, 1, 2, 3]);
        try {
          const before = await db
            .select()
            .from(entities)
            .where(eq(entities.workspaceId, hierarchy.workspaceId))
            .orderBy(asc(entities.id));
          const refused = await runMove({
            db,
            workspaceId: hierarchy.workspaceId,
            body: { entityId: hierarchy.a, parentId: hierarchy.b },
          });
          expectDescendantRefusal(refused);
          expect(
            await db
              .select()
              .from(entities)
              .where(eq(entities.workspaceId, hierarchy.workspaceId))
              .orderBy(asc(entities.id)),
          ).toEqual(before);
          await expectTerminatingChains(db, hierarchy.workspaceId);
        } finally {
          await db
            .delete(organization)
            .where(eq(organization.id, hierarchy.organizationId));
        }
      });
    });
  });
}
