import { Result } from "better-result";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, inArray, sql } from "drizzle-orm";

import { organization, user } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import { transactionAbortError } from "@/api/db/safe-db";
import {
  entities,
  entityVersions,
  fields,
  properties,
  searchProjectionRepairQueue,
  workspaces,
} from "@/api/db/schema";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type {
  TestDatabase,
  TestDatabaseTransaction,
} from "@/api/tests/security/test-utils";

import { copyEntities } from "./copy-utils";
import type { WritableEntitySnapshot } from "./copy-utils";

/**
 * `copyEntities` runs inside its caller's transaction, so how it reports a
 * rejection decides what survives it: returning a failure commits every row
 * written before the rejection, throwing aborts the transaction. Only a real
 * transaction can tell the two apart, which is what this suite is for — a
 * subtree that fails on its third entity must leave nothing behind, because
 * the caller then deletes the storage objects those rows would point at.
 */

let testDb: TestDatabase;
const seededOrganizationIds: SafeId<"organization">[] = [];

beforeAll(
  async () => {
    testDb = await getTestDb();
  },
  { timeout: 30_000 },
);

afterAll(async () => {
  if (seededOrganizationIds.length > 0) {
    await testDb
      .delete(organization)
      .where(inArray(organization.id, seededOrganizationIds));
  }
  await releaseTestDb();
});

type SeededMatter = {
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  workspaceId: SafeId<"workspace">;
  propertyId: SafeId<"property">;
};

const seedMatter = async (): Promise<SeededMatter> => {
  const organizationId = toSafeId<"organization">(`org_${Bun.randomUUIDv7()}`);
  const userId = toSafeId<"user">(`user_${Bun.randomUUIDv7()}`);
  const workspaceId = toSafeId<"workspace">(Bun.randomUUIDv7());
  const propertyId = toSafeId<"property">(Bun.randomUUIDv7());

  await testDb.transaction(async (tx: TestDatabaseTransaction) => {
    await tx.execute(sql.raw("RESET ROLE"));
    await tx.insert(organization).values({
      id: organizationId,
      name: "Copy abort matter",
      slug: `copy-abort-${Bun.randomUUIDv7()}`,
      createdAt: new Date(),
    });
    await tx.insert(user).values({
      id: userId,
      name: "Copy Abort User",
      email: `${userId}@example.test`,
    });
    await tx.insert(workspaces).values({
      id: workspaceId,
      organizationId,
      name: "Copy abort matter",
      reference: Bun.randomUUIDv7().slice(0, 8),
    });
    await tx.insert(properties).values({
      id: propertyId,
      workspaceId,
      name: "Summary",
      content: { type: "text", version: 1 },
      tool: { type: "manual-input", version: 1 },
      status: "fresh",
    });
  });

  seededOrganizationIds.push(organizationId);
  return { organizationId, propertyId, userId, workspaceId };
};

const rootId = toSafeId<"entity">("source_root_folder");
const documentId = toSafeId<"entity">("source_document");
const lastId = toSafeId<"entity">("source_last_document");

/**
 * A three-entity subtree in copy order. `lastVersion: null` is the mid-loop
 * rejection: the root and the document are already written when the third
 * entity turns out to have no current version.
 */
const subtree = ({
  propertyId,
  lastVersion,
}: {
  propertyId: SafeId<"property">;
  lastVersion: WritableEntitySnapshot["currentVersion"];
}): WritableEntitySnapshot[] => [
  {
    id: rootId,
    kind: "folder",
    name: "Pleadings",
    parentId: null,
    currentVersion: { fields: [] },
  },
  {
    id: documentId,
    kind: "document",
    name: "Statement of claim.docx",
    parentId: rootId,
    currentVersion: {
      fields: [
        {
          propertyId,
          content: { version: 1, type: "text", value: "Filed 2026-01-08" },
        },
      ],
    },
  },
  {
    id: lastId,
    kind: "document",
    name: "Exhibit A.docx",
    parentId: rootId,
    currentVersion: lastVersion,
  },
];

const noAuditRows: AuditRecorder = async () => undefined;

const runCopy = async (
  matter: SeededMatter,
  sources: WritableEntitySnapshot[],
) =>
  await Result.tryPromise(
    async () =>
      await testDb.transaction(async (tx: TestDatabaseTransaction) => {
        await tx.execute(sql.raw("RESET ROLE"));
        return await copyEntities({
          tx: asTestRaw<Transaction>(tx),
          targetWorkspaceId: matter.workspaceId,
          targetParentId: null,
          userId: matter.userId,
          recordAuditEvent: noAuditRows,
          sourceEntityId: rootId,
          sourceEntities: sources,
          deleteSource: false,
        });
      }),
  );

const persistedCounts = async (matter: SeededMatter) => ({
  entities: await testDb.$count(
    entities,
    eq(entities.workspaceId, matter.workspaceId),
  ),
  entityVersions: await testDb.$count(
    entityVersions,
    eq(entityVersions.workspaceId, matter.workspaceId),
  ),
  fields: await testDb.$count(
    fields,
    eq(fields.workspaceId, matter.workspaceId),
  ),
  searchMarks: await testDb.$count(
    searchProjectionRepairQueue,
    eq(searchProjectionRepairQueue.organizationId, matter.organizationId),
  ),
});

// The control: without it, "nothing was written" would also pass on a copy
// that writes nothing at all.
test("a complete subtree commits every copied row", async () => {
  const matter = await seedMatter();

  const outcome = await runCopy(
    matter,
    subtree({ propertyId: matter.propertyId, lastVersion: { fields: [] } }),
  );

  expect(Result.isOk(outcome)).toBe(true);
  expect(await persistedCounts(matter)).toEqual({
    entities: 3,
    entityVersions: 3,
    fields: 1,
    searchMarks: 3,
  });
});

test("a subtree that fails mid-loop persists no copy at all", async () => {
  const matter = await seedMatter();

  const outcome = await runCopy(
    matter,
    subtree({ propertyId: matter.propertyId, lastVersion: null }),
  );

  expect(Result.isError(outcome)).toBe(true);
  if (!Result.isError(outcome)) {
    throw new TypeError("Expected the copy transaction to abort");
  }

  // The rejection the handlers answer with is unchanged by the abort: it
  // reaches them as the same 400 it always was.
  const abort = transactionAbortError(outcome.error);
  expect(HandlerError.is(abort)).toBe(true);
  if (!HandlerError.is(abort)) {
    throw new Error("Expected a HandlerError to abort the copy transaction");
  }
  expect(abort.status).toBe(400);
  expect(abort.message).toBe("Entity has no current version");

  // The two entities written before the rejection are gone with it, and so
  // are their versions, fields, and search marks.
  expect(await persistedCounts(matter)).toEqual({
    entities: 0,
    entityVersions: 0,
    fields: 0,
    searchMarks: 0,
  });
});
