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

import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import {
  desktopEditSessions,
  entities,
  entityVersions,
  fields,
  properties,
} from "@/api/db/schema";
import { createSafeDb, createScopedDb } from "@/api/db/scoped";
import { createEntitiesHandler } from "@/api/handlers/entities/create";
import { updateDocumentProperties } from "@/api/handlers/files/update-document-properties";
import { AUDIT_ACTION } from "@/api/lib/audit-log";
import type { AuditEvent, AuditRecorder } from "@/api/lib/audit-log";
import { createSafeId, type SafeId } from "@/api/lib/branded-types";
import { writeFileVersion } from "@/api/lib/entity-versions/write-file-version";
import type { FileVersionWritePolicy } from "@/api/lib/entity-versions/write-file-version";
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
let scopedDb: ScopedDb;
const createdEntityIds: SafeId<"entity">[] = [];
const filePropertyId = createSafeId<"property">();
const secondaryFilePropertyId = createSafeId<"property">();
const recordAuditEvent: AuditRecorder = async () => undefined;

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
  safeDb = asTestRaw<SafeDb>(
    createSafeDb(testDb, [ids.wsA1], ids.orgA, ids.userA1),
  );
  scopedDb = asTestRaw<ScopedDb>(
    createScopedDb(testDb, [ids.wsA1], ids.orgA, ids.userA1),
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
  await testDb.insert(properties).values({
    id: secondaryFilePropertyId,
    workspaceId: ids.wsA1,
    name: "Exhibits",
    content: { type: "file", version: 1 },
    tool: { type: "manual-input", version: 1 },
    status: "fresh",
    system: false,
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
    await testDb
      .delete(properties)
      .where(eq(properties.id, secondaryFilePropertyId));
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

type WriteTestFileOptions = {
  entityVersionId?: SafeId<"entityVersion">;
  fieldId?: SafeId<"field">;
  fileName?: string;
  recordAuditEvent?: AuditRecorder;
  scanWarnings?: string[];
  versionMetadata?: {
    collaborationContributorUserIds?: string[];
    description?: string;
    label?: string;
  };
  writePolicy?: FileVersionWritePolicy;
};

const writeTestFile = async (
  entityId: SafeId<"entity">,
  options: WriteTestFileOptions = {},
) =>
  await safeDb(
    async (tx) =>
      await writeFileVersion({
        tx,
        organizationId: ids.orgA,
        workspaceId: ids.wsA1,
        entityId,
        userId: ids.userA1,
        recordAuditEvent: options.recordAuditEvent ?? recordAuditEvent,
        entityVersionId:
          options.entityVersionId ?? createSafeId<"entityVersion">(),
        fieldId: options.fieldId ?? createSafeId<"field">(),
        fileId: allocateFileObject(),
        fileName: options.fileName ?? "smlouva.docx",
        mimeType:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        sizeBytes: 12,
        sha256Hex:
          "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        source: null,
        scanWarnings: options.scanWarnings,
        versionMetadata: options.versionMetadata,
        writePolicy: options.writePolicy ?? { type: "replace-current-file" },
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

  test("rejects derived bytes when the current version changed before the lock", async () => {
    const entityId = await createEmptyEntity("document");
    const original = await testDb.query.entities.findFirst({
      where: { id: { eq: entityId } },
      columns: { currentVersionId: true },
    });
    if (!original?.currentVersionId) {
      throw new Error("Created document has no current version");
    }

    const interveningWrite = await writeTestFile(entityId);
    if (Result.isError(interveningWrite)) {
      throw interveningWrite.error;
    }
    if (interveningWrite.value.status !== "ok") {
      throw new Error(
        `Intervening write failed: ${interveningWrite.value.status}`,
      );
    }

    const staleWrite = await writeTestFile(entityId, {
      writePolicy: {
        type: "replace-current-file-from-version",
        expectedCurrentVersionId: original.currentVersionId,
      },
    });
    if (Result.isError(staleWrite)) {
      throw staleWrite.error;
    }

    expect(staleWrite.value).toEqual({ status: "current-version-changed" });
    const after = await testDb.query.entities.findFirst({
      where: { id: { eq: entityId } },
      columns: { currentVersionId: true },
    });
    expect(after?.currentVersionId).toBe(
      interveningWrite.value.entityVersionId,
    );
    expect(
      await testDb.$count(
        entityVersions,
        eq(entityVersions.entityId, entityId),
      ),
    ).toBe(2);
  });

  test("appends a derived version without replacing the current document", async () => {
    const entityId = await createEmptyEntity("document");
    const source = await writeTestFile(entityId);
    if (Result.isError(source)) {
      throw source.error;
    }
    if (source.value.status !== "ok") {
      throw new Error(`Initial write failed: ${source.value.status}`);
    }
    const current = await writeTestFile(entityId);
    if (Result.isError(current)) {
      throw current.error;
    }
    if (current.value.status !== "ok") {
      throw new Error(`Current write failed: ${current.value.status}`);
    }

    const derivedVersionId = createSafeId<"entityVersion">();
    const derived = await writeTestFile(entityId, {
      entityVersionId: derivedVersionId,
      writePolicy: {
        type: "append-derived-file-from-version",
        comparisonVersionId: derivedVersionId,
        expectedCurrentVersionId: current.value.entityVersionId,
        filePropertyId,
        sourceVersionId: source.value.entityVersionId,
      },
    });
    if (Result.isError(derived)) {
      throw derived.error;
    }
    expect(derived.value.status).toBe("ok");

    const after = await testDb.query.entities.findFirst({
      where: { id: { eq: entityId } },
      columns: { currentVersionId: true },
    });
    expect(after?.currentVersionId).toBe(current.value.entityVersionId);
    expect(
      await testDb.$count(
        entityVersions,
        eq(entityVersions.entityId, entityId),
      ),
    ).toBe(4);
  });

  test("replays a sequential comparison save without a second audit or current-version update", async () => {
    const entityId = await createEmptyEntity("document");
    const source = await writeTestFile(entityId);
    if (Result.isError(source)) {
      throw source.error;
    }
    if (source.value.status !== "ok") {
      throw new Error(`Source write failed: ${source.value.status}`);
    }
    const current = await writeTestFile(entityId);
    if (Result.isError(current)) {
      throw current.error;
    }
    if (current.value.status !== "ok") {
      throw new Error(`Current write failed: ${current.value.status}`);
    }

    const auditEvents: AuditEvent[] = [];
    const captureAuditEvent: AuditRecorder = async (_tx, event) => {
      if (Array.isArray(event)) {
        auditEvents.push(...event);
        return;
      }
      auditEvents.push(event);
    };
    const derivedVersionId = createSafeId<"entityVersion">();
    const policy = {
      type: "append-derived-file-from-version",
      comparisonVersionId: derivedVersionId,
      expectedCurrentVersionId: current.value.entityVersionId,
      filePropertyId,
      sourceVersionId: source.value.entityVersionId,
    } as const satisfies FileVersionWritePolicy;
    const firstFieldId = createSafeId<"field">();
    const first = await writeTestFile(entityId, {
      entityVersionId: derivedVersionId,
      fieldId: firstFieldId,
      recordAuditEvent: captureAuditEvent,
      writePolicy: policy,
    });
    if (Result.isError(first)) {
      throw first.error;
    }
    if (first.value.status !== "ok") {
      throw new Error(`First comparison write failed: ${first.value.status}`);
    }

    const replay = await writeTestFile(entityId, {
      entityVersionId: derivedVersionId,
      fieldId: createSafeId<"field">(),
      recordAuditEvent: captureAuditEvent,
      writePolicy: policy,
    });
    if (Result.isError(replay)) {
      throw replay.error;
    }
    expect(replay.value).toEqual({
      status: "replayed",
      entityVersionId: derivedVersionId,
      fieldId: firstFieldId,
      filePropertyId,
      fileName: "smlouva.docx",
      versionNumber: first.value.versionNumber,
    });
    expect(
      auditEvents.filter((event) => event.action === AUDIT_ACTION.CREATE),
    ).toHaveLength(1);
    const entity = await testDb.query.entities.findFirst({
      where: { id: { eq: entityId } },
      columns: { currentVersionId: true },
    });
    expect(entity?.currentVersionId).toBe(current.value.entityVersionId);
  });

  test("serializes concurrent comparison saves into one artifact and replay", async () => {
    const entityId = await createEmptyEntity("document");
    const source = await writeTestFile(entityId);
    if (Result.isError(source)) {
      throw source.error;
    }
    if (source.value.status !== "ok") {
      throw new Error(`Source write failed: ${source.value.status}`);
    }
    const current = await writeTestFile(entityId);
    if (Result.isError(current)) {
      throw current.error;
    }
    if (current.value.status !== "ok") {
      throw new Error(`Current write failed: ${current.value.status}`);
    }

    const auditEvents: AuditEvent[] = [];
    const captureAuditEvent: AuditRecorder = async (_tx, event) => {
      if (Array.isArray(event)) {
        auditEvents.push(...event);
        return;
      }
      auditEvents.push(event);
    };
    const derivedVersionId = createSafeId<"entityVersion">();
    const policy = {
      type: "append-derived-file-from-version",
      comparisonVersionId: derivedVersionId,
      expectedCurrentVersionId: current.value.entityVersionId,
      filePropertyId,
      sourceVersionId: source.value.entityVersionId,
    } as const satisfies FileVersionWritePolicy;
    const [first, second] = await Promise.all([
      writeTestFile(entityId, {
        entityVersionId: derivedVersionId,
        fieldId: createSafeId<"field">(),
        recordAuditEvent: captureAuditEvent,
        writePolicy: policy,
      }),
      writeTestFile(entityId, {
        entityVersionId: derivedVersionId,
        fieldId: createSafeId<"field">(),
        recordAuditEvent: captureAuditEvent,
        writePolicy: policy,
      }),
    ]);
    if (Result.isError(first)) {
      throw first.error;
    }
    if (Result.isError(second)) {
      throw second.error;
    }
    const outcomes = [first.value, second.value];
    const created = outcomes.find((outcome) => outcome.status === "ok");
    const replayed = outcomes.find((outcome) => outcome.status === "replayed");
    if (!created || !replayed) {
      throw new Error(
        `Expected one created comparison and one replay, received ${outcomes.map((outcome) => outcome.status).join(", ")}`,
      );
    }

    expect(replayed).toEqual({
      status: "replayed",
      entityVersionId: derivedVersionId,
      fieldId: created.fieldId,
      filePropertyId,
      fileName: "smlouva.docx",
      versionNumber: created.versionNumber,
    });
    expect(
      auditEvents.filter((event) => event.action === AUDIT_ACTION.CREATE),
    ).toHaveLength(1);
    expect(
      await testDb.$count(
        entityVersions,
        eq(entityVersions.entityId, entityId),
      ),
    ).toBe(4);
    const entity = await testDb.query.entities.findFirst({
      where: { id: { eq: entityId } },
      columns: { currentVersionId: true },
    });
    expect(entity?.currentVersionId).toBe(current.value.entityVersionId);
  });

  test("replays a comparison after the current version advances", async () => {
    const entityId = await createEmptyEntity("document");
    const source = await writeTestFile(entityId);
    if (Result.isError(source)) {
      throw source.error;
    }
    if (source.value.status !== "ok") {
      throw new Error(`Source write failed: ${source.value.status}`);
    }
    const current = await writeTestFile(entityId);
    if (Result.isError(current)) {
      throw current.error;
    }
    if (current.value.status !== "ok") {
      throw new Error(`Current write failed: ${current.value.status}`);
    }

    const auditEvents: AuditEvent[] = [];
    const captureAuditEvent: AuditRecorder = async (_tx, event) => {
      if (Array.isArray(event)) {
        auditEvents.push(...event);
        return;
      }
      auditEvents.push(event);
    };
    const derivedVersionId = createSafeId<"entityVersion">();
    const policy = {
      type: "append-derived-file-from-version",
      comparisonVersionId: derivedVersionId,
      expectedCurrentVersionId: current.value.entityVersionId,
      filePropertyId,
      sourceVersionId: source.value.entityVersionId,
    } as const satisfies FileVersionWritePolicy;
    const derived = await writeTestFile(entityId, {
      entityVersionId: derivedVersionId,
      fieldId: createSafeId<"field">(),
      recordAuditEvent: captureAuditEvent,
      writePolicy: policy,
    });
    if (Result.isError(derived)) {
      throw derived.error;
    }
    if (derived.value.status !== "ok") {
      throw new Error(`Comparison write failed: ${derived.value.status}`);
    }

    const advanced = await writeTestFile(entityId);
    if (Result.isError(advanced)) {
      throw advanced.error;
    }
    if (advanced.value.status !== "ok") {
      throw new Error(`Advance write failed: ${advanced.value.status}`);
    }
    const replay = await writeTestFile(entityId, {
      entityVersionId: derivedVersionId,
      fieldId: createSafeId<"field">(),
      recordAuditEvent: captureAuditEvent,
      writePolicy: policy,
    });
    if (Result.isError(replay)) {
      throw replay.error;
    }
    expect(replay.value).toEqual({
      status: "replayed",
      entityVersionId: derivedVersionId,
      fieldId: derived.value.fieldId,
      filePropertyId,
      fileName: "smlouva.docx",
      versionNumber: derived.value.versionNumber,
    });
    expect(
      auditEvents.filter((event) => event.action === AUDIT_ACTION.CREATE),
    ).toHaveLength(1);
    const entity = await testDb.query.entities.findFirst({
      where: { id: { eq: entityId } },
      columns: { currentVersionId: true },
    });
    expect(entity?.currentVersionId).toBe(advanced.value.entityVersionId);
  });

  test("does not replay a withdrawn comparison version", async () => {
    const entityId = await createEmptyEntity("document");
    const source = await writeTestFile(entityId);
    if (Result.isError(source)) {
      throw source.error;
    }
    if (source.value.status !== "ok") {
      throw new Error(`Source write failed: ${source.value.status}`);
    }
    const current = await writeTestFile(entityId);
    if (Result.isError(current)) {
      throw current.error;
    }
    if (current.value.status !== "ok") {
      throw new Error(`Current write failed: ${current.value.status}`);
    }

    const derivedVersionId = createSafeId<"entityVersion">();
    const policy = {
      type: "append-derived-file-from-version",
      comparisonVersionId: derivedVersionId,
      expectedCurrentVersionId: current.value.entityVersionId,
      filePropertyId,
      sourceVersionId: source.value.entityVersionId,
    } as const satisfies FileVersionWritePolicy;
    const derived = await writeTestFile(entityId, {
      entityVersionId: derivedVersionId,
      writePolicy: policy,
    });
    if (Result.isError(derived)) {
      throw derived.error;
    }
    if (derived.value.status !== "ok") {
      throw new Error(`Comparison write failed: ${derived.value.status}`);
    }
    await testDb
      .update(entityVersions)
      .set({ deletedAt: new Date() })
      .where(eq(entityVersions.id, derivedVersionId));

    const replay = await writeTestFile(entityId, {
      entityVersionId: derivedVersionId,
      writePolicy: policy,
    });
    if (Result.isError(replay)) {
      throw replay.error;
    }
    expect(replay.value).toEqual({ status: "target-file-not-found" });
  });

  test("appends a derived version into the selected file property", async () => {
    const entityId = await createEmptyEntity("document");
    const source = await writeTestFile(entityId);
    if (Result.isError(source)) {
      throw source.error;
    }
    if (source.value.status !== "ok") {
      throw new Error(`Initial write failed: ${source.value.status}`);
    }

    await testDb.insert(fields).values({
      id: createSafeId<"field">(),
      workspaceId: ids.wsA1,
      entityVersionId: source.value.entityVersionId,
      propertyId: secondaryFilePropertyId,
      content: {
        version: 1,
        type: "file",
        id: allocateFileObject(),
        fileName: "exhibit.docx",
        mimeType:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        sizeBytes: 12,
        encrypted: false,
        sha256Hex:
          "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        pdfFileId: null,
      },
    });

    const derivedVersionId = createSafeId<"entityVersion">();
    const derived = await writeTestFile(entityId, {
      entityVersionId: derivedVersionId,
      fileName: "exhibit redline.docx",
      writePolicy: {
        type: "append-derived-file-from-version",
        comparisonVersionId: derivedVersionId,
        expectedCurrentVersionId: source.value.entityVersionId,
        filePropertyId: secondaryFilePropertyId,
        sourceVersionId: source.value.entityVersionId,
      },
    });
    if (Result.isError(derived)) {
      throw derived.error;
    }
    if (derived.value.status !== "ok") {
      throw new Error(`Derived write failed: ${derived.value.status}`);
    }
    expect(derived.value.filePropertyId).toBe(secondaryFilePropertyId);

    const entity = await testDb.query.entities.findFirst({
      where: { id: { eq: entityId } },
      columns: { currentVersionId: true },
    });
    expect(entity?.currentVersionId).toBe(source.value.entityVersionId);

    const version = await testDb.query.entityVersions.findFirst({
      where: { id: { eq: derived.value.entityVersionId } },
      with: { fields: true },
    });
    const primaryFile = version?.fields.find(
      (field) => field.propertyId === filePropertyId,
    );
    const selectedFile = version?.fields.find(
      (field) => field.propertyId === secondaryFilePropertyId,
    );
    expect(primaryFile?.content).toMatchObject({
      type: "file",
      fileName: "smlouva.docx",
    });
    expect(selectedFile?.content).toMatchObject({
      type: "file",
      fileName: "exhibit redline.docx",
    });
  });

  test("publishes collaboration metadata through the targeted canonical writer", async () => {
    const entityId = await createEmptyEntity("document");
    const initialWrite = await writeTestFile(entityId);
    if (Result.isError(initialWrite)) {
      throw initialWrite.error;
    }
    if (initialWrite.value.status !== "ok") {
      throw new Error(`Initial write failed: ${initialWrite.value.status}`);
    }

    const published = await writeTestFile(entityId, {
      versionMetadata: {
        collaborationContributorUserIds: [ids.userA1, ids.userA2],
        description: "Negotiated together",
        label: "Shared draft",
      },
      writePolicy: {
        type: "collaboration-room-publish",
        expectedCurrentVersionId: initialWrite.value.entityVersionId,
        filePropertyId,
      },
    });
    if (Result.isError(published)) {
      throw published.error;
    }
    expect(published.value.status).toBe("ok");
    if (published.value.status !== "ok") {
      return;
    }

    const version = await testDb.query.entityVersions.findFirst({
      where: { id: { eq: published.value.entityVersionId } },
      columns: {
        collaborationContributorUserIds: true,
        description: true,
        label: true,
      },
      with: { fields: { columns: { propertyId: true } } },
    });
    expect(version).toMatchObject({
      collaborationContributorUserIds: [ids.userA1, ids.userA2],
      description: "Negotiated together",
      label: "Shared draft",
    });
    expect(
      version?.fields.some((field) => field.propertyId === filePropertyId),
    ).toBeTrue();
  });

  test("does not publish a collaboration version over a live desktop session", async () => {
    const entityId = await createEmptyEntity("document");
    const initialWrite = await writeTestFile(entityId);
    if (Result.isError(initialWrite)) {
      throw initialWrite.error;
    }
    if (initialWrite.value.status !== "ok") {
      throw new Error(`Initial write failed: ${initialWrite.value.status}`);
    }

    const sessionId = createSafeId<"desktopEditSession">();
    await testDb.insert(desktopEditSessions).values({
      baseVersionId: initialWrite.value.entityVersionId,
      checkpointFileId: createSafeId<"userFile">(),
      createdBy: ids.userA1,
      entityId,
      fileName: "desktop.docx",
      fileType: "docx",
      id: sessionId,
      propertyId: filePropertyId,
      sessionTokenHash: "b".repeat(64),
      tokenExpiresAt: new Date("2100-01-01T00:00:00.000Z"),
      workspaceId: ids.wsA1,
    });

    try {
      const published = await writeTestFile(entityId, {
        writePolicy: {
          type: "collaboration-room-publish",
          expectedCurrentVersionId: initialWrite.value.entityVersionId,
          filePropertyId,
        },
      });
      if (Result.isError(published)) {
        throw published.error;
      }
      expect(published.value).toEqual({ status: "edit-session-open" });
      expect(
        await testDb.$count(
          entityVersions,
          eq(entityVersions.entityId, entityId),
        ),
      ).toBe(2);
    } finally {
      await testDb
        .delete(desktopEditSessions)
        .where(eq(desktopEditSessions.id, sessionId));
    }
  });

  test("rejects a document-property write against a historical field", async () => {
    const entityId = await createEmptyEntity("document");
    const historical = await writeTestFile(entityId);
    if (Result.isError(historical)) {
      throw historical.error;
    }
    if (historical.value.status !== "ok") {
      throw new Error(`Initial write failed: ${historical.value.status}`);
    }
    const current = await writeTestFile(entityId);
    if (Result.isError(current)) {
      throw current.error;
    }
    if (current.value.status !== "ok") {
      throw new Error(`Current write failed: ${current.value.status}`);
    }

    const result = await updateDocumentProperties({
      fieldId: historical.value.fieldId,
      organizationId: ids.orgA,
      recordAuditEvent,
      safeDb,
      scopedDb,
      userId: ids.userA1,
      values: { author: "Historical author" },
      workspaceId: ids.wsA1,
    });

    expect(result).toMatchObject({ code: 404 });
    const after = await testDb.query.entities.findFirst({
      where: { id: { eq: entityId } },
      columns: { currentVersionId: true },
    });
    expect(after?.currentVersionId).toBe(current.value.entityVersionId);
    expect(
      await testDb.$count(
        entityVersions,
        eq(entityVersions.entityId, entityId),
      ),
    ).toBe(3);
  });

  test("preserves scan warnings on a version derived from current bytes", async () => {
    const entityId = await createEmptyEntity("document");
    const warnings = ["Contains VBA", "Contains an external relationship"];
    const uploaded = await writeTestFile(entityId, { scanWarnings: warnings });
    if (Result.isError(uploaded)) {
      throw uploaded.error;
    }
    if (uploaded.value.status !== "ok") {
      throw new Error(`Initial write failed: ${uploaded.value.status}`);
    }

    const derived = await writeTestFile(entityId, {
      scanWarnings: warnings,
      writePolicy: {
        type: "replace-current-file-from-version",
        expectedCurrentVersionId: uploaded.value.entityVersionId,
      },
    });
    if (Result.isError(derived)) {
      throw derived.error;
    }
    if (derived.value.status !== "ok") {
      throw new Error(`Derived write failed: ${derived.value.status}`);
    }

    const current = await testDb.query.entities.findFirst({
      where: { id: { eq: entityId } },
      with: { currentVersion: { with: { fields: true } } },
    });
    expect(current?.currentVersion?.fields.at(0)?.content).toMatchObject({
      type: "file",
      scanWarnings: warnings,
    });
  });
});
