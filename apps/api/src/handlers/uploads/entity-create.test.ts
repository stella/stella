import { Result } from "better-result";
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { eq, TransactionRollbackError } from "drizzle-orm";

import type { SafeDb, Transaction } from "@/api/db";
import { organization, user } from "@/api/db/auth-schema";
import {
  entities,
  entityVersions,
  fields,
  pendingUploads,
  properties,
  workspaces,
} from "@/api/db/schema";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { LIMITS } from "@/api/lib/limits";
import { sanitizeFilename } from "@/api/lib/sanitize-filename";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type {
  TestDatabase,
  TestDatabaseTransaction,
} from "@/api/tests/security/test-utils";

import {
  checkEntityCreateCapacityForInsert,
  countActiveEntityCreateReservations,
  resolveEntityCreateFileName,
  validateEntityCreate,
  validateEntityCreateCapacity,
} from "./entity-create";
import { FINALIZE_CLAIM_TIMEOUT_MS } from "./lib";

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
  entityCount = 0,
  reservedUploadCount = 0,
  parent,
}: {
  entityCount?: number;
  reservedUploadCount?: number;
  parent?: { id: string; kind: string } | null;
}) => ({
  $count: mock(async (table) =>
    table === pendingUploads ? reservedUploadCount : entityCount,
  ),
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

const runCapacityValidation = async ({
  entityCount,
  safeDb,
  parentIdInput,
}: {
  entityCount: number;
  safeDb: SafeDb;
  parentIdInput: typeof parentId | null;
}) =>
  await Result.gen(() =>
    validateEntityCreateCapacity({
      safeDb,
      workspaceId,
      propertyId,
      parentId: parentIdInput,
      entityCount,
    }),
  );

const createCapacityInsertTx = (
  existingEntityCount: number,
  reservedUploadCount = 0,
) => {
  const forUpdate = mock(async () => [{ id: workspaceId }]);
  const limit = mock(() => ({ for: forUpdate }));
  const where = mock(() => ({ limit }));
  const from = mock(() => ({ where }));
  const select = mock(() => ({ from }));
  const countEntities = mock(async (table) =>
    table === pendingUploads ? reservedUploadCount : existingEntityCount,
  );

  return {
    forUpdate,
    tx: {
      select,
      $count: countEntities,
    },
  };
};

const runCapacityInsertCheck = async (
  existingEntityCount: number,
  reservedUploadCount = 0,
  excludeUploadId?: SafeId<"pendingUpload">,
) => {
  const { forUpdate, tx } = createCapacityInsertTx(
    existingEntityCount,
    reservedUploadCount,
  );
  const result = await checkEntityCreateCapacityForInsert({
    tx: asTestRaw<Transaction>(tx),
    workspaceId,
    entityCount: 1,
    excludeUploadId,
  });

  return { forUpdate, result };
};

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
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  workspaceId: SafeId<"workspace">;
  propertyId: SafeId<"property">;
  folderAId: SafeId<"entity">;
  folderBId: SafeId<"entity">;
};

const seedWorkspace = async (
  tx: TestDatabaseTransaction,
): Promise<SeedWorkspaceResult> => {
  const organizationId = toSafeId<"organization">(`org_${Bun.randomUUIDv7()}`);
  const userId = toSafeId<"user">(`user_${Bun.randomUUIDv7()}`);
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
  await tx.insert(user).values({
    id: userId,
    name: "Upload Test User",
    email: `${userId}@example.com`,
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
    organizationId,
    userId,
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

  test("rejects planned folder trees that exceed remaining entity capacity", async () => {
    const tx = createValidationTx({
      entityCount: LIMITS.entitiesCount - 2,
      parent: { id: parentId, kind: "folder" },
    });
    const { safeDb } = createScopedDbMock(tx);

    const result = await runCapacityValidation({
      entityCount: 3,
      safeDb,
      parentIdInput: parentId,
    });

    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error.message).toBe("Entities limit reached");
    }
  });

  test("counts pending entity-create reservations during capacity preflight", async () => {
    const tx = createValidationTx({
      entityCount: LIMITS.entitiesCount - 2,
      reservedUploadCount: 1,
      parent: { id: parentId, kind: "folder" },
    });
    const { safeDb } = createScopedDbMock(tx);

    const result = await runCapacityValidation({
      entityCount: 2,
      safeDb,
      parentIdInput: parentId,
    });

    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error.message).toBe("Entities limit reached");
    }
  });

  test("accepts planned folder trees that exactly fit remaining capacity", async () => {
    const tx = createValidationTx({
      entityCount: LIMITS.entitiesCount - 2,
      parent: { id: parentId, kind: "folder" },
    });
    const { safeDb } = createScopedDbMock(tx);

    const result = await runCapacityValidation({
      entityCount: 2,
      safeDb,
      parentIdInput: parentId,
    });

    expect(Result.isOk(result)).toBe(true);
  });

  test("rejects finalization writes that no longer fit entity capacity", async () => {
    const { forUpdate, result } = await runCapacityInsertCheck(
      LIMITS.entitiesCount,
    );

    expect(Result.isError(result)).toBe(true);
    expect(forUpdate).toHaveBeenCalledWith("update");
  });

  test("accepts finalization writes that exactly fit remaining capacity", async () => {
    const { result } = await runCapacityInsertCheck(LIMITS.entitiesCount - 1);

    expect(Result.isOk(result)).toBe(true);
  });

  test("rejects finalization writes when another pending upload reserves the last slot", async () => {
    const { result } = await runCapacityInsertCheck(
      LIMITS.entitiesCount - 1,
      1,
    );

    expect(Result.isError(result)).toBe(true);
  });

  test("counts only active entity-create reservations", async () => {
    const result = await runRolledBack(async (tx) => {
      const seeded = await seedWorkspace(tx);
      const currentUploadId = toSafeId<"pendingUpload">(Bun.randomUUIDv7());
      const now = new Date();
      const future = new Date(now.getTime() + 60_000);
      const past = new Date(now.getTime() - 60_000);
      const recentClaim = new Date(now.getTime() - 1000);
      const staleClaim = new Date(
        now.getTime() - FINALIZE_CLAIM_TIMEOUT_MS - 1000,
      );

      await tx.insert(pendingUploads).values([
        {
          id: toSafeId<"pendingUpload">(Bun.randomUUIDv7()),
          organizationId: seeded.organizationId,
          workspaceId: seeded.workspaceId,
          userId: seeded.userId,
          purpose: "entity_create",
          purposeData: {
            type: "entity_create",
            propertyId: seeded.propertyId,
          },
          declaredName: "pending.md",
          declaredMime: MARKDOWN_MIME_TYPE,
          declaredSize: 8,
          declaredSha256: SHA_256_HEX,
          status: "pending",
          expiresAt: future,
          createdAt: now,
        },
        {
          id: toSafeId<"pendingUpload">(Bun.randomUUIDv7()),
          organizationId: seeded.organizationId,
          workspaceId: seeded.workspaceId,
          userId: seeded.userId,
          purpose: "entity_create",
          purposeData: {
            type: "entity_create",
            propertyId: seeded.propertyId,
          },
          declaredName: "failed.md",
          declaredMime: MARKDOWN_MIME_TYPE,
          declaredSize: 8,
          declaredSha256: SHA_256_HEX,
          status: "failed",
          expiresAt: future,
          claimedAt: recentClaim,
          createdAt: now,
        },
        {
          id: toSafeId<"pendingUpload">(Bun.randomUUIDv7()),
          organizationId: seeded.organizationId,
          workspaceId: seeded.workspaceId,
          userId: seeded.userId,
          purpose: "entity_create",
          purposeData: {
            type: "entity_create",
            propertyId: seeded.propertyId,
          },
          declaredName: "scanning.md",
          declaredMime: MARKDOWN_MIME_TYPE,
          declaredSize: 8,
          declaredSha256: SHA_256_HEX,
          status: "scanning",
          expiresAt: past,
          claimedAt: recentClaim,
          createdAt: now,
        },
        {
          id: currentUploadId,
          organizationId: seeded.organizationId,
          workspaceId: seeded.workspaceId,
          userId: seeded.userId,
          purpose: "entity_create",
          purposeData: {
            type: "entity_create",
            propertyId: seeded.propertyId,
          },
          declaredName: "current.md",
          declaredMime: MARKDOWN_MIME_TYPE,
          declaredSize: 8,
          declaredSha256: SHA_256_HEX,
          status: "pending",
          expiresAt: future,
          createdAt: now,
        },
        {
          id: toSafeId<"pendingUpload">(Bun.randomUUIDv7()),
          organizationId: seeded.organizationId,
          workspaceId: seeded.workspaceId,
          userId: seeded.userId,
          purpose: "entity_create",
          purposeData: {
            type: "entity_create",
            propertyId: seeded.propertyId,
          },
          declaredName: "expired.md",
          declaredMime: MARKDOWN_MIME_TYPE,
          declaredSize: 8,
          declaredSha256: SHA_256_HEX,
          status: "pending",
          expiresAt: past,
          createdAt: now,
        },
        {
          id: toSafeId<"pendingUpload">(Bun.randomUUIDv7()),
          organizationId: seeded.organizationId,
          workspaceId: seeded.workspaceId,
          userId: seeded.userId,
          purpose: "entity_create",
          purposeData: {
            type: "entity_create",
            propertyId: seeded.propertyId,
          },
          declaredName: "stale-scanning.md",
          declaredMime: MARKDOWN_MIME_TYPE,
          declaredSize: 8,
          declaredSha256: SHA_256_HEX,
          status: "scanning",
          expiresAt: past,
          claimedAt: staleClaim,
          createdAt: now,
        },
        {
          id: toSafeId<"pendingUpload">(Bun.randomUUIDv7()),
          organizationId: seeded.organizationId,
          workspaceId: seeded.workspaceId,
          userId: seeded.userId,
          purpose: "entity_version",
          purposeData: {
            type: "entity_version",
            entityId: seeded.folderAId,
          },
          declaredName: "version.md",
          declaredMime: MARKDOWN_MIME_TYPE,
          declaredSize: 8,
          declaredSha256: SHA_256_HEX,
          status: "pending",
          expiresAt: future,
          createdAt: now,
        },
      ]);

      return {
        all: await countActiveEntityCreateReservations({
          tx: asTestRaw<Transaction>(tx),
          workspaceId: seeded.workspaceId,
        }),
        withoutCurrent: await countActiveEntityCreateReservations({
          tx: asTestRaw<Transaction>(tx),
          workspaceId: seeded.workspaceId,
          excludeUploadId: currentUploadId,
        }),
      };
    });

    expect(result.all).toBe(4);
    expect(result.withoutCurrent).toBe(3);
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
