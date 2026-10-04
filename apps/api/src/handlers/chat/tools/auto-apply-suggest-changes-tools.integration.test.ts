import { Result } from "better-result";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { eq } from "drizzle-orm";

import {
  FolioDocxReviewer,
  isFolioAIContentBlock,
} from "@stll/folio-core/server";

import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import { entities, entityVersions, fields, properties } from "@/api/db/schema";
import { createScopedDb } from "@/api/db/scoped";
import { envBase } from "@/api/env-base";
import { createAutoApplySuggestChangesTools } from "@/api/handlers/chat/tools/auto-apply-suggest-changes-tools";
import { SUGGEST_CHANGES_TOOL_NAME } from "@/api/handlers/chat/tools/folio-agent-tools";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { markdownToStellaDocx } from "@/api/lib/docx-authoring/from-markdown";
import type { createEntityVersionFromBuffer } from "@/api/lib/entity-versions/create-entity-version-from-buffer";
import type { ScanResult } from "@/api/lib/file-scan/types";
import { DOCX_MIME_TYPE } from "@/api/mime-types";
import { memberDocumentWriteAccess } from "@/api/tests/helpers/document-write-access";
import { startFakeS3 } from "@/api/tests/helpers/fake-s3";
import type { FakeS3 } from "@/api/tests/helpers/fake-s3";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { toSafeDbMock } from "@/api/tests/scoped-db-mock";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

// The automatic `suggest_changes` variant is registered with the file field
// id the client says it has open (`activeFile.fileFieldId`). Only the entity
// and its current version are resolved on the server, so the tool itself must
// refuse a field that is not a file of that entity's current version: one
// from another document in the same matter, from another matter of the same
// firm, or from another firm. Each foreign file below exists and its bytes
// sit where a read would find them, so a refusal is the boundary's doing,
// not a missing object's.

const bucket = envBase.S3_BUCKET;
const ORIGINAL_TEXT = "The quick brown fox jumps over the lazy dog.";

let testDb: TestDatabase;
let ids: TestIds;
let safeDb: SafeDb;
let fake: FakeS3;
let docx: ArrayBuffer;

type SeededFile = {
  entityId: SafeId<"entity">;
  fieldId: SafeId<"field">;
  fileId: string;
  versionId: SafeId<"entityVersion">;
  workspaceId: SafeId<"workspace">;
};

const newId = <T extends "entity" | "entityVersion" | "field" | "property">() =>
  toSafeId<T>(Bun.randomUUIDv7());

const seedFile = async ({
  propertyId,
  workspaceId,
}: {
  propertyId: SafeId<"property">;
  workspaceId: SafeId<"workspace">;
}): Promise<SeededFile> => {
  const file = {
    entityId: newId<"entity">(),
    fieldId: newId<"field">(),
    fileId: Bun.randomUUIDv7(),
    versionId: newId<"entityVersion">(),
    workspaceId,
  };
  await testDb.insert(entities).values({
    id: file.entityId,
    kind: "document",
    name: "agreement",
    workspaceId,
  });
  await testDb.insert(entityVersions).values({
    entityId: file.entityId,
    id: file.versionId,
    workspaceId,
  });
  await testDb.insert(fields).values({
    content: {
      encrypted: false,
      fileName: "agreement.docx",
      id: file.fileId,
      mimeType: DOCX_MIME_TYPE,
      pdfFileId: null,
      sha256Hex: "c".repeat(64),
      sizeBytes: docx.byteLength,
      type: "file",
      version: 1,
    },
    entityVersionId: file.versionId,
    id: file.fieldId,
    propertyId,
    workspaceId,
  });
  await testDb
    .update(entities)
    .set({ currentVersionId: file.versionId })
    .where(eq(entities.id, file.entityId));
  return file;
};

const objectKey = ({
  fileId,
  organizationId,
  workspaceId,
}: {
  fileId: string;
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
}) => `${organizationId}/${workspaceId}/${fileId}.docx`;

/** The document open in the chat: the file the tool may edit. */
let activeFile: SeededFile;
/** Another document in the same matter. */
let siblingFile: SeededFile;
/** A document in another matter of the same firm, which the caller can open. */
let otherMatterFile: SeededFile;
/** A read-only document in the open matter. */
let readOnlyFile: SeededFile;

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
  // The caller reaches both of the firm's matters, so only the tool's own
  // check, not matter access, keeps the other matter's file out.
  safeDb = toSafeDbMock(
    asTestRaw<ScopedDb>(
      createScopedDb(testDb, [ids.wsA1, ids.wsA2], ids.orgA, ids.userA1),
    ),
  );
  docx = Result.unwrap(await markdownToStellaDocx(ORIGINAL_TEXT));

  const otherMatterPropertyId = newId<"property">();
  await testDb.insert(properties).values({
    content: { type: "file", version: 1 },
    id: otherMatterPropertyId,
    name: "File A2",
    status: "fresh",
    tool: { type: "manual-input", version: 1 },
    workspaceId: ids.wsA2,
  });
  activeFile = await seedFile({
    propertyId: ids.filePropertyA1,
    workspaceId: ids.wsA1,
  });
  siblingFile = await seedFile({
    propertyId: ids.filePropertyA1,
    workspaceId: ids.wsA1,
  });
  otherMatterFile = await seedFile({
    propertyId: otherMatterPropertyId,
    workspaceId: ids.wsA2,
  });
  readOnlyFile = await seedFile({
    propertyId: ids.filePropertyA1,
    workspaceId: ids.wsA1,
  });
  await testDb
    .update(entities)
    .set({ readOnly: true })
    .where(eq(entities.id, readOnlyFile.entityId));
});

afterAll(async () => {
  await releaseRlsFixture();
});

beforeEach(() => {
  fake = startFakeS3();
  for (const file of [activeFile, siblingFile, otherMatterFile, readOnlyFile]) {
    fake.put(
      bucket,
      objectKey({ ...file, organizationId: ids.orgA }),
      new Uint8Array(docx),
      DOCX_MIME_TYPE,
    );
  }
  fake.put(
    bucket,
    objectKey({
      fileId: ids.fileObjectB1,
      organizationId: ids.orgB,
      workspaceId: ids.wsB1,
    }),
    new Uint8Array(docx),
    DOCX_MIME_TYPE,
  );
});

afterEach(() => {
  fake.stop();
});

const objectReads = () =>
  fake.requests.flatMap((request) =>
    request.method === "GET" ? [request.key] : [],
  );

/** Runs the automatic `suggest_changes` against the open document, with the
 *  field id the client sent. */
const suggestChanges = async (
  fileFieldId: SafeId<"field">,
  target: SeededFile = activeFile,
) => {
  const written: unknown[] = [];
  const createVersion: typeof createEntityVersionFromBuffer = async (input) => {
    written.push(input);
    return Result.ok({
      entityId: input.entityId,
      entityVersionId: newId<"entityVersion">(),
      fieldId: newId<"field">(),
      fileName: input.fileName,
      versionNumber: 2,
    });
  };
  const scanResult: ScanResult = { findings: [], verdict: "pass" };
  const tools = createAutoApplySuggestChangesTools({
    createEntityVersionFromBuffer: createVersion,
    docxEditRepresentation: "direct",
    access: memberDocumentWriteAccess({
      type: "new_version",
      workspaceId: target.workspaceId,
      entityId: target.entityId,
    }),
    expectedCurrentVersionId: target.versionId,
    fileFieldId,
    organizationId: ids.orgA,
    recordAuditEvent: async () => undefined,
    safeDb,
    scanFile: async () => Result.ok(scanResult),
    userId: ids.userA1,
  });
  const execute = tools[SUGGEST_CHANGES_TOOL_NAME].execute;
  if (!execute) {
    throw new Error("suggest_changes must be server-executed here");
  }
  const reviewer = await FolioDocxReviewer.fromBuffer(docx);
  const block = reviewer.snapshot().blocks.find(isFolioAIContentBlock);
  if (block === undefined) {
    throw new Error("Expected the fixture DOCX to have a text block");
  }
  const outcome = await Result.tryPromise({
    try: async () =>
      await execute(
        {
          documentVersion: target.versionId,
          operations: [
            {
              blockId: block.id,
              find: "quick",
              replace: "slow",
              type: "replaceInBlock",
            },
          ],
        },
        asTestRaw<Parameters<typeof execute>[1]>({}),
      ),
    catch: (error: unknown) => error,
  });
  return { outcome, reads: objectReads(), written };
};

describe("automatic suggest_changes with a client-sent file field", () => {
  test("edits the open document's own file", async () => {
    const { outcome, reads, written } = await suggestChanges(
      activeFile.fieldId,
    );

    expect(Result.isOk(outcome)).toBe(true);
    expect(outcome.unwrapOr(null)).toMatchObject({
      replacedFieldId: activeFile.fieldId,
      success: true,
    });
    expect(reads).toEqual([
      objectKey({ ...activeFile, organizationId: ids.orgA }),
    ]);
    expect(written).toEqual([
      expect.objectContaining({
        entityId: activeFile.entityId,
        workspaceId: activeFile.workspaceId,
        writePolicy: expect.objectContaining({
          replacedFileFieldId: activeFile.fieldId,
        }),
      }),
    ]);
  });

  test.each([
    ["another document in the same matter", () => siblingFile.fieldId],
    ["a document in another matter of the firm", () => otherMatterFile.fieldId],
    ["a document of another organization", () => ids.fileFieldB1],
  ])("refuses a field of %s, reading and writing nothing", async (_, field) => {
    const { outcome, reads, written } = await suggestChanges(field());

    expect(Result.isError(outcome)).toBe(true);
    expect(Result.isError(outcome) ? outcome.error : null).toMatchObject({
      message: "The active file field is not an editable DOCX file",
    });
    expect(reads).toEqual([]);
    expect(written).toEqual([]);
  });

  test("refuses a read-only document, reading and writing nothing", async () => {
    const { outcome, reads, written } = await suggestChanges(
      readOnlyFile.fieldId,
      readOnlyFile,
    );

    expect(Result.isError(outcome) ? outcome.error : null).toMatchObject({
      kind: "invalid-input",
      message: "Entity is read-only",
    });
    expect(reads).toEqual([]);
    expect(written).toEqual([]);
  });
});
