import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { eq, sql, TransactionRollbackError } from "drizzle-orm";
import type { SQLWrapper } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import { organization } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import { safeDbFromScoped } from "@/api/db/safe-db";
import type { ScopedDb } from "@/api/db/safe-db";
import {
  clauseCategories,
  entities,
  templateCategories,
  workspaces,
} from "@/api/db/schema";
import { setSharedLockTimeout } from "@/api/db/shared-pool-timeouts";
import { updateCategoryHandler } from "@/api/handlers/clauses/categories";
import { updateTemplateCategoryHandler } from "@/api/handlers/templates/categories";
import { createSafeId, toSafeId } from "@/api/lib/branded-types";
import type { SafeId, SafeIdType } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { getPgErrorCode } from "@/api/lib/pg-error";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import type { GatedTestDb } from "@/api/tests/gated-test-database";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

import {
  isTreeParentGuardError,
  lockTree,
  SELF_REFERENCE_EXEMPTIONS,
  TREE_PARENT_CYCLE_ERROR_CODE,
  TREE_PARENT_GUARD_SQLSTATE,
  TREE_PARENT_GUARDS,
  treeParentTriggerArguments,
} from "./tree-parent-guard";
import type { TreeName } from "./tree-parent-guard";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

type Db = Pick<GatedTestDb, "insert" | "update" | "select">;

const nullableId = <T extends SafeIdType>(value: string | null) =>
  value === null ? null : toSafeId<T>(value);

type Scope = {
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
};

type Tree = {
  insert: (
    db: Db,
    scope: Scope,
    rows: readonly {
      id: string;
      parentId: string | null;
      /** Defaults to the statement's scope. */
      scope?: Scope;
    }[],
  ) => Promise<unknown>;
  setParent: (db: Db, id: string, parentId: string | null) => Promise<unknown>;
  parents: (db: Db, scope: Scope) => Promise<Map<string, string | null>>;
};

const TREES: Record<TreeName, Tree> = {
  entities: {
    insert: async (db, scope, rows) =>
      await db.insert(entities).values(
        rows.map((row) => ({
          id: toSafeId<"entity">(row.id),
          parentId: nullableId<"entity">(row.parentId),
          workspaceId: (row.scope ?? scope).workspaceId,
          name: "Folder",
          kind: "folder" as const,
        })),
      ),
    setParent: async (db, id, parentId) =>
      await db
        .update(entities)
        .set({ parentId: nullableId<"entity">(parentId) })
        .where(eq(entities.id, toSafeId<"entity">(id))),
    parents: async (db, scope) =>
      new Map(
        (
          await db
            .select({ id: entities.id, parentId: entities.parentId })
            .from(entities)
            .where(eq(entities.workspaceId, scope.workspaceId))
        ).map(({ id, parentId }) => [id, parentId]),
      ),
  },
  clauseCategories: {
    insert: async (db, scope, rows) =>
      await db.insert(clauseCategories).values(
        rows.map((row) => ({
          id: toSafeId<"clauseCategory">(row.id),
          parentId: nullableId<"clauseCategory">(row.parentId),
          organizationId: (row.scope ?? scope).organizationId,
          name: "Category",
        })),
      ),
    setParent: async (db, id, parentId) =>
      await db
        .update(clauseCategories)
        .set({ parentId: nullableId<"clauseCategory">(parentId) })
        .where(eq(clauseCategories.id, toSafeId<"clauseCategory">(id))),
    parents: async (db, scope) =>
      new Map(
        (
          await db
            .select({
              id: clauseCategories.id,
              parentId: clauseCategories.parentId,
            })
            .from(clauseCategories)
            .where(eq(clauseCategories.organizationId, scope.organizationId))
        ).map(({ id, parentId }) => [id, parentId]),
      ),
  },
  templateCategories: {
    insert: async (db, scope, rows) =>
      await db.insert(templateCategories).values(
        rows.map((row) => ({
          id: toSafeId<"templateCategory">(row.id),
          parentId: nullableId<"templateCategory">(row.parentId),
          organizationId: (row.scope ?? scope).organizationId,
          name: "Category",
        })),
      ),
    setParent: async (db, id, parentId) =>
      await db
        .update(templateCategories)
        .set({ parentId: nullableId<"templateCategory">(parentId) })
        .where(eq(templateCategories.id, toSafeId<"templateCategory">(id))),
    parents: async (db, scope) =>
      new Map(
        (
          await db
            .select({
              id: templateCategories.id,
              parentId: templateCategories.parentId,
            })
            .from(templateCategories)
            .where(eq(templateCategories.organizationId, scope.organizationId))
        ).map(({ id, parentId }) => [id, parentId]),
      ),
  },
};

const isTreeName = (key: string): key is TreeName =>
  Object.hasOwn(TREE_PARENT_GUARDS, key);

const TREE_NAMES = Object.keys(TREE_PARENT_GUARDS).filter(isTreeName);

const createScope = async (db: GatedTestDb): Promise<Scope> => {
  const organizationId = mintAuthProviderId<"organization">();
  const workspaceId = createSafeId<"workspace">();
  await db.insert(organization).values({
    id: organizationId,
    name: "Tree guard tests",
    slug: `tree-guard-${organizationId}`,
    createdAt: new Date(),
  });
  await db.insert(workspaces).values({
    id: workspaceId,
    organizationId,
    name: "Tree guard tests",
    reference: workspaceId,
  });
  return { organizationId, workspaceId };
};

const dropScope = async (db: GatedTestDb, scope: Scope) =>
  await db
    .delete(organization)
    .where(eq(organization.id, scope.organizationId));

/** Every chain ends at a root; a stored loop fails here. */
const expectAcyclic = (parents: ReadonlyMap<string, string | null>) => {
  for (const start of parents.keys()) {
    const seen = new Set<string>();
    let id: string | null = start;
    while (id !== null) {
      expect(seen.has(id)).toBe(false);
      seen.add(id);
      const parentId = parents.get(id);
      if (parentId === undefined) {
        panic("Tree contains a parent outside the fixture");
      }
      id = parentId;
    }
  }
};

const failureOf = async (work: Promise<unknown>): Promise<unknown> =>
  await work.then(
    () => undefined,
    (error: unknown) => error,
  );

const expectGuardRefusal = (error: unknown, tree: TreeName) => {
  expect(error).toBeDefined();
  expect(getPgErrorCode(error)).toBe(TREE_PARENT_GUARD_SQLSTATE);
  expect(isTreeParentGuardError(error, tree)).toBe(true);
};

const backendPid = async (db: GatedTestDb): Promise<number> => {
  const rows = await db
    .select({ pid: sql<number>`pg_backend_pid()` })
    .from(sql`(SELECT 1) AS backend_identity`);
  return rows.at(0)?.pid ?? panic("Backend pid missing");
};

/** Wait until `waiterPid` is blocked by `holderPid`, as Postgres reports it. */
const observeBlocked = async (
  observer: GatedTestDb,
  waiterPid: number,
  holderPid: number,
) => {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const rows = await observer
      .select({
        blocked: sql<boolean>`${holderPid}::int = ANY(pg_blocking_pids(${waiterPid}::int))`,
      })
      .from(sql`(SELECT 1) AS lock_observation`);
    if (rows.at(0)?.blocked) {
      return;
    }
    await Bun.sleep(10);
  }
  panic("The second reparent never waited on the first one's tree lock");
};

const ids = () => ({
  a: createSafeId<"entity">() as string,
  b: createSafeId<"entity">() as string,
  c: createSafeId<"entity">() as string,
});

// These suites need independent sessions and lock waits, which PGlite cannot
// represent. The Postgres-gated CI runner supplies a fully migrated database.
if (!databaseUrl || !runPostgresTests) {
  describe.skip("tree parent guard (postgres)", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {
      expect(true).toBe(true);
    });
  });
} else {
  describe("installed tree triggers", () => {
    const selfReferenceQuery = sql`
      SELECT c.relname AS table_name,
             string_agg(a.attname, ',' ORDER BY k.ord) AS columns
        FROM pg_constraint con
        JOIN pg_class c ON c.oid = con.conrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        CROSS JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord)
        JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum
       WHERE con.contype = 'f'
         AND con.conrelid = con.confrelid
         AND n.nspname = 'public'
       GROUP BY con.oid, c.relname`;

    const unguarded = (rows: readonly Record<string, unknown>[]) =>
      rows
        .map((row) => `${String(row["table_name"])}.${String(row["columns"])}`)
        .filter(
          (key) =>
            !Object.values(TREE_PARENT_GUARDS).some(
              (guard) => `${guard.table}.parent_id` === key,
            ) && SELF_REFERENCE_EXEMPTIONS[key] === undefined,
        )
        .toSorted();

    test("every self-referencing foreign key in the database is a guarded tree or an exemption", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db } = openClient();
        expect(unguarded(await db.execute(selfReferenceQuery))).toEqual([]);
      });
    });

    // The scan must be able to fail: a self-referencing table nobody registered.
    test("the scan reports an unregistered self-referencing table", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db } = openClient();
        let found: string[] = [];
        const rolledBack = await failureOf(
          db.transaction(async (tx) => {
            await tx.execute(sql`
              CREATE TABLE public.tree_guard_scan_fixture (
                id uuid PRIMARY KEY,
                parent_id uuid REFERENCES public.tree_guard_scan_fixture (id)
              )`);
            found = unguarded(await tx.execute(selfReferenceQuery));
            tx.rollback();
          }),
        );
        expect(rolledBack).toBeInstanceOf(TransactionRollbackError);
        expect(found).toEqual(["tree_guard_scan_fixture.parent_id"]);
      });
    });

    test("each tree's trigger is enabled, fires after insert and parent updates, with the registry's arguments", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db } = openClient();
        for (const guard of Object.values(TREE_PARENT_GUARDS)) {
          const rows = await db.execute(sql`
            SELECT t.tgenabled::text AS enabled,
                   t.tgnargs AS nargs,
                   encode(t.tgargs, 'escape') AS args,
                   p.proname AS function_name,
                   pg_get_triggerdef(t.oid) AS definition
              FROM pg_trigger t
              JOIN pg_class c ON c.oid = t.tgrelid
              JOIN pg_proc p ON p.oid = t.tgfoid
             WHERE c.relname = ${guard.table}
               AND t.tgname = ${guard.constraint}`);
          const row = rows.at(0);
          expect({ table: guard.table, found: row !== undefined }).toEqual({
            table: guard.table,
            found: true,
          });
          expect(row?.["enabled"]).toBe("O");
          expect(row?.["function_name"]).toBe("guard_tree_parent");
          expect(String(row?.["definition"])).toContain(
            `AFTER INSERT OR UPDATE OF parent_id ON public.${guard.table} FOR EACH ROW`,
          );
          const args = String(row?.["args"])
            .split("\\000")
            .slice(0, Number(row?.["nargs"]));
          expect(args).toEqual([...treeParentTriggerArguments(guard)]);
        }
      });
    });
  });

  for (const treeName of TREE_NAMES) {
    const tree = TREES[treeName];

    for (const isolationLevel of ["repeatable read", "serializable"] as const) {
      describe(`${treeName}: ${isolationLevel} parent writes`, () => {
        for (const operation of [
          "attach",
          "reparent",
          "detach",
          "insert",
        ] as const) {
          test(`${operation} requires READ COMMITTED and preserves the stored tree`, async () => {
            await withGatedTestClients(databaseUrl, async ({ openClient }) => {
              const { db } = openClient();
              const scope = await createScope(db);
              try {
                const { a, b, c } = ids();
                await tree.insert(db, scope, [{ id: a, parentId: null }]);
                await tree.insert(db, scope, [{ id: b, parentId: a }]);
                await tree.insert(db, scope, [{ id: c, parentId: null }]);
                const before = await tree.parents(db, scope);
                const refusal = await failureOf(
                  db.transaction(
                    async (tx) => {
                      // Bind the snapshot before the parent write.
                      expect(await tree.parents(tx, scope)).toEqual(before);
                      switch (operation) {
                        case "attach":
                          await tree.setParent(tx, c, a);
                          break;
                        case "reparent":
                          await tree.setParent(tx, b, c);
                          break;
                        case "detach":
                          await tree.setParent(tx, b, null);
                          break;
                        case "insert":
                          await tree.insert(tx, scope, [
                            { id: createSafeId<"entity">(), parentId: a },
                          ]);
                          break;
                        default:
                          operation satisfies never;
                      }
                    },
                    { isolationLevel },
                  ),
                );
                expectGuardRefusal(refusal, treeName);
                expect(refusal).toMatchObject({
                  cause: {
                    message:
                      "tree parent writes require READ COMMITTED isolation",
                  },
                });
                expect(await tree.parents(db, scope)).toEqual(before);
              } finally {
                await dropScope(db, scope);
              }
            });
          });
        }

        test("root inserts and unchanged parent updates commit", async () => {
          await withGatedTestClients(databaseUrl, async ({ openClient }) => {
            const { db } = openClient();
            const scope = await createScope(db);
            try {
              const { a, b, c } = ids();
              await tree.insert(db, scope, [{ id: a, parentId: null }]);
              await tree.insert(db, scope, [{ id: b, parentId: a }]);
              await db.transaction(
                async (tx) => {
                  await tree.insert(tx, scope, [{ id: c, parentId: null }]);
                  await tree.setParent(tx, a, null);
                  await tree.setParent(tx, b, a);
                },
                { isolationLevel },
              );
              expect(await tree.parents(db, scope)).toEqual(
                new Map([
                  [a, null],
                  [b, a],
                  [c, null],
                ]),
              );
            } finally {
              await dropScope(db, scope);
            }
          });
        });
      });
    }

    test(`${treeName}: READ COMMITTED parent writes commit`, async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db } = openClient();
        const scope = await createScope(db);
        try {
          const { a, b, c } = ids();
          await tree.insert(db, scope, [{ id: a, parentId: null }]);
          await db.transaction(
            async (tx) => {
              await tree.insert(tx, scope, [{ id: b, parentId: a }]);
              await tree.insert(tx, scope, [{ id: c, parentId: null }]);
              await tree.setParent(tx, c, a);
              await tree.setParent(tx, b, c);
              await tree.setParent(tx, c, null);
            },
            { isolationLevel: "read committed" },
          );
          expect(await tree.parents(db, scope)).toEqual(
            new Map([
              [a, null],
              [b, c],
              [c, null],
            ]),
          );
        } finally {
          await dropScope(db, scope);
        }
      });
    });

    describe(`${treeName}: single-transaction refusals`, () => {
      test("a row naming itself as parent is refused on insert and on update", async () => {
        await withGatedTestClients(databaseUrl, async ({ openClient }) => {
          const { db } = openClient();
          const scope = await createScope(db);
          try {
            const { a, b } = ids();
            await tree.insert(db, scope, [{ id: a, parentId: null }]);
            expectGuardRefusal(
              await failureOf(tree.insert(db, scope, [{ id: b, parentId: b }])),
              treeName,
            );
            expectGuardRefusal(
              await failureOf(tree.setParent(db, a, a)),
              treeName,
            );
            expect(await tree.parents(db, scope)).toEqual(new Map([[a, null]]));
          } finally {
            await dropScope(db, scope);
          }
        });
      });

      test("a move under a deep descendant is refused, a legal move and a detach are applied", async () => {
        await withGatedTestClients(databaseUrl, async ({ openClient }) => {
          const { db } = openClient();
          const scope = await createScope(db);
          try {
            const { a, b, c } = ids();
            const d = createSafeId<"entity">() as string;
            await tree.insert(db, scope, [
              { id: a, parentId: null },
              { id: d, parentId: null },
            ]);
            await tree.insert(db, scope, [{ id: b, parentId: a }]);
            await tree.insert(db, scope, [{ id: c, parentId: b }]);

            const refusal = await failureOf(tree.setParent(db, a, c));
            expectGuardRefusal(refusal, treeName);
            expect(refusal).toMatchObject({
              cause: {
                message: expect.stringContaining(
                  "cannot move under its own descendant",
                ),
              },
            });

            await tree.setParent(db, d, c);
            await tree.setParent(db, b, null);
            expect(await tree.parents(db, scope)).toEqual(
              new Map([
                [a, null],
                [b, null],
                [c, b],
                [d, c],
              ]),
            );
          } finally {
            await dropScope(db, scope);
          }
        });
      });

      // The self-referencing foreign key is checked at the end of the
      // statement, so one INSERT can name rows it creates itself.
      test("one INSERT whose rows point at each other is refused and stores nothing", async () => {
        await withGatedTestClients(databaseUrl, async ({ openClient }) => {
          const { db } = openClient();
          const scope = await createScope(db);
          try {
            const { a, b, c } = ids();
            expectGuardRefusal(
              await failureOf(
                tree.insert(db, scope, [
                  { id: a, parentId: b },
                  { id: b, parentId: a },
                ]),
              ),
              treeName,
            );
            const threeRowLoop = await failureOf(
              tree.insert(db, scope, [
                { id: a, parentId: c },
                { id: b, parentId: a },
                { id: c, parentId: b },
              ]),
            );
            expectGuardRefusal(threeRowLoop, treeName);
            expect(threeRowLoop).toMatchObject({
              cause: {
                message: expect.stringContaining(
                  "inserted tree rows cannot form a loop",
                ),
              },
            });
            expect(await tree.parents(db, scope)).toEqual(new Map());
          } finally {
            await dropScope(db, scope);
          }
        });
      });

      test("an inserted row whose parent is in another scope is refused", async () => {
        await withGatedTestClients(databaseUrl, async ({ openClient }) => {
          const { db } = openClient();
          const scope = await createScope(db);
          const otherScope = await createScope(db);
          try {
            const { a, b } = ids();
            await tree.insert(db, otherScope, [{ id: a, parentId: null }]);
            const refusal = await failureOf(
              tree.insert(db, scope, [{ id: b, parentId: a }]),
            );
            expectGuardRefusal(refusal, treeName);
            expect(refusal).toMatchObject({
              cause: {
                message: expect.stringContaining(
                  "cannot have a parent in another scope",
                ),
              },
            });
            // The parent may also arrive in the same statement, after the row.
            const { c } = ids();
            expectGuardRefusal(
              await failureOf(
                tree.insert(db, scope, [
                  { id: b, parentId: c },
                  { id: c, parentId: null, scope: otherScope },
                ]),
              ),
              treeName,
            );
            expect(await tree.parents(db, scope)).toEqual(new Map());
            expect(await tree.parents(db, otherScope)).toEqual(
              new Map([[a, null]]),
            );
          } finally {
            await dropScope(db, scope);
            await dropScope(db, otherScope);
          }
        });
      });

      // Copies, duplicates and folder uploads insert a whole subtree in one
      // statement; the order of the rows in it does not matter.
      test("acyclic inserts are applied: a subtree in one statement, children listed first, and rows under existing parents", async () => {
        await withGatedTestClients(databaseUrl, async ({ openClient }) => {
          const { db } = openClient();
          const scope = await createScope(db);
          try {
            const { a, b, c } = ids();
            const d = createSafeId<"entity">() as string;
            await tree.insert(db, scope, [
              { id: c, parentId: b },
              { id: b, parentId: a },
              { id: a, parentId: null },
            ]);
            await tree.insert(db, scope, [{ id: d, parentId: c }]);
            expect(await tree.parents(db, scope)).toEqual(
              new Map([
                [a, null],
                [b, a],
                [c, b],
                [d, c],
              ]),
            );
          } finally {
            await dropScope(db, scope);
          }
        });
      });

      test("a parent from another scope is refused on a reparent", async () => {
        await withGatedTestClients(databaseUrl, async ({ openClient }) => {
          const { db } = openClient();
          const scope = await createScope(db);
          const otherScope = await createScope(db);
          try {
            const { a, b } = ids();
            await tree.insert(db, scope, [{ id: a, parentId: null }]);
            await tree.insert(db, otherScope, [{ id: b, parentId: null }]);
            expectGuardRefusal(
              await failureOf(tree.setParent(db, a, b)),
              treeName,
            );
            expect(await tree.parents(db, scope)).toEqual(new Map([[a, null]]));
          } finally {
            await dropScope(db, scope);
            await dropScope(db, otherScope);
          }
        });
      });
    });

    // An insert can only close a loop inside its own statement, so the trigger
    // takes no tree lock for it. (An entity insert still waits on a held
    // matter-row lock through its own workspace foreign key, so only the
    // advisory-locked trees can show this.)
    if (treeName !== "entities") {
      test(`${treeName}: an insert does not wait on a held tree lock`, async () => {
        await withGatedTestClients(databaseUrl, async ({ openClient }) => {
          const holderDb = openClient().db;
          const writerDb = openClient().db;
          const observer = openClient().db;
          const scope = await createScope(observer);
          const { a, b } = ids();
          const locked = Promise.withResolvers<undefined>();
          const release = Promise.withResolvers<undefined>();
          try {
            await tree.insert(observer, scope, [{ id: a, parentId: null }]);
            const holder = holderDb.transaction(async (tx) => {
              await lockTree(asTestRaw<Transaction>(tx), {
                tree: treeName,
                scopeId: scope.organizationId,
              });
              locked.resolve(undefined);
              await release.promise;
            });
            await locked.promise;
            const inserted = await failureOf(
              writerDb.transaction(async (tx) => {
                await setSharedLockTimeout(asTestRaw<Transaction>(tx), 2000);
                await tree.insert(tx, scope, [{ id: b, parentId: a }]);
              }),
            );
            release.resolve(undefined);
            await holder;
            expect(inserted).toBeUndefined();
            expect(await tree.parents(observer, scope)).toEqual(
              new Map([
                [a, null],
                [b, a],
              ]),
            );
          } finally {
            release.resolve(undefined);
            await dropScope(observer, scope);
          }
        });
      }, 30_000);
    }

    // The handlers' `lockTree` and the trigger must be one key: a reparent
    // waits while a handler transaction holds the tree lock.
    test(`${treeName}: a reparent waits on the lock lockTree takes`, async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const holderDb = openClient().db;
        const writerDb = openClient().db;
        const observer = openClient().db;
        const scope = await createScope(observer);
        const { a, b } = ids();
        const locked = Promise.withResolvers<undefined>();
        const release = Promise.withResolvers<undefined>();
        try {
          await tree.insert(observer, scope, [
            { id: a, parentId: null },
            { id: b, parentId: null },
          ]);
          const holderPid = await backendPid(holderDb);
          const writerPid = await backendPid(writerDb);
          const holder = holderDb.transaction(async (tx) => {
            await lockTree(
              asTestRaw<Transaction>(tx),
              treeName === "entities"
                ? { tree: treeName, scopeId: scope.workspaceId }
                : { tree: treeName, scopeId: scope.organizationId },
            );
            locked.resolve(undefined);
            await release.promise;
          });
          await locked.promise;

          const reparent = failureOf(
            writerDb.transaction(async (tx) => {
              await setSharedLockTimeout(asTestRaw<Transaction>(tx), 10_000);
              await tree.setParent(tx, b, a);
            }),
          );
          await observeBlocked(observer, writerPid, holderPid);
          release.resolve(undefined);
          await holder;
          expect(await reparent).toBeUndefined();
          expect(await tree.parents(observer, scope)).toEqual(
            new Map([
              [a, null],
              [b, a],
            ]),
          );
        } finally {
          release.resolve(undefined);
          await dropScope(observer, scope);
        }
      });
    }, 30_000);

    describe(`${treeName}: concurrent opposite reparents`, () => {
      const cases = [
        { first: "a-under-b", outcome: "commit" },
        { first: "b-under-a", outcome: "commit" },
        { first: "a-under-b", outcome: "rollback" },
      ] as const;

      for (const { first, outcome } of cases) {
        test(`${first} first, which then ${outcome === "commit" ? "commits" : "rolls back"}: the other waits for the tree lock and ${outcome === "commit" ? "is refused" : "is applied"}`, async () => {
          await withGatedTestClients(databaseUrl, async ({ openClient }) => {
            const firstDb = openClient().db;
            const secondDb = openClient().db;
            const observer = openClient().db;
            const scope = await createScope(observer);
            const { a, b } = ids();
            const [firstChild, firstParent] =
              first === "a-under-b" ? [a, b] : [b, a];
            const updated = Promise.withResolvers<undefined>();
            const release = Promise.withResolvers<undefined>();
            try {
              await tree.insert(observer, scope, [
                { id: a, parentId: null },
                { id: b, parentId: null },
              ]);
              const firstPid = await backendPid(firstDb);
              const secondPid = await backendPid(secondDb);

              const firstMove = failureOf(
                firstDb.transaction(async (tx) => {
                  await setSharedLockTimeout(
                    asTestRaw<Transaction>(tx),
                    10_000,
                  );
                  await tree.setParent(tx, firstChild, firstParent);
                  updated.resolve(undefined);
                  await release.promise;
                  if (outcome === "rollback") {
                    tx.rollback();
                  }
                }),
              );
              await Promise.race([
                updated.promise,
                firstMove.then((error) =>
                  panic(`First reparent settled early: ${String(error)}`),
                ),
              ]);

              const secondMove = failureOf(
                secondDb.transaction(async (tx) => {
                  await setSharedLockTimeout(
                    asTestRaw<Transaction>(tx),
                    10_000,
                  );
                  await tree.setParent(tx, firstParent, firstChild);
                }),
              );
              await observeBlocked(observer, secondPid, firstPid);
              release.resolve(undefined);

              const [firstError, secondError] = await Promise.all([
                firstMove,
                secondMove,
              ]);
              const parents = await tree.parents(observer, scope);
              if (outcome === "commit") {
                expect(firstError).toBeUndefined();
                expectGuardRefusal(secondError, treeName);
                expect(parents).toEqual(
                  new Map([
                    [firstChild, firstParent],
                    [firstParent, null],
                  ]),
                );
              } else {
                expect(firstError).toBeInstanceOf(TransactionRollbackError);
                expect(secondError).toBeUndefined();
                expect(parents).toEqual(
                  new Map([
                    [firstChild, null],
                    [firstParent, firstChild],
                  ]),
                );
              }
              expectAcyclic(parents);
            } finally {
              release.resolve(undefined);
              await dropScope(observer, scope);
            }
          });
        }, 30_000);
      }
    });
  }

  /**
   * The category handlers behind REST and MCP. With the tree lock the second
   * request waits, then its pre-check reads the first one's move. With the
   * lock taken out of the handler, both pre-checks pass and only the trigger
   * stands between them; its refusal must reach the caller as the same 400.
   */
  const dialect = new PgDialect();
  const textOf = (query: SQLWrapper | string) =>
    typeof query === "string" ? query : dialect.sqlToQuery(query.getSQL()).sql;

  type Instrument = {
    omitTreeLock: boolean;
    afterCycleCheck?: () => Promise<void>;
  };

  const instrumented = (tx: Transaction, instrument: Instrument) =>
    new Proxy(tx, {
      get(target, key, receiver) {
        if (key !== "execute") {
          return Reflect.get(target, key, receiver);
        }
        return async (query: SQLWrapper | string) => {
          const text = textOf(query);
          if (
            instrument.omitTreeLock &&
            text.includes("pg_advisory_xact_lock")
          ) {
            return await target.execute(sql`SELECT 1`);
          }
          const result = await target.execute(query);
          if (text.includes("WITH RECURSIVE")) {
            await instrument.afterCycleCheck?.();
          }
          return result;
        };
      },
    });

  const scopedOn =
    (db: GatedTestDb, instrument: Instrument): ScopedDb =>
    async (run) =>
      await db.transaction(async (tx) => {
        const raw = asTestRaw<Transaction>(tx);
        await setSharedLockTimeout(raw, 10_000);
        return await run(instrumented(raw, instrument));
      });

  type Outcome = { ok: boolean; status?: number; code?: string | undefined };

  const HANDLERS = {
    clauseCategories: async (
      db: GatedTestDb,
      instrument: Instrument,
      scope: Scope,
      categoryId: string,
      parentId: string,
    ): Promise<Outcome> => {
      const result = await Result.gen(async function* () {
        return yield* updateCategoryHandler({
          safeDb: safeDbFromScoped(scopedOn(db, instrument)),
          organizationId: scope.organizationId,
          categoryId: toSafeId<"clauseCategory">(categoryId),
          body: { parentId: toSafeId<"clauseCategory">(parentId) },
          recordAuditEvent: async () => undefined,
        });
      });
      if (result.isOk()) {
        return { ok: true };
      }
      if (!HandlerError.is(result.error)) {
        return panic("Expected a handler error", result.error);
      }
      return {
        ok: false,
        status: result.error.status,
        code: result.error.code,
      };
    },
    templateCategories: async (
      db: GatedTestDb,
      instrument: Instrument,
      scope: Scope,
      categoryId: string,
      parentId: string,
    ): Promise<Outcome> => {
      const result = (
        await updateTemplateCategoryHandler({
          scopedDb: scopedOn(db, instrument),
          organizationId: scope.organizationId,
          categoryId: toSafeId<"templateCategory">(categoryId),
          body: { parentId: toSafeId<"templateCategory">(parentId) },
          recordAuditEvent: async () => undefined,
        })
      ).unwrap();
      if ("id" in result) {
        return { ok: true };
      }
      const response: unknown = result.response;
      return {
        ok: false,
        status: result.code,
        ...(typeof response === "object" &&
        response !== null &&
        "code" in response &&
        typeof response.code === "string"
          ? { code: response.code }
          : {}),
      };
    },
  } as const;

  for (const handlerTree of [
    "clauseCategories",
    "templateCategories",
  ] as const) {
    const runHandler = HANDLERS[handlerTree];
    const tree = TREES[handlerTree];
    describe(`${handlerTree} update handler under concurrent opposite moves`, () => {
      for (const lockMode of ["take", "omit"] as const) {
        test(`${lockMode === "take" ? "with the tree lock the second request" : "without the handler's lock the trigger"} refuses the loop with the typed 400`, async () => {
          await withGatedTestClients(databaseUrl, async ({ openClient }) => {
            const firstDb = openClient().db;
            const secondDb = openClient().db;
            const observer = openClient().db;
            const scope = await createScope(observer);
            const { a, b } = ids();
            const checked = Promise.withResolvers<undefined>();
            const release = Promise.withResolvers<undefined>();
            try {
              await tree.insert(observer, scope, [
                { id: a, parentId: null },
                { id: b, parentId: null },
              ]);
              const firstPid = await backendPid(firstDb);
              const secondPid = await backendPid(secondDb);
              const omitTreeLock = lockMode === "omit";

              const first = runHandler(
                firstDb,
                {
                  omitTreeLock,
                  afterCycleCheck: async () => {
                    checked.resolve(undefined);
                    await release.promise;
                  },
                },
                scope,
                a,
                b,
              );
              await Promise.race([
                checked.promise,
                first.then(() =>
                  panic("First move finished before its cycle check"),
                ),
              ]);

              const second = runHandler(
                secondDb,
                { omitTreeLock },
                scope,
                b,
                a,
              );
              let firstOutcome: Outcome;
              let secondOutcome: Outcome;
              if (lockMode === "take") {
                // The second request waits on the lock the first one holds,
                // and reads the tree only after the first commits.
                await observeBlocked(observer, secondPid, firstPid);
                release.resolve(undefined);
                [firstOutcome, secondOutcome] = await Promise.all([
                  first,
                  second,
                ]);
                expect(firstOutcome).toEqual({ ok: true });
                expect(secondOutcome).toEqual({
                  ok: false,
                  status: 400,
                  code: TREE_PARENT_CYCLE_ERROR_CODE,
                });
              } else {
                // Nothing in the handler waits: the second move commits while
                // the first sits between its passed cycle check and its
                // write. Only the trigger can refuse the first one now.
                secondOutcome = await second;
                expect(secondOutcome).toEqual({ ok: true });
                release.resolve(undefined);
                firstOutcome = await first;
                expect(firstOutcome).toEqual({
                  ok: false,
                  status: 400,
                  code: TREE_PARENT_CYCLE_ERROR_CODE,
                });
              }
              expectAcyclic(await tree.parents(observer, scope));
            } finally {
              release.resolve(undefined);
              await dropScope(observer, scope);
            }
          });
        }, 30_000);
      }
    });
  }
}
