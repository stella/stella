import { Result } from "better-result";
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { eq, TransactionRollbackError } from "drizzle-orm";

import type { SafeDb, Transaction } from "@/api/db";
import { organization } from "@/api/db/auth-schema";
import {
  entities,
  entityVersions,
  fields,
  properties,
  workspaces,
} from "@/api/db/schema";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { sanitizeFilename } from "@/api/lib/sanitize-filename";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type {
  TestDatabase,
  TestDatabaseTransaction,
} from "@/api/tests/security/test-utils";

import {
  resolveEntityCreateFileName,
  validateEntityCreate,
} from "./entity-create";

const workspaceId = toSafeId<"workspace">("workspace_upload");
const propertyId = toSafeId<"property">("property_upload");
const parentId = toSafeId<"entity">("entity_folder");
const MARKDOWN_MIME_TYPE = "text/markdown";
const SHA_256_HEX = "a".repeat(64);

let testDb: TestDatabase;

beforeAll(async () => {
  testDb = await getTestDb();
});

afterAll(async () => {
  await releaseTestDb();
});

const fileProperty = {
  id: propertyId,
  content: { type: "file" },
};

const createValidationTx = ({
  parent,
}: {
  parent?: { id: string; kind: string } | null;
}) => ({
  $count: mock(async () => 0),
  query: {
    properties: {
      findFirst: mock(async () => fileProperty),
    },
    entities: {
      findFirst: mock(async () => parent ?? null),
    },
  },
});

const runValidation = async ({
  safeDb,
  parentIdInput,
}: {
  safeDb: SafeDb;
  parentIdInput: typeof parentId | null;
}) =>
  await Result.gen(() =>
    validateEntityCreate({
      safeDb,
      workspaceId,
      propertyId,
      parentId: parentIdInput,
    }),
  );

type RolledBackTxCallback<T> = (tx: TestDatabaseTransaction) => Promise<T>;

const runRolledBack = async <T>(
  callback: RolledBackTxCallback<T>,
): Promise<T> => {
  let value: T | undefined;
  try {
    await testDb.transaction(async (tx) => {
      value = await callback(tx);
      tx.rollback();
    });
  } catch (error) {
    if (error instanceof TransactionRollbackError && value !== undefined) {
      return value;
    }
    throw error;
  }

  if (value === undefined) {
    throw new Error("Rolled-back test transaction did not return a value");
  }
  return value;
};

type SeedFileEntityOptions = {
  tx: TestDatabaseTransaction;
  seededWorkspaceId: SafeId<"workspace">;
  seededPropertyId: SafeId<"property">;
  seededParentId: SafeId<"entity"> | null;
  fileName: string;
};

const seedFileEntity = async ({
  tx,
  seededWorkspaceId,
  seededPropertyId,
  seededParentId,
  fileName,
}: SeedFileEntityOptions) => {
  const entityId = toSafeId<"entity">(Bun.randomUUIDv7());
  const entityVersionId = toSafeId<"entityVersion">(Bun.randomUUIDv7());
  const fieldId = toSafeId<"field">(Bun.randomUUIDv7());

  await tx.insert(entities).values({
    id: entityId,
    workspaceId: seededWorkspaceId,
    parentId: seededParentId,
    name: fileName,
  });
  await tx.insert(entityVersions).values({
    id: entityVersionId,
    workspaceId: seededWorkspaceId,
    entityId,
  });
  await tx
    .update(entities)
    .set({ currentVersionId: entityVersionId })
    .where(eq(entities.id, entityId));
  await tx.insert(fields).values({
    id: fieldId,
    workspaceId: seededWorkspaceId,
    propertyId: seededPropertyId,
    entityVersionId,
    content: {
      type: "file",
      version: 1,
      id: Bun.randomUUIDv7(),
      fileName,
      mimeType: MARKDOWN_MIME_TYPE,
      sizeBytes: 8,
      encrypted: false,
      sha256Hex: SHA_256_HEX,
      pdfFileId: null,
      pdfDerivative: { status: "not-required" },
    },
  });
};

type SeedWorkspaceResult = {
  workspaceId: SafeId<"workspace">;
  propertyId: SafeId<"property">;
  folderAId: SafeId<"entity">;
  folderBId: SafeId<"entity">;
};

const seedWorkspace = async (
  tx: TestDatabaseTransaction,
): Promise<SeedWorkspaceResult> => {
  const organizationId = toSafeId<"organization">(`org_${Bun.randomUUIDv7()}`);
  const seededWorkspaceId = toSafeId<"workspace">(Bun.randomUUIDv7());
  const seededPropertyId = toSafeId<"property">(Bun.randomUUIDv7());
  const folderAId = toSafeId<"entity">(Bun.randomUUIDv7());
  const folderBId = toSafeId<"entity">(Bun.randomUUIDv7());

  await tx.insert(organization).values({
    id: organizationId,
    name: "Upload Conflict Test",
    slug: `upload-conflict-${Bun.randomUUIDv7()}`,
    createdAt: new Date(),
  });
  await tx.insert(workspaces).values({
    id: seededWorkspaceId,
    organizationId,
    name: "Upload conflict matter",
    reference: Bun.randomUUIDv7().slice(0, 8),
  });
  await tx.insert(properties).values({
    id: seededPropertyId,
    workspaceId: seededWorkspaceId,
    name: "File",
    content: { type: "file", version: 1 },
    tool: { type: "manual-input", version: 1 },
    status: "fresh",
  });
  await tx.insert(entities).values([
    {
      id: folderAId,
      workspaceId: seededWorkspaceId,
      kind: "folder",
      name: "Folder A",
    },
    {
      id: folderBId,
      workspaceId: seededWorkspaceId,
      kind: "folder",
      name: "Folder B",
    },
  ]);

  return {
    workspaceId: seededWorkspaceId,
    propertyId: seededPropertyId,
    folderAId,
    folderBId,
  };
};

type ResolveFileNameInTestTxOptions = {
  tx: TestDatabaseTransaction;
  seededWorkspaceId: SafeId<"workspace">;
  seededPropertyId: SafeId<"property">;
  seededParentId: SafeId<"entity"> | null;
  fileName: string;
};

const resolveFileNameInTestTx = async ({
  tx,
  seededWorkspaceId,
  seededPropertyId,
  seededParentId,
  fileName,
}: ResolveFileNameInTestTxOptions) =>
  await resolveEntityCreateFileName({
    // SAFETY: the helper only uses Drizzle query-builder methods shared by
    // the production Bun SQL transaction and the PGlite test transaction.
    // eslint-disable-next-line typescript/no-unsafe-type-assertion
    tx: tx as unknown as Transaction,
    workspaceId: seededWorkspaceId,
    propertyId: seededPropertyId,
    parentId: seededParentId,
    name: sanitizeFilename(fileName),
  });

describe("entity-create presigned upload validation", () => {
  test("accepts a folder parent in the same workspace", async () => {
    const tx = createValidationTx({
      parent: { id: parentId, kind: "folder" },
    });
    const { safeDb } = createScopedDbMock(tx);

    const result = await runValidation({
      safeDb,
      parentIdInput: parentId,
    });

    expect(Result.isOk(result)).toBe(true);
    expect(tx.query.entities.findFirst).toHaveBeenCalledTimes(1);
  });

  test("rejects a non-folder parent", async () => {
    const tx = createValidationTx({
      parent: { id: parentId, kind: "document" },
    });
    const { safeDb } = createScopedDbMock(tx);

    const result = await runValidation({
      safeDb,
      parentIdInput: parentId,
    });

    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error.message).toBe("Parent entity must be a folder");
    }
  });

  test("treats root uploads as explicit null without querying a parent", async () => {
    const tx = createValidationTx({});
    const { safeDb } = createScopedDbMock(tx);

    const result = await runValidation({
      safeDb,
      parentIdInput: null,
    });

    expect(Result.isOk(result)).toBe(true);
    expect(tx.query.entities.findFirst).not.toHaveBeenCalled();
  });
});

describe("entity-create filename conflicts", () => {
  test("does not rename when the same filename exists in another folder", async () => {
    const result = await runRolledBack(async (tx) => {
      const seeded = await seedWorkspace(tx);
      await seedFileEntity({
        tx,
        seededWorkspaceId: seeded.workspaceId,
        seededPropertyId: seeded.propertyId,
        seededParentId: seeded.folderAId,
        fileName: "brief.md",
      });

      return await resolveFileNameInTestTx({
        tx,
        seededWorkspaceId: seeded.workspaceId,
        seededPropertyId: seeded.propertyId,
        seededParentId: seeded.folderBId,
        fileName: "brief.md",
      });
    });

    expect(result.renamed).toBe(false);
    expect(String(result.value)).toBe("brief.md");
  });

  test("renames when the same filename exists in the target folder", async () => {
    const result = await runRolledBack(async (tx) => {
      const seeded = await seedWorkspace(tx);
      await seedFileEntity({
        tx,
        seededWorkspaceId: seeded.workspaceId,
        seededPropertyId: seeded.propertyId,
        seededParentId: seeded.folderAId,
        fileName: "brief.md",
      });

      return await resolveFileNameInTestTx({
        tx,
        seededWorkspaceId: seeded.workspaceId,
        seededPropertyId: seeded.propertyId,
        seededParentId: seeded.folderAId,
        fileName: "brief.md",
      });
    });

    expect(result.renamed).toBe(true);
    expect(String(result.value)).toBe("brief_1.md");
  });
});
