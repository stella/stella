import { Result } from "better-result";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { eq, inArray } from "drizzle-orm";

import type { SafeDb } from "@/api/db/safe-db";
import { entities, entityVersions, fields, properties } from "@/api/db/schema";
import { createSafeDb } from "@/api/db/scoped";
import { createEntitiesHandler } from "@/api/handlers/entities/create";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { createSafeId, type SafeId } from "@/api/lib/branded-types";
import { writeFileVersion } from "@/api/lib/entity-versions/write-file-version";
import { allocateFileObject } from "@/api/lib/files/file-object-ids";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

setDefaultTimeout(120_000);

let testDb: TestDatabase;
let ids: TestIds;
let safeDb: SafeDb;
const createdEntityIds: SafeId<"entity">[] = [];
const filePropertyId = createSafeId<"property">();
const recordAuditEvent: AuditRecorder = async () => undefined;

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
  safeDb = asTestRaw<SafeDb>(
    createSafeDb(testDb, [ids.wsA1], ids.orgA, ids.userA1),
  );

  await testDb.insert(properties).values({
    id: filePropertyId,
    workspaceId: ids.wsA1,
    name: "Documents",
    content: { type: "file", version: 1 },
    tool: { type: "manual-input", version: 1 },
    status: "fresh",
    system: true,
    kinds: ["document"],
  });
});

afterAll(async () => {
  try {
    if (createdEntityIds.length > 0) {
      await testDb
        .delete(entities)
        .where(inArray(entities.id, createdEntityIds));
    }
    await testDb.delete(properties).where(eq(properties.id, filePropertyId));
  } finally {
    await releaseRlsFixture();
  }
});

const createEmptyEntity = async (kind: "document" | "folder") => {
  const created = await Result.gen(() =>
    createEntitiesHandler({
      safeDb,
      workspaceId: ids.wsA1,
      userId: ids.userA1,
      recordAuditEvent,
      body: { kind, name: `MCP ${kind}` },
    }),
  );
  if (Result.isError(created)) {
    throw created.error;
  }
  createdEntityIds.push(created.value.entityId);
  return created.value.entityId;
};

const writeTestFile = async (entityId: SafeId<"entity">) =>
  await safeDb(
    async (tx) =>
      await writeFileVersion({
        tx,
        organizationId: ids.orgA,
        workspaceId: ids.wsA1,
        entityId,
        userId: ids.userA1,
        recordAuditEvent,
        entityVersionId: createSafeId<"entityVersion">(),
        fieldId: createSafeId<"field">(),
        fileId: allocateFileObject(),
        fileName: "smlouva.docx",
        mimeType:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        sizeBytes: 12,
        sha256Hex:
          "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        source: null,
        writePolicy: { type: "replace-current-file" },
      }),
  );

describe("first file version persistence", () => {
  test("accepts the empty document state produced by save_document", async () => {
    const entityId = await createEmptyEntity("document");
    const before = await testDb.query.entities.findFirst({
      where: { id: { eq: entityId } },
      columns: { currentVersionId: true },
      with: { currentVersion: { with: { fields: true } } },
    });
    expect(before?.currentVersion?.fields).toEqual([]);

    const written = await writeTestFile(entityId);
    if (Result.isError(written)) {
      throw written.error;
    }
    expect(written.value.status).toBe("ok");

    const after = await testDb.query.entities.findFirst({
      where: { id: { eq: entityId } },
      columns: { currentVersionId: true },
      with: { currentVersion: { with: { fields: true } } },
    });
    const attached = after?.currentVersion?.fields.at(0);
    expect(after?.currentVersionId).not.toBe(before?.currentVersionId);
    expect(after?.currentVersion?.fields).toHaveLength(1);
    expect(attached?.propertyId).toBe(filePropertyId);
    expect(attached?.content).toMatchObject({
      type: "file",
      fileName: "smlouva.docx",
      sizeBytes: 12,
    });

    const versions = await testDb.query.entityVersions.findMany({
      where: { entityId: { eq: entityId } },
      columns: { versionNumber: true },
      orderBy: { versionNumber: "asc" },
    });
    expect(versions.map(({ versionNumber }) => versionNumber)).toEqual([1, 2]);
  });

  test("does not turn an empty folder into a file-backed document", async () => {
    const entityId = await createEmptyEntity("folder");

    const written = await writeTestFile(entityId);
    if (Result.isError(written)) {
      throw written.error;
    }
    expect(written.value).toEqual({ status: "missing-file-field" });
    expect(
      await testDb.$count(
        entityVersions,
        eq(entityVersions.entityId, entityId),
      ),
    ).toBe(1);
    const folder = await testDb.query.entities.findFirst({
      where: { id: { eq: entityId } },
      columns: { currentVersionId: true },
      with: { currentVersion: { with: { fields: true } } },
    });
    expect(folder?.currentVersion?.fields).toEqual([]);
  });

  test("rejects a malformed non-file field occupying the system file property", async () => {
    const entityId = await createEmptyEntity("document");
    const entity = await testDb.query.entities.findFirst({
      where: { id: { eq: entityId } },
      columns: { currentVersionId: true },
    });
    if (!entity?.currentVersionId) {
      throw new Error("Created document has no current version");
    }
    await testDb.insert(fields).values({
      id: createSafeId<"field">(),
      workspaceId: ids.wsA1,
      entityVersionId: entity.currentVersionId,
      propertyId: filePropertyId,
      content: { type: "text", value: "invalid", version: 1 },
    });

    const written = await writeTestFile(entityId);
    if (Result.isError(written)) {
      throw written.error;
    }
    expect(written.value).toEqual({ status: "missing-file-field" });
    expect(
      await testDb.$count(
        entityVersions,
        eq(entityVersions.entityId, entityId),
      ),
    ).toBe(1);
  });
});
