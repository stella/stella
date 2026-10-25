import { panic, Result } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { asc, eq, inArray } from "drizzle-orm";

import { organization, user } from "@/api/db/auth-schema";
import type { SafeDb } from "@/api/db/safe-db";
import { entities, entityVersions, workspaces } from "@/api/db/schema";
import { createSafeDb } from "@/api/db/scoped";
import { AUDIT_ACTION } from "@/api/lib/audit-log";
import type { AuditEvent } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { TREE_PARENT_CYCLE_ERROR_CODE } from "@/api/lib/db/tree-parent-guard";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

import { createFolderFromSelectionHandler } from "./create";
import type { CreateFolderFromSelectionHandlerProps } from "./create";

let db: TestDatabase;
const orgIds: SafeId<"organization">[] = [];
const userIds: SafeId<"user">[] = [];

// timeout: Boot the shared PGlite engine and complete schema before assertions.
beforeAll(
  async () => {
    db = await getTestDb();
  },
  { timeout: 30_000 },
);

afterAll(async () => {
  if (orgIds.length > 0) {
    await db.delete(organization).where(inArray(organization.id, orgIds));
  }
  if (userIds.length > 0) {
    await db.delete(user).where(inArray(user.id, userIds));
  }
  await releaseTestDb();
});

/**
 * Matter layout:
 *   outer/            (folder)
 *     inner/          (folder, the usual target parent)
 *       a.docx
 *       b.docx
 *       locked.docx   (read-only)
 *   loose/            (folder at the root)
 *     nested.docx
 * plus foreign.docx in a second matter of the same organization.
 */
const seedMatter = async () => {
  const organizationId = mintAuthProviderId<"organization">();
  const userId = mintAuthProviderId<"user">();
  const workspaceId = createSafeId<"workspace">();
  const otherWorkspaceId = createSafeId<"workspace">();
  const ids = {
    outer: createSafeId<"entity">(),
    inner: createSafeId<"entity">(),
    a: createSafeId<"entity">(),
    b: createSafeId<"entity">(),
    locked: createSafeId<"entity">(),
    loose: createSafeId<"entity">(),
    nested: createSafeId<"entity">(),
    foreign: createSafeId<"entity">(),
  };
  await db.insert(organization).values({
    id: organizationId,
    name: "Folder from selection",
    slug: organizationId,
    createdAt: new Date(),
  });
  orgIds.push(organizationId);
  await db.insert(user).values({
    id: userId,
    name: "Folder from selection user",
    email: `${userId}@example.test`,
  });
  userIds.push(userId);
  await db.insert(workspaces).values([
    { id: workspaceId, organizationId, name: "Matter", reference: "M" },
    { id: otherWorkspaceId, organizationId, name: "Other", reference: "O" },
  ]);
  await db.insert(entities).values([
    { id: ids.outer, workspaceId, kind: "folder", name: "outer" },
    { id: ids.loose, workspaceId, kind: "folder", name: "loose" },
    {
      id: ids.foreign,
      workspaceId: otherWorkspaceId,
      kind: "document",
      name: "foreign.docx",
    },
  ]);
  await db.insert(entities).values([
    {
      id: ids.inner,
      workspaceId,
      kind: "folder",
      name: "inner",
      parentId: ids.outer,
    },
    {
      id: ids.nested,
      workspaceId,
      kind: "document",
      name: "nested.docx",
      parentId: ids.loose,
    },
  ]);
  await db.insert(entities).values([
    {
      id: ids.a,
      workspaceId,
      kind: "document",
      name: "a.docx",
      parentId: ids.inner,
    },
    {
      id: ids.b,
      workspaceId,
      kind: "document",
      name: "b.docx",
      parentId: ids.inner,
    },
    {
      id: ids.locked,
      workspaceId,
      kind: "document",
      name: "locked.docx",
      parentId: ids.inner,
      readOnly: true,
    },
  ]);
  // Both matters are in scope, so a refused foreign id proves the handler's
  // own matter predicate rather than row-level security.
  const safeDb = asTestRaw<SafeDb>(
    createSafeDb(db, [workspaceId, otherWorkspaceId], organizationId, userId),
  );
  return { ids, safeDb, userId, workspaceId };
};

type Seeded = Awaited<ReturnType<typeof seedMatter>>;

const run = async (
  seeded: Seeded,
  body: CreateFolderFromSelectionHandlerProps["body"],
) => {
  const audit: AuditEvent[] = [];
  const result = await Result.gen(() =>
    createFolderFromSelectionHandler({
      safeDb: seeded.safeDb,
      workspaceId: seeded.workspaceId,
      userId: seeded.userId,
      recordAuditEvent: (_tx, event) => {
        audit.push(...[event].flat());
      },
      body,
      flushSearchRepairs: async () => ({ failed: 0, repaired: 0 }),
      syncSearchActivity: async () => undefined,
    }),
  );
  return { audit, result };
};

const readMatter = async (workspaceId: SafeId<"workspace">) =>
  await db
    .select({
      id: entities.id,
      kind: entities.kind,
      name: entities.name,
      parentId: entities.parentId,
      updatedAt: entities.updatedAt,
    })
    .from(entities)
    .where(eq(entities.workspaceId, workspaceId))
    .orderBy(asc(entities.id));

const expectRefusal = (
  outcome: Awaited<ReturnType<typeof run>>,
  expected: { status: number; message: string; code?: string },
) => {
  if (outcome.result.isOk()) {
    panic("Expected the request to be refused");
  }
  expect(HandlerError.is(outcome.result.error)).toBe(true);
  expect(outcome.result.error).toMatchObject(expected);
};

describe("creating a folder from a selection", () => {
  test("creates the folder under the parent and moves every selected entity into it", async () => {
    const seeded = await seedMatter();
    const { ids } = seeded;

    const outcome = await run(seeded, {
      name: "  Bundle  ",
      parentId: ids.inner,
      entityIds: [ids.a, ids.b, ids.loose, ids.a],
    });

    if (outcome.result.isErr()) {
      panic(`Expected success, got ${outcome.result.error.message}`);
    }
    const folderId = outcome.result.value.entityId;
    const matter = new Map(
      (await readMatter(seeded.workspaceId)).map((row) => [row.id, row]),
    );
    expect(matter.get(folderId)).toMatchObject({
      kind: "folder",
      name: "Bundle",
      parentId: ids.inner,
    });
    for (const moved of [ids.a, ids.b, ids.loose]) {
      expect(matter.get(moved)?.parentId).toBe(folderId);
    }
    // A moved folder keeps its own subtree; unselected siblings stay put.
    expect(matter.get(ids.nested)?.parentId).toBe(ids.loose);
    expect(matter.get(ids.locked)?.parentId).toBe(ids.inner);

    const folderRow = await db.query.entities.findFirst({
      where: { id: { eq: folderId } },
      columns: { currentVersionId: true },
    });
    const versions = await db
      .select({
        id: entityVersions.id,
        versionNumber: entityVersions.versionNumber,
      })
      .from(entityVersions)
      .where(eq(entityVersions.entityId, folderId));
    expect(versions).toEqual([
      {
        id: folderRow?.currentVersionId ?? panic("Folder row missing"),
        versionNumber: 1,
      },
    ]);

    expect(
      outcome.audit.map(({ action, resourceId, changes }) => ({
        action,
        resourceId,
        changes,
      })),
    ).toEqual([
      {
        action: AUDIT_ACTION.CREATE,
        resourceId: folderId,
        changes: {
          created: {
            old: null,
            new: { kind: "folder", name: "Bundle", parentId: ids.inner },
          },
        },
      },
      ...[
        { id: ids.a, old: ids.inner },
        { id: ids.b, old: ids.inner },
        { id: ids.loose, old: null },
      ]
        // Postgres orders uuids as their lowercase hex text.
        .toSorted((left, right) => (left.id < right.id ? -1 : 1))
        .map(({ id, old }) => ({
          action: AUDIT_ACTION.UPDATE,
          resourceId: id,
          changes: { parentId: { old, new: folderId } },
        })),
    ]);
  });

  test("a read-only entity in the selection refuses the whole request", async () => {
    const seeded = await seedMatter();
    const { ids } = seeded;
    const before = await readMatter(seeded.workspaceId);

    const outcome = await run(seeded, {
      name: "Bundle",
      parentId: ids.inner,
      entityIds: [ids.a, ids.locked],
    });

    expectRefusal(outcome, { status: 409, message: "Entity is read-only" });
    expect(await readMatter(seeded.workspaceId)).toEqual(before);
  });

  test("a selected folder that contains the parent refuses the whole request", async () => {
    const seeded = await seedMatter();
    const { ids } = seeded;
    const before = await readMatter(seeded.workspaceId);

    const outcome = await run(seeded, {
      name: "Bundle",
      parentId: ids.inner,
      entityIds: [ids.a, ids.outer],
    });

    expectRefusal(outcome, {
      status: 400,
      code: TREE_PARENT_CYCLE_ERROR_CODE,
      message: "Cannot move a folder into one of its descendants",
    });
    expect(await readMatter(seeded.workspaceId)).toEqual(before);
  });

  test("an entity from another matter is not found and nothing is created", async () => {
    const seeded = await seedMatter();
    const { ids } = seeded;
    const before = await readMatter(seeded.workspaceId);

    const outcome = await run(seeded, {
      name: "Bundle",
      parentId: null,
      entityIds: [ids.a, ids.foreign],
    });

    expectRefusal(outcome, { status: 404, message: "Entity not found" });
    expect(await readMatter(seeded.workspaceId)).toEqual(before);
  });
});
