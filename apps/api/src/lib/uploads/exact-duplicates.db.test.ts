import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";

import { organization, user } from "@/api/db/auth-schema";
import type { SafeDb } from "@/api/db/safe-db";
import {
  entities,
  entityVersions,
  fields,
  properties,
  workspaces,
} from "@/api/db/schema";
import { createSafeDb } from "@/api/db/scoped";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { allocateFileObject } from "@/api/lib/files/file-object-ids";
import { findExactDuplicates } from "@/api/lib/uploads/exact-duplicates";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { deleteOrganizationsForTest } from "@/api/tests/helpers/organization-deletion";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

let db: TestDatabase;
const organizationId = mintAuthProviderId<"organization">();
const userId = mintAuthProviderId<"user">();
const matterId = createSafeId<"workspace">();
const otherMatterId = createSafeId<"workspace">();
const propertyIds = new Map<SafeId<"workspace">, SafeId<"property">>();

const CURRENT = "a".repeat(64);
const SUPERSEDED = "b".repeat(64);
const OTHER_MATTER_ONLY = "c".repeat(64);
const TASK_ATTACHMENT = "e".repeat(64);
/** The matter's document whose current file is `CURRENT`. */
const contractId = createSafeId<"entity">();

type SeedDocumentOptions = {
  workspaceId: SafeId<"workspace">;
  kind?: "document" | "task";
  name: string;
  docSequence: number | null;
  versionHashes: readonly string[];
  entityId?: SafeId<"entity">;
};

/** An entity with one file version per hash; the last is the current one. */
const seedDocument = async ({
  workspaceId,
  kind = "document",
  name,
  docSequence,
  versionHashes,
  entityId = createSafeId<"entity">(),
}: SeedDocumentOptions): Promise<void> => {
  const propertyId = propertyIds.get(workspaceId);
  if (propertyId === undefined) {
    throw new Error("Seed the matter's file property first");
  }
  const versions = versionHashes.map((sha256Hex, index) => ({
    id: createSafeId<"entityVersion">(),
    sha256Hex,
    versionNumber: index + 1,
  }));

  await db.insert(entities).values({
    id: entityId,
    workspaceId,
    kind,
    name,
    docSequence,
  });
  await db.insert(entityVersions).values(
    versions.map(({ id, versionNumber }) => ({
      id,
      entityId,
      workspaceId,
      versionNumber,
    })),
  );
  await db.insert(fields).values(
    versions.map(({ id, sha256Hex }) => ({
      id: createSafeId<"field">(),
      entityVersionId: id,
      workspaceId,
      propertyId,
      content: {
        type: "file",
        version: 1,
        id: allocateFileObject(),
        fileName: name,
        mimeType: "application/pdf",
        sizeBytes: 8,
        encrypted: false,
        sha256Hex,
        pdfFileId: null,
      } as const,
    })),
  );
  await db
    .update(entities)
    .set({ currentVersionId: versions.at(-1)?.id })
    .where(eq(entities.id, entityId));
};

type FindOptions = {
  access: readonly SafeId<"workspace">[];
  workspaceId: SafeId<"workspace">;
  sha256Hexes: readonly string[];
};

const find = async ({ access, workspaceId, sha256Hexes }: FindOptions) => {
  const safeDb = asTestRaw<SafeDb>(
    createSafeDb(db, [...access], organizationId, userId),
  );
  const result = await safeDb(
    async (tx) => await findExactDuplicates({ tx, workspaceId, sha256Hexes }),
  );
  return result.unwrap();
};

beforeAll(async () => {
  db = await getTestDb();
  await db.insert(organization).values({
    id: organizationId,
    name: "Exact duplicates",
    slug: organizationId,
    createdAt: new Date("2026-01-01T00:00:00Z"),
  });
  await db.insert(user).values({
    id: userId,
    name: "Exact Duplicates User",
    email: `${userId}@example.test`,
  });
  await db.insert(workspaces).values([
    { id: matterId, organizationId, name: "Matter", reference: "DUP-1" },
    { id: otherMatterId, organizationId, name: "Other", reference: "DUP-2" },
  ]);
  for (const workspaceId of [matterId, otherMatterId]) {
    const propertyId = createSafeId<"property">();
    propertyIds.set(workspaceId, propertyId);
    await db.insert(properties).values({
      id: propertyId,
      workspaceId,
      name: "File",
      content: { type: "file", version: 1 },
      tool: { type: "manual-input", version: 1 },
      status: "fresh",
      system: true,
      kinds: ["document"],
    });
  }
  await seedDocument({
    entityId: contractId,
    workspaceId: matterId,
    name: "Contract.pdf",
    docSequence: 1,
    versionHashes: [SUPERSEDED, CURRENT],
  });
  await seedDocument({
    workspaceId: otherMatterId,
    name: "Elsewhere.pdf",
    docSequence: 1,
    versionHashes: [OTHER_MATTER_ONLY],
  });
  await seedDocument({
    workspaceId: matterId,
    kind: "task",
    name: "Review the contract",
    docSequence: null,
    versionHashes: [TASK_ATTACHMENT],
  });
});

afterAll(async () => {
  await deleteOrganizationsForTest(db, [organizationId]);
  await db.delete(user).where(inArray(user.id, [userId]));
  await releaseTestDb();
});

test("a file with the bytes of a matter's current document is a duplicate", async () => {
  expect(
    await find({
      access: [matterId],
      workspaceId: matterId,
      sha256Hexes: [CURRENT, "d".repeat(64)],
    }),
  ).toEqual([
    { sha256Hex: CURRENT, entityId: contractId, entityName: "Contract.pdf" },
  ]);
});

test("a file only a task holds is not a duplicate document", async () => {
  expect(
    await find({
      access: [matterId],
      workspaceId: matterId,
      sha256Hexes: [TASK_ATTACHMENT],
    }),
  ).toEqual([]);
});

test("bytes only a superseded version holds are not a duplicate", async () => {
  expect(
    await find({
      access: [matterId],
      workspaceId: matterId,
      sha256Hexes: [SUPERSEDED],
    }),
  ).toEqual([]);
});

test("a document in another matter is never reported", async () => {
  expect(
    await find({
      access: [matterId, otherMatterId],
      workspaceId: matterId,
      sha256Hexes: [OTHER_MATTER_ONLY],
    }),
  ).toEqual([]);
});

test("a user without access to the matter learns nothing about it", async () => {
  expect(
    await find({
      access: [otherMatterId],
      workspaceId: matterId,
      sha256Hexes: [CURRENT],
    }),
  ).toEqual([]);
});
