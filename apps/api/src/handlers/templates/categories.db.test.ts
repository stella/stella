import { Panic } from "better-result";
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import type { SQLWrapper } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import { organization } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import { templateCategories } from "@/api/db/schema";
import { updateTemplateCategoryHandler } from "@/api/handlers/templates/categories";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { createSafeId, toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import {
  isTreeParentGuardError,
  TREE_PARENT_CYCLE_ERROR_CODE,
  TREE_PARENT_GUARDS,
} from "@/api/lib/db/tree-parent-guard";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

/**
 * Re-parenting a category asks one question of the database: would the move
 * close a loop? A recursive CTE answers it, and hand-assembled recursive SQL is
 * unreviewable until something runs it — a wrong join direction reads as a
 * plausible query and silently answers "no cycle" for every input, which is the
 * failure that lets a firm's category tree become unwalkable.
 *
 * So the fixture builds a real chain, root -> middle -> leaf, and asks for each
 * outcome: a legal move, a move onto a descendant at depth one and at depth
 * two, a chain that already loops, and a read the guard cannot interpret —
 * which has to refuse the move rather than report the permissive answer.
 */

setDefaultTimeout(120_000);

let testDb: TestDatabase;

const organizationId = toSafeId<"organization">(`org_${Bun.randomUUIDv7()}`);
const otherOrganizationId = toSafeId<"organization">(
  `org_${Bun.randomUUIDv7()}`,
);

const root = createSafeId<"templateCategory">();
const middle = createSafeId<"templateCategory">();
const leaf = createSafeId<"templateCategory">();
const sibling = createSafeId<"templateCategory">();
const foreign = createSafeId<"templateCategory">();

const scopedDb: ScopedDb = async (callback) =>
  await testDb.transaction(async (tx) => {
    await tx.execute(sql.raw("RESET ROLE"));
    return await callback(asTestRaw<Transaction>(tx));
  });

const noAuditRows: AuditRecorder = async () => undefined;

const reparent = async (
  categoryId: SafeId<"templateCategory">,
  parentId: SafeId<"templateCategory">,
) =>
  (
    await updateTemplateCategoryHandler({
      scopedDb,
      organizationId,
      categoryId,
      body: { parentId },
      recordAuditEvent: noAuditRows,
    })
  ).unwrap();

const parentOf = async (categoryId: SafeId<"templateCategory">) =>
  (
    await testDb
      .select({ parentId: templateCategories.parentId })
      .from(templateCategories)
      .where(eq(templateCategories.id, categoryId))
      .limit(1)
  ).at(0)?.parentId;

const category = (
  id: SafeId<"templateCategory">,
  name: string,
  parentId: SafeId<"templateCategory"> | null,
  owner: SafeId<"organization"> = organizationId,
) => ({ id, organizationId: owner, name, parentId });

beforeAll(async () => {
  testDb = await getTestDb();

  await testDb.transaction(async (tx) => {
    await tx.execute(sql.raw("RESET ROLE"));
    await tx.insert(organization).values([
      {
        id: organizationId,
        name: "Category firm",
        slug: organizationId,
        createdAt: new Date(),
      },
      {
        id: otherOrganizationId,
        name: "Other firm",
        slug: otherOrganizationId,
        createdAt: new Date(),
      },
    ]);
    await tx
      .insert(templateCategories)
      .values([
        category(root, "Root", null),
        category(middle, "Middle", root),
        category(leaf, "Leaf", middle),
        category(sibling, "Sibling", null),
        category(foreign, "Foreign root", null, otherOrganizationId),
      ]);
  });
});

afterAll(async () => {
  await testDb.transaction(async (tx) => {
    await tx.execute(sql.raw("RESET ROLE"));
    await tx
      .delete(organization)
      .where(eq(organization.id, otherOrganizationId));
    await tx.delete(organization).where(eq(organization.id, organizationId));
  });
  await releaseTestDb();
});

test("a move that closes no loop is applied", async () => {
  const result = await reparent(sibling, leaf);

  expect(result).toMatchObject({ id: sibling, parentId: leaf });
  expect(await parentOf(sibling)).toBe(leaf);
});

test("a move onto a direct child is refused", async () => {
  const result = await reparent(root, middle);

  expect(result).toMatchObject({
    code: 400,
    response: { message: "Cannot create circular category hierarchy" },
  });
  expect(await parentOf(root)).toBeNull();
});

test("a move onto a grandchild is refused, so the walk climbs past one level", async () => {
  const result = await reparent(root, leaf);

  expect(result).toMatchObject({
    code: 400,
    response: { message: "Cannot create circular category hierarchy" },
  });
  expect(await parentOf(root)).toBeNull();
});

test("a chain that already loops is reported rather than walked forever", async () => {
  // A stored cycle is a state neither this endpoint nor the tree trigger can
  // create, but rows written before the trigger existed may hold one. The
  // fixture writes it with the trigger switched off; the walk has to end and
  // say so.
  const loopedA = createSafeId<"templateCategory">();
  const loopedB = createSafeId<"templateCategory">();
  const mover = createSafeId<"templateCategory">();
  await testDb.transaction(async (tx) => {
    await tx.execute(sql.raw("RESET ROLE"));
    await tx
      .insert(templateCategories)
      .values([
        category(loopedA, "Looped A", null),
        category(loopedB, "Looped B", loopedA),
        category(mover, "Mover", null),
      ]);
    await tx.execute(
      sql.raw(
        `ALTER TABLE template_categories DISABLE TRIGGER ${TREE_PARENT_GUARDS.templateCategories.constraint}`,
      ),
    );
    await tx
      .update(templateCategories)
      .set({ parentId: loopedB })
      .where(eq(templateCategories.id, loopedA));
    await tx.execute(
      sql.raw(
        `ALTER TABLE template_categories ENABLE TRIGGER ${TREE_PARENT_GUARDS.templateCategories.constraint}`,
      ),
    );
  });

  const result = await reparent(mover, loopedB);

  expect(result).toMatchObject({
    code: 400,
    response: { message: "Cannot create circular category hierarchy" },
  });
  expect(await parentOf(mover)).toBeNull();
});

// A guard that cannot read its own answer must not report the permissive one.
// Every other read in the handler stays real; only `execute` returns a shape
// the reader does not recognise, which is what a driver change would look like.
test("a cycle check that cannot read its answer refuses rather than allowing", async () => {
  const brokenExecute: ScopedDb = async (callback) =>
    await testDb.transaction(async (tx) => {
      await tx.execute(sql.raw("RESET ROLE"));
      const proxied = new Proxy(tx, {
        get: (target, property) => {
          if (property === "execute") {
            return async () => ({ unexpected: true });
          }
          const value = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      return await callback(asTestRaw<Transaction>(proxied));
    });

  const result = await updateTemplateCategoryHandler({
    scopedDb: brokenExecute,
    organizationId,
    categoryId: root,
    body: { parentId: middle },
    recordAuditEvent: noAuditRows,
  });

  // The transaction fails with the guard's panic as its cause; nothing is written.
  expect(result.isErr()).toBe(true);
  expect(result.isErr() && result.error.cause).toBeInstanceOf(Panic);
  expect(await parentOf(root)).toBeNull();
});

test("another firm's category is not reachable from this firm's walk", async () => {
  const result = (
    await updateTemplateCategoryHandler({
      scopedDb,
      organizationId,
      categoryId: sibling,
      body: { parentId: foreign },
      recordAuditEvent: noAuditRows,
    })
  ).unwrap();

  expect(result).toMatchObject({
    code: 404,
    response: { message: "Parent category not found" },
  });
});

// The pre-check answers from the rows it read; when that answer is stale (a
// writer that skipped the tree lock committed in between), the
// `template_categories_parent_acyclic` trigger is what refuses the loop. Its
// refusal must reach the caller as the pre-check's 400, not as a 500.
test("a loop the pre-check misses is refused by the database with the same 400", async () => {
  const dialect = new PgDialect();
  const staleCycleCheck: ScopedDb = async (callback) =>
    await testDb.transaction(async (tx) => {
      await tx.execute(sql.raw("RESET ROLE"));
      const proxied = new Proxy(tx, {
        get: (target, property) => {
          if (property === "execute") {
            return async (query: SQLWrapper) =>
              dialect
                .sqlToQuery(query.getSQL())
                .sql.includes("WITH RECURSIVE ancestor")
                ? { rows: [{ cycle: false }] }
                : await target.execute(query);
          }
          const value = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      return await callback(asTestRaw<Transaction>(proxied));
    });

  const result = (
    await updateTemplateCategoryHandler({
      scopedDb: staleCycleCheck,
      organizationId,
      categoryId: root,
      body: { parentId: leaf },
      recordAuditEvent: noAuditRows,
    })
  ).unwrap();

  expect(result).toMatchObject({
    code: 400,
    response: {
      code: TREE_PARENT_CYCLE_ERROR_CODE,
      message: "Cannot create circular category hierarchy",
    },
  });
  expect(await parentOf(root)).toBeNull();
});

test("the database refuses a category that names itself as parent, on insert and on update", async () => {
  const selfParent = createSafeId<"templateCategory">();
  const refusals = await Promise.all([
    testDb
      .insert(templateCategories)
      .values(category(selfParent, "Self", selfParent))
      .then(
        () => undefined,
        (error: unknown) => error,
      ),
    testDb
      .update(templateCategories)
      .set({ parentId: sibling })
      .where(eq(templateCategories.id, sibling))
      .then(
        () => undefined,
        (error: unknown) => error,
      ),
  ]);

  for (const refusal of refusals) {
    expect(isTreeParentGuardError(refusal, "templateCategories")).toBe(true);
  }
  expect(await parentOf(selfParent)).toBeUndefined();
});
