import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, inArray, sql } from "drizzle-orm";

import { organization, user } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import { entities, entityVersions, workspaces } from "@/api/db/schema";
import { createSafeId, toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { lookupByVerificationCode } from "@/api/lib/entity-versions/document-reference-lookup";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type {
  TestDatabase,
  TestDatabaseTransaction,
} from "@/api/tests/security/test-utils";

/**
 * A stamp is frozen onto the version it was printed on and never rewritten, so
 * a document that is moved to another matter, or whose matter is
 * re-referenced, carries a reference its older files do not name. Which
 * reference the document shows now can only come from the row the entity
 * points at, which is why this is a database test rather than a unit one.
 */

let testDb: TestDatabase;
const organizationId = toSafeId<"organization">(`org_${Bun.randomUUIDv7()}`);
const userId = toSafeId<"user">(`user_${Bun.randomUUIDv7()}`);
const workspaceId = createSafeId<"workspace">();

type SeededVersion = {
  versionNumber: number;
  stamp: string | null;
  verificationCode: string | null;
};

/** The random tail of a v7 uuid: its head is a timestamp two codes can share. */
const testVerificationCode = () =>
  Bun.randomUUIDv7().replaceAll("-", "").slice(-10);

type SeedDocumentOptions = {
  name: string;
  docSequence: number;
  versions: readonly SeededVersion[];
};

/** A document whose last version is the one the entity points at. */
const seedDocument = async ({
  name,
  docSequence,
  versions,
}: SeedDocumentOptions): Promise<SafeId<"entity">> => {
  const entityId = createSafeId<"entity">();
  const rows = versions.map((version) => ({
    ...version,
    id: createSafeId<"entityVersion">(),
    workspaceId,
    entityId,
  }));

  await testDb.transaction(async (tx: TestDatabaseTransaction) => {
    await tx.execute(sql.raw("RESET ROLE"));
    await tx.insert(entities).values({
      id: entityId,
      workspaceId,
      kind: "document",
      name,
      createdBy: userId,
      docSequence,
    });
    await tx.insert(entityVersions).values(rows);
    await tx
      .update(entities)
      .set({ currentVersionId: rows.at(-1)?.id })
      .where(eq(entities.id, entityId));
  });

  return entityId;
};

const lookUpCode = async (verificationCode: string) =>
  await testDb.transaction(async (tx: TestDatabaseTransaction) => {
    await tx.execute(sql.raw("RESET ROLE"));
    return await lookupByVerificationCode({
      tx: asTestRaw<Transaction>(tx),
      organizationId,
      verificationCode,
    });
  });

beforeAll(
  async () => {
    testDb = await getTestDb();
    await testDb.transaction(async (tx: TestDatabaseTransaction) => {
      await tx.execute(sql.raw("RESET ROLE"));
      await tx.insert(organization).values({
        id: organizationId,
        name: "Document reference matter",
        slug: `document-reference-${Bun.randomUUIDv7()}`,
        createdAt: new Date(),
      });
      await tx.insert(user).values({
        id: userId,
        name: "Document Reference User",
        email: `${userId}@example.test`,
      });
      await tx.insert(workspaces).values({
        id: workspaceId,
        organizationId,
        name: "Document reference matter",
        reference: Bun.randomUUIDv7().slice(0, 8),
      });
    });
  },
  { timeout: 60_000 },
);

afterAll(async () => {
  await testDb
    .delete(organization)
    .where(inArray(organization.id, [organizationId]));
  await releaseTestDb();
});

test("a code printed before a refiling reports the reference the document carries now", async () => {
  const printedCode = testVerificationCode();
  const entityId = await seedDocument({
    name: "Share purchase agreement.docx",
    docSequence: 15,
    versions: [
      {
        versionNumber: 1,
        stamp: "2026/001/015.v1",
        verificationCode: printedCode,
      },
      {
        versionNumber: 2,
        stamp: "2026/007/003.v2",
        verificationCode: testVerificationCode(),
      },
    ],
  });

  expect(await lookUpCode(printedCode)).toMatchObject({
    entityId,
    stamp: "2026/001/015.v1",
    versionNumber: 1,
    currentVersionNumber: 2,
    currentStamp: "2026/007/003.v2",
  });
});

// The control: without it, "the current stamp differs" would also pass on a
// lookup that reports the matched version's own stamp back.
test("a document that was never refiled reports the reference it was stamped with", async () => {
  const printedCode = testVerificationCode();
  await seedDocument({
    name: "Engagement letter.docx",
    docSequence: 16,
    versions: [
      {
        versionNumber: 1,
        stamp: "2026/001/016.v1",
        verificationCode: printedCode,
      },
      {
        versionNumber: 2,
        stamp: "2026/001/016.v2",
        verificationCode: testVerificationCode(),
      },
    ],
  });

  expect(await lookUpCode(printedCode)).toMatchObject({
    stamp: "2026/001/016.v1",
    currentVersionNumber: 2,
    currentStamp: "2026/001/016.v2",
  });
});

test("a current version carrying no reference reports none", async () => {
  const printedCode = testVerificationCode();
  await seedDocument({
    name: "Statement of claim.docx",
    docSequence: 17,
    versions: [
      {
        versionNumber: 1,
        stamp: "2026/001/017.v1",
        verificationCode: printedCode,
      },
      { versionNumber: 2, stamp: null, verificationCode: null },
    ],
  });

  expect(await lookUpCode(printedCode)).toMatchObject({
    stamp: "2026/001/017.v1",
    currentStamp: null,
  });
});
