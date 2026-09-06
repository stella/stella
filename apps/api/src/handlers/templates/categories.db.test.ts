import { Panic } from "better-result";
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { eq, sql } from "drizzle-orm";

import { organization } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import { templateCategories } from "@/api/db/schema";
import { updateTemplateCategoryHandler } from "@/api/handlers/templates/categories";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { createSafeId, toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
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
  await updateTemplateCategoryHandler({
    scopedDb,
    organizationId,
    categoryId,
    body: { parentId },
    recordAuditEvent: noAuditRows,
  });

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
  // A stored cycle is a state this endpoint cannot create; the FK allows it and
  // a repair could leave one behind. The walk has to end and say so.
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
    await tx
      .update(templateCategories)
      .set({ parentId: loopedB })
      .where(eq(templateCategories.id, loopedA));
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

  let thrown: unknown;
  try {
    await updateTemplateCategoryHandler({
      scopedDb: brokenExecute,
      organizationId,
      categoryId: root,
      body: { parentId: middle },
      recordAuditEvent: noAuditRows,
    });
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBeInstanceOf(Panic);
  expect(await parentOf(root)).toBeNull();
});

test("another firm's category is not reachable from this firm's walk", async () => {
  const result = await updateTemplateCategoryHandler({
    scopedDb,
    organizationId,
    categoryId: sibling,
    body: { parentId: foreign },
    recordAuditEvent: noAuditRows,
  });

  expect(result).toMatchObject({
    code: 404,
    response: { message: "Parent category not found" },
  });
});
