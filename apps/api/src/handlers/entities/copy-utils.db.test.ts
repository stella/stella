import { Result } from "better-result";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, inArray, sql } from "drizzle-orm";

import { organization, user } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import { transactionAbortError } from "@/api/db/safe-db";
import {
  documentProcessingRuns,
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
import { lookupByVerificationCode } from "@/api/lib/entity-versions/document-reference-lookup";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { allocateFileObject } from "@/api/lib/files/file-object-ids";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type {
  TestDatabase,
  TestDatabaseTransaction,
} from "@/api/tests/security/test-utils";

import { copyEntities } from "./copy-utils";
import type {
  WritableEntitySnapshot,
  WritableEntityVersionSnapshot,
} from "./copy-utils";

/**
 * `copyEntities` runs inside its caller's transaction, so how it reports a
 * rejection decides what survives it: returning a failure commits every row
 * written before the rejection, throwing aborts the transaction. Only a real
 * transaction can tell the two apart, which is what this suite is for — a
 * subtree that fails on its third entity must leave nothing behind, because
 * the caller then deletes the storage objects those rows would point at.
 *
 * The same goes for what a move does to a printed verification code: the
 * globally unique index is the whole reason the code moves off the source row
 * before the target takes it, and no mock can enforce that index.
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
      content: { type: "file", version: 1 },
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

type VersionFixture = {
  id: string;
  versionNumber?: number;
  stamp?: string | null;
  label?: string | null;
  description?: string | null;
  createdAt?: Date;
  fields?: WritableEntityVersionSnapshot["fields"];
};

/** A version snapshot with the carried columns a caller does not pin. */
const version = ({
  id,
  versionNumber = 1,
  stamp = null,
  label = null,
  description = null,
  createdAt = new Date("2026-01-01T00:00:00.000Z"),
  fields: versionFields = [],
}: VersionFixture): WritableEntityVersionSnapshot => ({
  id: toSafeId<"entityVersion">(id),
  versionNumber,
  stamp,
  label,
  description,
  diffWordsAdded: null,
  diffWordsRemoved: null,
  createdBy: null,
  source: null,
  collaborationContributorUserIds: null,
  detectedLanguage: null,
  createdAt,
  fields: versionFields,
});

const fileField = ({
  id,
  propertyId,
  fileName,
}: {
  id: string;
  propertyId: SafeId<"property">;
  fileName: string;
}): WritableEntityVersionSnapshot["fields"][number] => ({
  id: toSafeId<"field">(id),
  propertyId,
  content: {
    type: "file",
    version: 1,
    id: allocateFileObject(),
    fileName,
    mimeType:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    sizeBytes: 1024,
    encrypted: false,
    sha256Hex: "a".repeat(64),
    pdfFileId: null,
  },
});

/**
 * A three-entity subtree in copy order. `lastVersions: []` is the mid-loop
 * rejection: the root and the document are already written when the third
 * entity turns out to have no current version.
 */
const subtree = ({
  propertyId,
  lastVersions,
}: {
  propertyId: SafeId<"property">;
  lastVersions: WritableEntitySnapshot["versions"];
}): WritableEntitySnapshot[] => [
  {
    id: rootId,
    kind: "folder",
    name: "Pleadings",
    parentId: null,
    currentVersionId: toSafeId<"entityVersion">("version_root"),
    versions: [version({ id: "version_root" })],
  },
  {
    id: documentId,
    kind: "document",
    name: "Statement of claim.docx",
    parentId: rootId,
    currentVersionId: toSafeId<"entityVersion">("version_document"),
    versions: [
      version({
        id: "version_document",
        fields: [
          fileField({
            id: "field_source_document",
            propertyId,
            fileName: "Statement of claim.docx",
          }),
        ],
      }),
    ],
  },
  {
    id: lastId,
    kind: "document",
    name: "Exhibit A.docx",
    parentId: rootId,
    currentVersionId: lastVersions.at(0)?.id ?? null,
    versions: lastVersions,
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
          organizationId: matter.organizationId,
          tx: asTestRaw<Transaction>(tx),
          targetWorkspaceId: matter.workspaceId,
          targetParentId: null,
          userId: matter.userId,
          recordAuditEvent: noAuditRows,
          sourceEntityId: rootId,
          sourceEntities: sources,
          transfer: { type: "copy" },
          fieldMapping: { type: "omit" },
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
  extractionRuns: await testDb.$count(
    documentProcessingRuns,
    eq(documentProcessingRuns.organizationId, matter.organizationId),
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
    subtree({
      propertyId: matter.propertyId,
      lastVersions: [version({ id: "version_last" })],
    }),
  );

  expect(Result.isOk(outcome)).toBe(true);
  if (!Result.isOk(outcome)) {
    throw new TypeError("Expected the copy transaction to commit");
  }
  const copiedDocument = outcome.value.copiedEntities.find(
    ({ sourceId }) => sourceId === documentId,
  );
  if (!copiedDocument) {
    throw new TypeError("Expected the document copy to persist");
  }
  const runId = outcome.value.nativeExtractionRunIds.at(0);
  if (!runId) {
    throw new TypeError(
      "Expected the copied document to create an extraction run",
    );
  }
  const run = await testDb.query.documentProcessingRuns.findFirst({
    where: { id: { eq: runId } },
  });
  if (!run) {
    throw new TypeError("Expected the extraction run to persist");
  }
  const copiedField = await testDb.query.fields.findFirst({
    where: { id: { eq: run.fieldId } },
  });
  if (!copiedField || copiedField.content.type !== "file") {
    throw new TypeError("Expected the run to reference a copied file field");
  }
  expect(run).toMatchObject({
    entityId: copiedDocument.entityId,
    entityVersionId: copiedField.entityVersionId,
    organizationId: matter.organizationId,
    sourceFileId: copiedField.content.id,
    sourceSha256Hex: copiedField.content.sha256Hex,
    workspaceId: matter.workspaceId,
  });
  expect(await persistedCounts(matter)).toEqual({
    entities: 3,
    entityVersions: 3,
    extractionRuns: 1,
    fields: 1,
    searchMarks: 2,
  });
});

test("a subtree that fails mid-loop persists no copy at all", async () => {
  const matter = await seedMatter();

  const outcome = await runCopy(
    matter,
    subtree({ propertyId: matter.propertyId, lastVersions: [] }),
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
    extractionRuns: 0,
    fields: 0,
    searchMarks: 0,
  });
});

test("rolling back after the copy also removes its extraction runs", async () => {
  const matter = await seedMatter();
  const sources = subtree({
    propertyId: matter.propertyId,
    lastVersions: [version({ id: "version_last" })],
  });

  const outcome = await Result.tryPromise(
    async () =>
      await testDb.transaction(async (tx: TestDatabaseTransaction) => {
        await tx.execute(sql.raw("RESET ROLE"));
        await copyEntities({
          organizationId: matter.organizationId,
          tx: asTestRaw<Transaction>(tx),
          targetWorkspaceId: matter.workspaceId,
          targetParentId: null,
          userId: matter.userId,
          recordAuditEvent: noAuditRows,
          sourceEntityId: rootId,
          sourceEntities: sources,
          transfer: { type: "copy" },
          fieldMapping: { type: "omit" },
        });
        throw new HandlerError({ status: 500, message: "force rollback" });
      }),
  );

  expect(Result.isError(outcome)).toBe(true);
  expect(await persistedCounts(matter)).toEqual({
    entities: 0,
    entityVersions: 0,
    extractionRuns: 0,
    fields: 0,
    searchMarks: 0,
  });
});

/**
 * A second matter in the same organization: documents move between matters,
 * never between organizations.
 */
const seedTargetMatter = async ({
  organizationId,
  userId,
}: SeededMatter): Promise<SeededMatter> => {
  const workspaceId = toSafeId<"workspace">(Bun.randomUUIDv7());
  const propertyId = toSafeId<"property">(Bun.randomUUIDv7());

  await testDb.transaction(async (tx: TestDatabaseTransaction) => {
    await tx.execute(sql.raw("RESET ROLE"));
    await tx.insert(workspaces).values({
      id: workspaceId,
      organizationId,
      name: "Target matter",
      // The tail, not the head: a v7 uuid starts with a timestamp, and two
      // matters in one organization must not share a reference.
      reference: Bun.randomUUIDv7().slice(-8),
    });
    await tx.insert(properties).values({
      id: propertyId,
      workspaceId,
      name: "Summary",
      content: { type: "file", version: 1 },
      tool: { type: "manual-input", version: 1 },
      status: "fresh",
    });
  });

  return { organizationId, propertyId, userId, workspaceId };
};

type SeededVersion = {
  id: SafeId<"entityVersion">;
  versionNumber: number;
  stamp: string | null;
  label: string | null;
  description: string | null;
  verificationCode: string | null;
  createdAt: Date;
};

type SeededDocument = {
  entityId: SafeId<"entity">;
  versions: SeededVersion[];
};

/** The random tail of a v7 uuid: its head is a timestamp two codes can share. */
const testVerificationCode = () =>
  Bun.randomUUIDv7().replaceAll("-", "").slice(-10).toUpperCase();

/** A document whose history is already stamped, coded, labelled and printed. */
const seedDocumentHistory = async (
  matter: SeededMatter,
): Promise<SeededDocument> => {
  const entityId = toSafeId<"entity">(Bun.randomUUIDv7());
  const versions: SeededVersion[] = [
    {
      id: toSafeId<"entityVersion">(Bun.randomUUIDv7()),
      versionNumber: 1,
      stamp: null,
      label: null,
      description: null,
      verificationCode: null,
      createdAt: new Date("2026-02-01T09:00:00.000Z"),
    },
    {
      id: toSafeId<"entityVersion">(Bun.randomUUIDv7()),
      versionNumber: 2,
      stamp: "2026/001/015.v2",
      label: "Internal draft",
      description: "Sent to the client for comments",
      verificationCode: testVerificationCode(),
      createdAt: new Date("2026-02-02T09:00:00.000Z"),
    },
    {
      id: toSafeId<"entityVersion">(Bun.randomUUIDv7()),
      versionNumber: 3,
      stamp: "2026/001/015.v3",
      label: "Final version",
      description: "Signed",
      verificationCode: testVerificationCode(),
      createdAt: new Date("2026-02-03T09:00:00.000Z"),
    },
  ];

  await testDb.transaction(async (tx: TestDatabaseTransaction) => {
    await tx.execute(sql.raw("RESET ROLE"));
    await tx.insert(entities).values({
      id: entityId,
      workspaceId: matter.workspaceId,
      kind: "document",
      name: "Share purchase agreement.docx",
      createdBy: matter.userId,
      docSequence: 15,
    });
    await tx.insert(entityVersions).values(
      versions.map((row) => ({
        ...row,
        workspaceId: matter.workspaceId,
        entityId,
      })),
    );
    await tx
      .update(entities)
      .set({ currentVersionId: versions.at(-1)?.id })
      .where(eq(entities.id, entityId));
  });

  return { entityId, versions };
};

type SeededSnapshotOptions = {
  document: SeededDocument;
  propertyId: SafeId<"property">;
  /** The versions the transfer carries: all of them, or just the current one. */
  carried: SeededVersion[];
};

const seededSnapshot = ({
  document,
  propertyId,
  carried,
}: SeededSnapshotOptions): WritableEntitySnapshot => ({
  id: document.entityId,
  kind: "document",
  name: "Share purchase agreement.docx",
  parentId: null,
  currentVersionId: document.versions.at(-1)?.id ?? null,
  versions: carried.map(
    ({ id, versionNumber, stamp, label, description, createdAt }) =>
      version({
        id,
        versionNumber,
        stamp,
        label,
        description,
        createdAt,
        fields: [
          fileField({
            id: `field_${id}`,
            propertyId,
            fileName: `Share purchase agreement v${String(versionNumber)}.docx`,
          }),
        ],
      }),
  ),
});

const lookUpCode = async (
  organizationId: SafeId<"organization">,
  verificationCode: string,
) =>
  await testDb.transaction(async (tx: TestDatabaseTransaction) => {
    await tx.execute(sql.raw("RESET ROLE"));
    return await lookupByVerificationCode({
      tx: asTestRaw<Transaction>(tx),
      organizationId,
      verificationCode,
    });
  });

test("a move carries every version with its frozen stamp and verification code", async () => {
  const sourceMatter = await seedMatter();
  const targetMatter = await seedTargetMatter(sourceMatter);
  const document = await seedDocumentHistory(sourceMatter);

  const outcome = await Result.tryPromise(
    async () =>
      await testDb.transaction(async (tx: TestDatabaseTransaction) => {
        await tx.execute(sql.raw("RESET ROLE"));
        const result = await copyEntities({
          organizationId: sourceMatter.organizationId,
          tx: asTestRaw<Transaction>(tx),
          targetWorkspaceId: targetMatter.workspaceId,
          targetParentId: null,
          userId: sourceMatter.userId,
          recordAuditEvent: noAuditRows,
          sourceEntityId: document.entityId,
          sourceEntities: [
            seededSnapshot({
              document,
              propertyId: targetMatter.propertyId,
              carried: document.versions,
            }),
          ],
          sourceWorkspaceId: sourceMatter.workspaceId,
          transfer: { type: "move" },
          fieldMapping: { type: "omit" },
        });
        // What the handler does next, in the same transaction: the codes must
        // be off the source rows before those rows are gone.
        await tx.delete(entities).where(eq(entities.id, document.entityId));
        return result;
      }),
  );

  if (!Result.isOk(outcome)) {
    throw new TypeError("Expected the move transaction to commit");
  }
  const movedEntityId = outcome.value.entityId;

  const movedVersions = await testDb
    .select({
      versionNumber: entityVersions.versionNumber,
      stamp: entityVersions.stamp,
      label: entityVersions.label,
      description: entityVersions.description,
      verificationCode: entityVersions.verificationCode,
      createdAt: entityVersions.createdAt,
    })
    .from(entityVersions)
    .where(eq(entityVersions.entityId, movedEntityId))
    .orderBy(entityVersions.versionNumber);

  expect(movedVersions).toEqual(
    document.versions.map(({ id: _id, ...carried }) => carried),
  );

  // The document still shows the version it showed before the move.
  const moved = await testDb.query.entities.findFirst({
    where: { id: { eq: movedEntityId } },
    columns: { currentVersionId: true },
    with: { currentVersion: { columns: { versionNumber: true } } },
  });
  expect(moved?.currentVersion?.versionNumber).toBe(3);

  // Every carried version brought its fields, not just the current one.
  expect(
    await testDb.$count(
      fields,
      eq(fields.workspaceId, targetMatter.workspaceId),
    ),
  ).toBe(3);

  // A code printed in a downloaded file still resolves, now to the document
  // in its new matter.
  const secondCode = document.versions.at(1)?.verificationCode ?? "";
  const thirdCode = document.versions.at(2)?.verificationCode ?? "";
  expect(
    await lookUpCode(sourceMatter.organizationId, secondCode),
  ).toMatchObject({
    entityId: movedEntityId,
    versionNumber: 2,
    currentVersionNumber: 3,
    workspaceId: targetMatter.workspaceId,
    stamp: "2026/001/015.v2",
  });
  expect(
    await lookUpCode(sourceMatter.organizationId, thirdCode),
  ).toMatchObject({
    entityId: movedEntityId,
    versionNumber: 3,
    currentVersionNumber: 3,
  });

  // Nothing is left in the matter the document came from.
  expect(
    await testDb.$count(
      entities,
      eq(entities.workspaceId, sourceMatter.workspaceId),
    ),
  ).toBe(0);
  expect(
    await testDb.$count(
      entityVersions,
      eq(entityVersions.workspaceId, sourceMatter.workspaceId),
    ),
  ).toBe(0);
});

test("a copy mints new codes and leaves the source's codes in place", async () => {
  const sourceMatter = await seedMatter();
  const targetMatter = await seedTargetMatter(sourceMatter);
  const document = await seedDocumentHistory(sourceMatter);
  const sourceCurrent = document.versions.at(2);
  if (!sourceCurrent?.verificationCode) {
    throw new TypeError("Expected the seeded current version to carry a code");
  }

  const outcome = await Result.tryPromise(
    async () =>
      await testDb.transaction(async (tx: TestDatabaseTransaction) => {
        await tx.execute(sql.raw("RESET ROLE"));
        return await copyEntities({
          organizationId: sourceMatter.organizationId,
          tx: asTestRaw<Transaction>(tx),
          targetWorkspaceId: targetMatter.workspaceId,
          targetParentId: null,
          userId: sourceMatter.userId,
          recordAuditEvent: noAuditRows,
          sourceEntityId: document.entityId,
          // The copy loader supplies the current version alone.
          sourceEntities: [
            seededSnapshot({
              document,
              propertyId: targetMatter.propertyId,
              carried: [sourceCurrent],
            }),
          ],
          sourceWorkspaceId: sourceMatter.workspaceId,
          transfer: { type: "copy" },
          fieldMapping: { type: "omit" },
        });
      }),
  );

  if (!Result.isOk(outcome)) {
    throw new TypeError("Expected the copy transaction to commit");
  }

  const copied = await testDb
    .select({
      versionNumber: entityVersions.versionNumber,
      stamp: entityVersions.stamp,
      verificationCode: entityVersions.verificationCode,
    })
    .from(entityVersions)
    .where(eq(entityVersions.entityId, outcome.value.entityId));

  const copiedVersion = copied.at(0);
  expect(copied).toHaveLength(1);
  expect(copiedVersion?.versionNumber).toBe(1);
  expect(copiedVersion?.stamp).not.toBe(sourceCurrent.stamp);
  expect(copiedVersion?.verificationCode).toBeString();
  expect(copiedVersion?.verificationCode).not.toBe(
    sourceCurrent.verificationCode,
  );

  // The original is untouched: its printed references still name it.
  expect(
    await lookUpCode(
      sourceMatter.organizationId,
      sourceCurrent.verificationCode,
    ),
  ).toMatchObject({
    entityId: document.entityId,
    versionNumber: 3,
    currentVersionNumber: 3,
  });
});
