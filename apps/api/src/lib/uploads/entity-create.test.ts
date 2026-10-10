import { Result } from "better-result";
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { eq, sql, TransactionRollbackError } from "drizzle-orm";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import { organization, user } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import type { SafeDb } from "@/api/db/safe-db";
import {
  entities,
  entityVersions,
  fields,
  pendingUploads,
  properties,
  workspaces,
} from "@/api/db/schema";
import { env } from "@/api/env";
import uploadEntity from "@/api/handlers/entities/upload";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { sanitizeFilename } from "@/api/lib/sanitize-filename";
import { FINALIZE_CLAIM_TIMEOUT_MS } from "@/api/lib/uploads/runtime";
import { startFakeS3 } from "@/api/tests/helpers/fake-s3";
import {
  NO_DB,
  createTestHandlerContext,
} from "@/api/tests/helpers/handler-context";
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

const workspaceId = toSafeId<"workspace">("workspace_upload");
const propertyId = toSafeId<"property">("property_upload");
const parentId = toSafeId<"entity">("entity_folder");
const MARKDOWN_MIME_TYPE = "text/markdown";
const SHA_256_HEX = "a".repeat(64);

let testDb: TestDatabase;

beforeAll(
  async () => {
    testDb = await getTestDb();
  },
  { timeout: 30_000 },
);

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
  // `checkEntityCreateCapacityForInsert` acquires its workspace-row
  // lock via the shared `lockWorkspacesForEntityCap` helper, which
  // issues a raw `tx.execute(sql\`... FOR UPDATE\`)` per workspace id
  // (see apps/api/src/lib/entity-cap-lock.ts).
  const execute = mock(async () => [{ id: workspaceId }]);
  const countEntities = mock(async (table) =>
    table === pendingUploads ? reservedUploadCount : existingEntityCount,
  );

  return {
    execute,
    tx: {
      execute,
      $count: countEntities,
    },
  };
};

const runCapacityInsertCheck = async (
  existingEntityCount: number,
  reservedUploadCount = 0,
  excludeUploadId?: SafeId<"pendingUpload">,
) => {
  const { execute, tx } = createCapacityInsertTx(
    existingEntityCount,
    reservedUploadCount,
  );
  const result = await checkEntityCreateCapacityForInsert({
    tx: asTestRaw<Transaction>(tx),
    workspaceId,
    entityCount: 1,
    excludeUploadId,
  });

  return { execute, result };
};

type RolledBackTxCallback<T> = (tx: TestDatabaseTransaction) => Promise<T>;

const runRolledBack = async <T>(
  callback: RolledBackTxCallback<T>,
): Promise<T> => {
  let value: T | undefined;
  try {
    await testDb.transaction(async (tx) => {
      await tx.execute(sql.raw("RESET ROLE"));
      // oxlint-disable-next-line node/callback-return -- must call tx.rollback() after capturing the value
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
  return { entityId, entityVersionId, fieldId };
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
  seededParentId: SafeId<"entity"> | null;
  fileName: string;
};

const resolveFileNameInTestTx = async ({
  tx,
  seededWorkspaceId,
  seededParentId,
  fileName,
}: ResolveFileNameInTestTxOptions) =>
  await resolveEntityCreateFileName({
    // SAFETY: the helper only uses Drizzle query-builder methods shared by
    // the production Bun SQL transaction and the PGlite test transaction.
    tx: asTestRaw<Transaction>(tx),
    workspaceId: seededWorkspaceId,
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
    const { execute, result } = await runCapacityInsertCheck(
      LIMITS.entitiesCount,
    );

    expect(Result.isError(result)).toBe(true);
    expect(execute).toHaveBeenCalledTimes(1);
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
      const future = sql<Date>`NOW() + interval '1 minute'`;
      const past = sql<Date>`NOW() - interval '1 minute'`;
      const recentClaim = sql<Date>`NOW() - interval '1 second'`;
      const staleClaimSeconds =
        Math.floor(FINALIZE_CLAIM_TIMEOUT_MS / 1000) + 1;
      const staleClaim = sql<Date>`NOW() - ${staleClaimSeconds} * interval '1 second'`;
      const createdAt = sql<Date>`NOW()`;

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
          createdAt,
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
          createdAt,
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
          createdAt,
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
          createdAt,
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
          createdAt,
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
          createdAt,
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
          createdAt,
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
        seededParentId: seeded.folderAId,
        fileName: "brief.md",
      });
    });

    expect(result.renamed).toBe(true);
    expect(String(result.value)).toBe("brief_1.md");
  });
});

test("upload names are free among exact current siblings", async () => {
  await assertProperty(
    "upload names are free among exact current siblings",
    fc.asyncProperty(
      fc.string({ minLength: 1, maxLength: 80 }),
      fc.array(fc.string({ minLength: 1, maxLength: 80 }), { maxLength: 8 }),
      fc.boolean(),
      async (rawRequested, arbitraryNames, occupied) => {
        for (const scope of ["root", "folder"] as const) {
          await runRolledBack(async (tx) => {
            const seeded = await seedWorkspace(tx);
            const other = await seedWorkspace(tx);
            const targetParentId = scope === "root" ? null : seeded.folderAId;
            const otherMatterParentId =
              scope === "root" ? null : other.folderAId;
            const requested = sanitizeFilename(rawRequested);
            const siblings = new Set<string>(
              arbitraryNames.map(sanitizeFilename),
            );
            if (occupied) {
              siblings.add(requested);
            }
            for (const name of siblings) {
              await tx.insert(entities).values({
                id: toSafeId<"entity">(Bun.randomUUIDv7()),
                workspaceId: seeded.workspaceId,
                parentId: targetParentId,
                kind: "task",
                name,
              });
            }
            await seedFileEntity({
              tx,
              seededWorkspaceId: seeded.workspaceId,
              seededPropertyId: seeded.propertyId,
              seededParentId: seeded.folderBId,
              fileName: requested,
            });
            await seedFileEntity({
              tx,
              seededWorkspaceId: other.workspaceId,
              seededPropertyId: other.propertyId,
              seededParentId: otherMatterParentId,
              fileName: requested,
            });
            const resolved = await resolveFileNameInTestTx({
              tx,
              seededWorkspaceId: seeded.workspaceId,
              seededParentId: targetParentId,
              fileName: requested,
            });
            expect(siblings.has(resolved.value)).toBe(false);
            expect(resolved.value.length).toBeLessThanOrEqual(255);
            if (!siblings.has(requested)) {
              expect(String(resolved.value)).toBe(String(requested));
            }
            return true;
          });
        }
      },
    ),
    {
      numRuns: 20,
      examples: [
        [" ", [], false],
        [" ", [" "], true],
      ],
    },
  );
});

test("entity names collide across properties and absent current fields", async () => {
  await runRolledBack(async (tx) => {
    const seeded = await seedWorkspace(tx);
    const otherPropertyId = toSafeId<"property">(Bun.randomUUIDv7());
    await tx.insert(properties).values({
      id: otherPropertyId,
      workspaceId: seeded.workspaceId,
      name: "Other file",
      content: { type: "file", version: 1 },
      tool: { type: "manual-input", version: 1 },
      status: "fresh",
    });
    const historic = await seedFileEntity({
      tx,
      seededWorkspaceId: seeded.workspaceId,
      seededPropertyId: otherPropertyId,
      seededParentId: seeded.folderAId,
      fileName: "brief.md",
    });
    const currentId = toSafeId<"entityVersion">(Bun.randomUUIDv7());
    await tx.insert(entityVersions).values({
      id: currentId,
      entityId: historic.entityId,
      workspaceId: seeded.workspaceId,
      versionNumber: 2,
    });
    await tx
      .update(entities)
      .set({ currentVersionId: currentId })
      .where(eq(entities.id, historic.entityId));
    await tx.insert(entities).values({
      id: toSafeId<"entity">(Bun.randomUUIDv7()),
      workspaceId: seeded.workspaceId,
      parentId: seeded.folderAId,
      kind: "folder",
      name: "brief_1.md",
    });
    const resolved = await resolveFileNameInTestTx({
      tx,
      seededWorkspaceId: seeded.workspaceId,
      seededParentId: seeded.folderAId,
      fileName: "brief.md",
    });
    expect(String(resolved.value)).toBe("brief_2.md");
    return true;
  });
});

test("root names exclude entities from another matter", async () => {
  await runRolledBack(async (tx) => {
    const seeded = await seedWorkspace(tx);
    const other = await seedWorkspace(tx);
    await seedFileEntity({
      tx,
      seededWorkspaceId: other.workspaceId,
      seededPropertyId: other.propertyId,
      seededParentId: null,
      fileName: "brief.md",
    });
    const resolved = await resolveFileNameInTestTx({
      tx,
      seededWorkspaceId: seeded.workspaceId,
      seededParentId: null,
      fileName: "brief.md",
    });
    expect(String(resolved.value)).toBe("brief.md");
    return true;
  });
});

test("multipart upload resolves names against current root siblings", async () => {
  const fake = startFakeS3();
  const priorFlag = env.FEATURE_FILE_USAGE_LIMITS;
  env.FEATURE_FILE_USAGE_LIMITS = false;
  try {
    const seeded = await testDb.transaction(async (tx) => {
      await tx.execute(sql.raw("RESET ROLE"));
      const setup = await seedWorkspace(tx);
      for (const fileName of [
        "contract.md",
        "contract_1.md",
        "contract_3.md",
        "contract_final.md",
      ]) {
        await seedFileEntity({
          tx,
          seededWorkspaceId: setup.workspaceId,
          seededPropertyId: setup.propertyId,
          seededParentId: null,
          fileName,
        });
      }
      return setup;
    });
    const safeDb: SafeDb = async (callback) =>
      await Result.tryPromise(
        async () =>
          await testDb.transaction(async (tx) => {
            await tx.execute(sql.raw("RESET ROLE"));
            return await callback(asTestRaw<Transaction>(tx));
          }),
      );
    const recorded = new Set<string>();
    const refusePublication: AuditRecorder = async (tx) => {
      const uploaded = await tx
        .select({ content: fields.content })
        .from(fields)
        .where(eq(fields.workspaceId, seeded.workspaceId));
      for (const field of uploaded) {
        if (field.content.type === "file") {
          recorded.add(field.content.fileName);
        }
      }
      throw new HandlerError({
        status: 500,
        message: "Publication refused by test",
      });
    };
    const result = await uploadEntity.handler(
      createTestHandlerContext<Parameters<typeof uploadEntity.handler>[0]>({
        audit: refusePublication,
        scopedDb: NO_DB,
        workspaceId: seeded.workspaceId,
        session: { activeOrganizationId: seeded.organizationId },
        user: { id: seeded.userId },
        safeDb,
        body: {
          file: new File(["plain text"], "contract.md", {
            type: MARKDOWN_MIME_TYPE,
          }),
          name: "contract.md",
          propertyId: seeded.propertyId,
        },
        createAuditRecorder: () => refusePublication,
      }),
    );
    expect(result).toMatchObject({ code: 500 });
    expect(recorded.has("contract_2.md")).toBe(true);
    expect(recorded.has("contract_4.md")).toBe(false);
  } finally {
    env.FEATURE_FILE_USAGE_LIMITS = priorFlag;
    fake.stop();
  }
});
