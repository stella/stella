import { Result } from "better-result";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import {
  FolioDocxReviewer,
  isFolioAIContentBlock,
} from "@stll/folio-core/server";

import {
  entityVersions,
  fields,
  fileChatThreads,
  pendingUploads,
} from "@/api/db/schema";
import { envBase } from "@/api/env-base";
import {
  createAutoApplySuggestChangesTools as createAutoApplySuggestChangesToolsWithDependencies,
  hasSuggestChangesApprovalResponse,
} from "@/api/handlers/chat/tools/auto-apply-suggest-changes-tools";
import type { CreateAutoApplySuggestChangesToolsProps } from "@/api/handlers/chat/tools/auto-apply-suggest-changes-tools";
import { SUGGEST_CHANGES_TOOL_NAME } from "@/api/handlers/chat/tools/folio-agent-tools";
import type { SafeId } from "@/api/lib/branded-types";
import { toSafeId } from "@/api/lib/branded-types";
import { markdownToStellaDocx } from "@/api/lib/docx-authoring/from-markdown";
import { createEntityVersionFromBuffer as createEntityVersionFromBufferWithDependencies } from "@/api/lib/entity-versions/create-entity-version-from-buffer";
import type { CreateEntityVersionFromBufferDependencies } from "@/api/lib/entity-versions/create-entity-version-from-buffer";
import { writeFileVersion } from "@/api/lib/entity-versions/write-file-version";
import type { ScanResult } from "@/api/lib/file-scan/types";
import { allocateFileObject } from "@/api/lib/files/file-object-ids";
import { createFileKey } from "@/api/lib/files/utils";
import { FILE_SIZE_LIMIT_BYTES } from "@/api/lib/limits";
import { createRootScopedDb } from "@/api/lib/root-scoped-db";
import { DOCX_MIME_TYPE } from "@/api/mime-types";
import { startFakeS3 } from "@/api/tests/helpers/fake-s3";
import type { FakeS3 } from "@/api/tests/helpers/fake-s3";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

const processExtractionMock = mock(async () => {});
const enqueueImageThumbnailOrMarkFailedMock = mock(async () => {});
const enqueuePdfDerivativeOrMarkFailedMock = mock(async () => {});
const computeVersionDiffStatsMock = mock(async () => {});
const broadcastMock = mock(() => {});
const requestNativeExtractionRunMock = mock(async () => null);
let fileScanResult: ScanResult = { verdict: "pass", findings: [] };
const scanFileMock = mock(async () => Result.ok(fileScanResult));

const getScanWarningsForTest = (scanResult: ScanResult) =>
  scanResult.verdict === "warn"
    ? scanResult.findings.flatMap((finding) =>
        finding.severity === "warn" ? [finding.message] : [],
      )
    : null;

const createVersionDependencies = {
  allocateFileObject,
  createFileKey,
  writeFileVersion,
  processExtraction: processExtractionMock,
  requestNativeExtractionRun: requestNativeExtractionRunMock,
  enqueuePdfDerivativeOrMarkFailed: enqueuePdfDerivativeOrMarkFailedMock,
  enqueueImageThumbnailOrMarkFailed: enqueueImageThumbnailOrMarkFailedMock,
  computeVersionDiffStats: computeVersionDiffStatsMock,
  createRootScopedDb,
  broadcast: broadcastMock,
} satisfies CreateEntityVersionFromBufferDependencies;

const createEntityVersionFromBuffer: typeof createEntityVersionFromBufferWithDependencies =
  async (input) =>
    await createEntityVersionFromBufferWithDependencies({
      ...input,
      dependencies: createVersionDependencies,
    });

const createAutoApplySuggestChangesTools = (
  props: CreateAutoApplySuggestChangesToolsProps,
) =>
  createAutoApplySuggestChangesToolsWithDependencies({
    ...props,
    createEntityVersionFromBuffer,
    getScanWarnings: getScanWarningsForTest,
    scanFile: scanFileMock,
  });

const organizationId = toSafeId<"organization">(
  "00000000-0000-0000-0000-000000000001",
);
const workspaceId = toSafeId<"workspace">(
  "00000000-0000-0000-0000-000000000002",
);
const userId = toSafeId<"user">("00000000-0000-0000-0000-000000000003");
const entityId = toSafeId<"entity">("00000000-0000-0000-0000-000000000004");
const propertyId = toSafeId<"property">("00000000-0000-0000-0000-000000000005");
const fileFieldId = toSafeId<"field">("00000000-0000-0000-0000-000000000007");
const otherFileFieldId = toSafeId<"field">(
  "00000000-0000-0000-0000-000000000008",
);
const otherPropertyId = toSafeId<"property">(
  "00000000-0000-0000-0000-000000000009",
);
const entityVersionId = toSafeId<"entityVersion">(
  "00000000-0000-0000-0000-000000000006",
);
/** The file object the active DOCX field names, and its sibling field's. */
const activeFileId = "00000000-0000-0000-0000-000000000012";
const otherFileId = "00000000-0000-0000-0000-000000000011";
const newerEntityVersionId = toSafeId<"entityVersion">(
  "00000000-0000-0000-0000-000000000010",
);

const ORIGINAL_TEXT = "The quick brown fox jumps over the lazy dog.";

const bucket = envBase.S3_BUCKET;
/** The key the loader derives from the active file field. */
const activeObjectKey = `${organizationId}/${workspaceId}/${activeFileId}.docx`;
let fake: FakeS3;
let sourceDocx: ArrayBuffer = new ArrayBuffer(0);

/**
 * Put the entity's current DOCX where the loader will look for it: a read of
 * any other key misses the store instead of being served the same bytes.
 */
const seedSourceDocx = async (): Promise<ArrayBuffer> => {
  const docx = Result.unwrap(await markdownToStellaDocx(ORIGINAL_TEXT));
  fake.put(bucket, activeObjectKey, new Uint8Array(docx), DOCX_MIME_TYPE);
  return docx;
};

const requestKeys = (method: "DELETE" | "GET" | "PUT"): string[] =>
  fake.requests.flatMap((request) =>
    request.method === method ? [request.key] : [],
  );

/**
 * The first block that carries text. The snapshot lists every paragraph, and
 * the preset the fixture is authored from opens with a blank one.
 */
const firstBlock = async (buffer: ArrayBuffer) => {
  const reviewer = await FolioDocxReviewer.fromBuffer(buffer);
  const snapshot = reviewer.snapshot();
  const block = snapshot.blocks.find(isFolioAIContentBlock);
  if (!block) {
    throw new Error("Expected the fixture DOCX to have at least one block");
  }
  return block;
};

/** The version the edit persisted, read back out of the store. */
const writtenDocx = (): ArrayBuffer => {
  const key = requestKeys("PUT").at(0);
  const stored =
    key === undefined ? undefined : fake.objects.get(`${bucket}/${key}`);
  if (stored === undefined) {
    throw new Error("Expected the edited document to be written to the store");
  }
  const buffer = new ArrayBuffer(stored.bytes.byteLength);
  new Uint8Array(buffer).set(stored.bytes);
  return buffer;
};

type BuildTxOptions = {
  loadedCurrentVersionId?: SafeId<"entityVersion">;
  lockedCurrentVersionId?: SafeId<"entityVersion">;
  openDesktopEditSession?: boolean;
  preferredName?: string | null;
  name?: string;
  readOnly?: boolean;
};

const buildTx = ({
  loadedCurrentVersionId = entityVersionId,
  lockedCurrentVersionId = entityVersionId,
  openDesktopEditSession = false,
  preferredName = null,
  name = "Fallback Name",
  readOnly = false,
}: BuildTxOptions = {}) => {
  const insertedTables: unknown[] = [];
  const updatedTables: { table: unknown; values: unknown }[] = [];

  const entitiesSelect = {
    from: () => ({
      where: () => ({
        limit: () => ({
          for: async () => [
            {
              currentVersionId: lockedCurrentVersionId,
              docSequence: null,
              kind: "document",
              readOnly,
            },
          ],
        }),
      }),
    }),
  };
  const cellMetadataSelect = {
    from: () => ({
      where: () => ({
        for: async () => [],
      }),
    }),
  };
  // `nextEntityVersionNumber`'s `.select({ max }).from(entityVersions).where(...)`
  // -- no `.limit()`/`.for()` in that chain, unlike the other two selects.
  const maxVersionNumberSelect = {
    from: () => ({
      where: async () => [{ max: 1 }],
    }),
  };
  const editSessionSelect = {
    from: () => ({
      where: () => ({
        limit: async () =>
          openDesktopEditSession ? [{ id: "open-edit-session" }] : [],
      }),
    }),
  };
  const workspaceStatusSelect = {
    from: () => ({
      where: () => ({
        limit: () => ({
          for: async () => [{ status: "active" }],
        }),
      }),
    }),
  };

  const tx = {
    query: {
      user: {
        findFirst: async () => ({ name, preferredName }),
      },
      entities: {
        findFirst: async () => ({
          currentVersionId: loadedCurrentVersionId,
          readOnly,
        }),
      },
      entityVersions: {
        findFirst: async () => ({
          id: loadedCurrentVersionId,
          fields: [
            {
              id: otherFileFieldId,
              content: {
                type: "file",
                id: otherFileId,
                fileName: "other.docx",
                mimeType:
                  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                sizeBytes: 100,
                encrypted: false,
                sha256Hex: "feedface",
                version: 1,
                pdfFileId: null,
                pdfDerivative: { status: "not-required" },
                thumbnailFileId: null,
                thumbnailDerivative: { status: "not-required" },
              },
              propertyId: otherPropertyId,
            },
            {
              id: fileFieldId,
              content: {
                type: "file",
                id: activeFileId,
                fileName: "document.docx",
                mimeType:
                  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                sizeBytes: 100,
                encrypted: false,
                sha256Hex: "deadbeef",
                version: 1,
                pdfFileId: null,
                pdfDerivative: { status: "not-required" },
                thumbnailFileId: null,
                thumbnailDerivative: { status: "not-required" },
              },
              propertyId,
            },
          ],
        }),
      },
      workspaces: {
        findFirst: async () => ({ reference: null, status: "active" }),
      },
    },
    select: (selectedFields: Record<string, unknown>) => {
      if ("status" in selectedFields) {
        return workspaceStatusSelect;
      }
      if ("metadata" in selectedFields) {
        return cellMetadataSelect;
      }
      if ("max" in selectedFields) {
        return maxVersionNumberSelect;
      }
      if ("currentVersionId" in selectedFields) {
        return entitiesSelect;
      }
      return editSessionSelect;
    },
    execute: async () => undefined,
    insert: (table: unknown) => ({
      values: (values: unknown) => {
        insertedTables.push({ table, values });
        if (table === pendingUploads) {
          return {
            returning: async () => [{ id: "intent_1" }],
          };
        }
        return undefined;
      },
    }),
    update: (table: unknown) => ({
      set: (values: unknown) => ({
        where: () => {
          updatedTables.push({ table, values });
          if (table === pendingUploads) {
            return {
              returning: async () => [{ id: "intent_1" }],
            };
          }
          return undefined;
        },
      }),
    }),
    delete: () => ({ where: async () => undefined }),
  };

  return { tx, insertedTables, updatedTables };
};

describe("createAutoApplySuggestChangesTools", () => {
  beforeEach(() => {
    fake = startFakeS3();
    processExtractionMock.mockClear();
    enqueueImageThumbnailOrMarkFailedMock.mockClear();
    enqueuePdfDerivativeOrMarkFailedMock.mockClear();
    computeVersionDiffStatsMock.mockClear();
    broadcastMock.mockClear();
    scanFileMock.mockClear();
    fileScanResult = { verdict: "pass", findings: [] };
  });

  afterEach(() => {
    fake.stop();
  });

  test("rejects an oversized edited DOCX before writing bytes", async () => {
    const { tx, insertedTables } = buildTx();
    const { safeDb } = createScopedDbMock(tx);

    const result = await createEntityVersionFromBuffer({
      safeDb,
      organizationId,
      workspaceId,
      entityId,
      userId,
      recordAuditEvent: async () => undefined,
      buffer: new ArrayBuffer(FILE_SIZE_LIMIT_BYTES.document + 1),
      fileName: "oversized.docx",
      mimeType:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      source: null,
      writePolicy: {
        type: "automatic-docx-edit",
        expectedCurrentVersionId: entityVersionId,
        filePropertyId: propertyId,
        replacedFileFieldId: fileFieldId,
      },
    });

    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error).toMatchObject({ code: "document-too-large" });
    }
    expect(requestKeys("PUT")).toEqual([]);
    expect(insertedTables).toEqual([]);
  });

  test("registers a single server-executed suggest_changes tool", () => {
    const { tx } = buildTx({ preferredName: "Jana Nováková" });
    const { safeDb } = createScopedDbMock(tx);
    const tools = createAutoApplySuggestChangesTools({
      safeDb,
      organizationId,
      userId,
      workspaceId,
      entityId,
      fileFieldId,
      recordAuditEvent: async () => undefined,
      docxEditRepresentation: "tracked-changes",
      expectedCurrentVersionId: entityVersionId,
    });

    expect(Object.keys(tools)).toEqual([SUGGEST_CHANGES_TOOL_NAME]);
    const tool = tools[SUGGEST_CHANGES_TOOL_NAME];
    expect(tool.needsApproval).toBeUndefined();
    expect(tool.execute).toBeDefined();
  });

  test("returns a structured author_name_required outcome (no version written) when no author name is configured", async () => {
    const { tx } = buildTx({ preferredName: null, name: "   " });
    const { safeDb } = createScopedDbMock(tx);
    sourceDocx = await seedSourceDocx();
    const tools = createAutoApplySuggestChangesTools({
      safeDb,
      organizationId,
      userId,
      workspaceId,
      entityId,
      fileFieldId,
      recordAuditEvent: async () => undefined,
      docxEditRepresentation: "tracked-changes",
      expectedCurrentVersionId: entityVersionId,
    });
    const execute = tools[SUGGEST_CHANGES_TOOL_NAME].execute;
    if (!execute) {
      throw new Error("suggest_changes must be server-executed here");
    }

    const block = await firstBlock(sourceDocx);
    const result = await execute(
      {
        documentVersion: entityVersionId,
        operations: [
          {
            type: "replaceInBlock",
            blockId: block.id,
            find: "quick",
            replace: "slow",
          },
        ],
      },
      asTestRaw<Parameters<typeof execute>[1]>({}),
    );

    // A stable, client-branchable code -- not a thrown ChatToolError -- so
    // the chat client can detect it and open a "set your name" modal
    // instead of showing a generic error.
    expect(result).toEqual({
      success: false,
      code: "author_name_required",
      message: expect.stringMatching(/preferred name/iu),
      retryable: true,
    });
    expect(requestKeys("PUT")).toEqual([]);
  });

  test("direct mode requires an author for every comment-producing operation", async () => {
    const { tx } = buildTx({ preferredName: null, name: "   " });
    const { safeDb } = createScopedDbMock(tx);
    sourceDocx = await seedSourceDocx();
    const tools = createAutoApplySuggestChangesTools({
      safeDb,
      organizationId,
      userId,
      workspaceId,
      entityId,
      fileFieldId,
      recordAuditEvent: async () => undefined,
      docxEditRepresentation: "direct",
      expectedCurrentVersionId: entityVersionId,
    });
    const execute = tools[SUGGEST_CHANGES_TOOL_NAME].execute;
    if (!execute) {
      throw new Error("suggest_changes must be server-executed here");
    }

    const block = await firstBlock(sourceDocx);
    const results = await Promise.all([
      execute(
        {
          documentVersion: entityVersionId,
          operations: [
            {
              id: "comment-range",
              type: "commentOnRange",
              range: {
                type: "textRange",
                story: "main",
                blockId: block.id,
                startOffset: 0,
                endOffset: 3,
                selectedTextHash: "h1a2b3",
              },
              comment: { text: "Range comment" },
            },
          ],
        },
        asTestRaw<Parameters<typeof execute>[1]>({}),
      ),
      execute(
        {
          documentVersion: entityVersionId,
          operations: [
            {
              id: "edit-comment",
              type: "replaceInBlock",
              blockId: block.id,
              find: "quick",
              replace: "slow",
              comment: { text: "Edit comment" },
            },
          ],
        },
        asTestRaw<Parameters<typeof execute>[1]>({}),
      ),
    ]);

    for (const result of results) {
      expect(result).toMatchObject({
        success: false,
        code: "author_name_required",
      });
    }
    expect(requestKeys("PUT")).toEqual([]);
  });

  test("tracked-changes mode writes a new version with the configured author attributed on the revision", async () => {
    fileScanResult = {
      verdict: "warn",
      findings: [
        {
          message: "External relationship preserved",
          rule: "external-relationship",
          severity: "warn",
        },
      ],
    };
    const { tx, insertedTables, updatedTables } = buildTx({
      preferredName: "Jana Nováková",
    });
    const { safeDb } = createScopedDbMock(tx);
    sourceDocx = await seedSourceDocx();
    const recordedAuditEvents: unknown[] = [];
    const tools = createAutoApplySuggestChangesTools({
      safeDb,
      organizationId,
      userId,
      workspaceId,
      entityId,
      fileFieldId,
      recordAuditEvent: async (_tx, event) => {
        recordedAuditEvents.push(event);
      },
      docxEditRepresentation: "tracked-changes",
      expectedCurrentVersionId: entityVersionId,
    });
    const execute = tools[SUGGEST_CHANGES_TOOL_NAME].execute;
    if (!execute) {
      throw new Error("suggest_changes must be server-executed here");
    }

    const block = await firstBlock(sourceDocx);
    const result = await execute(
      {
        documentVersion: entityVersionId,
        operations: [
          {
            type: "replaceInBlock",
            blockId: block.id,
            find: "quick",
            replace: "slow",
          },
        ],
      },
      asTestRaw<Parameters<typeof execute>[1]>({}),
    );

    if (!result.success) {
      throw new Error(`Expected success, got: ${result.message}`);
    }
    expect(result).toMatchObject({
      fieldId: expect.any(String),
      representation: "tracked-changes",
      replacedFieldId: fileFieldId,
      applied: [{ id: expect.stringMatching(/^op-/u) }],
      skipped: [],
    });
    expect(result.fieldId).not.toBe(fileFieldId);
    expect(updatedTables).toContainEqual({
      table: fileChatThreads,
      values: { fieldId: result.fieldId },
    });
    const fieldsInsert = insertedTables.find(
      (entry) =>
        typeof entry === "object" &&
        entry !== null &&
        "table" in entry &&
        entry.table === fields,
    );
    expect(fieldsInsert).toMatchObject({
      values: expect.arrayContaining([
        expect.objectContaining({
          content: expect.objectContaining({
            scanWarnings: ["External relationship preserved"],
          }),
          propertyId,
        }),
      ]),
    });
    expect(scanFileMock).toHaveBeenCalledTimes(1);
    expect(requestKeys("PUT")).toHaveLength(1);
    // The new version lands tenant-scoped and typed as a DOCX, so it serves
    // back as an editable document rather than an opaque download.
    const writtenKey = requestKeys("PUT").at(0) ?? "";
    expect(writtenKey).toStartWith(`${organizationId}/${workspaceId}/`);
    expect(fake.objects.get(`${bucket}/${writtenKey}`)?.contentType).toBe(
      DOCX_MIME_TYPE,
    );
    expect(recordedAuditEvents).toHaveLength(1);

    // The written bytes differ from the source, and re-parsing shows a
    // tracked revision authored with the resolved preferred name -- never a
    // fabricated "Stella AI"/"AI" placeholder.
    const writtenArrayBuffer = writtenDocx();
    expect(writtenArrayBuffer).not.toEqual(sourceDocx);

    const reviewer = await FolioDocxReviewer.fromBuffer(writtenArrayBuffer);
    const changes = reviewer.getChanges();
    expect(changes.length).toBeGreaterThan(0);
    for (const change of changes) {
      expect(change.author).toBe("Jana Nováková");
    }

    expect(insertedTables.length).toBeGreaterThan(0);
    // The active field's object was read, never the sibling field's.
    expect(requestKeys("GET")).toEqual([activeObjectKey]);
    expect(computeVersionDiffStatsMock).toHaveBeenCalledTimes(1);
    expect(processExtractionMock).toHaveBeenCalledWith(entityId, {
      filePropertyId: propertyId,
    });
    expect(recordedAuditEvents).toEqual([
      [
        expect.objectContaining({ workspaceId }),
        expect.objectContaining({ workspaceId }),
      ],
    ]);
  });

  test("tolerates a stray operation key and reports it as a normalization", async () => {
    const { tx } = buildTx({ preferredName: "Jana Nováková" });
    const { safeDb } = createScopedDbMock(tx);
    sourceDocx = await seedSourceDocx();
    const tools = createAutoApplySuggestChangesTools({
      safeDb,
      organizationId,
      userId,
      workspaceId,
      entityId,
      fileFieldId,
      recordAuditEvent: async () => undefined,
      docxEditRepresentation: "tracked-changes",
      expectedCurrentVersionId: entityVersionId,
    });
    const execute = tools[SUGGEST_CHANGES_TOOL_NAME].execute;
    if (!execute) {
      throw new Error("suggest_changes must be server-executed here");
    }

    const block = await firstBlock(sourceDocx);
    const result = await execute(
      {
        documentVersion: entityVersionId,
        operations: [
          {
            id: "op-1",
            type: "replaceInBlock",
            blockId: block.id,
            find: "quick",
            replace: "slow",
            typoKey: true,
          },
        ],
      },
      asTestRaw<Parameters<typeof execute>[1]>({}),
    );

    if (!result.success) {
      throw new Error(`Expected success, got: ${result.message}`);
    }
    // Folio drops the key instead of failing the batch, and reports what it
    // ignored so the next call carries the documented shape.
    expect(result.applied).toEqual([{ id: "op-1" }]);
    expect(result.normalizations).toContainEqual({
      path: "operations[0].typoKey",
      message: expect.stringContaining("typoKey"),
    });
  });

  test("rejects edited bytes that fail the security scan", async () => {
    fileScanResult = {
      verdict: "reject",
      findings: [
        {
          message: "Embedded executable content",
          rule: "embedded-executable",
          severity: "reject",
        },
      ],
    };
    const { tx, insertedTables } = buildTx({ preferredName: "Jana Nováková" });
    const { safeDb } = createScopedDbMock(tx);
    sourceDocx = await seedSourceDocx();
    const tools = createAutoApplySuggestChangesTools({
      safeDb,
      organizationId,
      userId,
      workspaceId,
      entityId,
      fileFieldId,
      recordAuditEvent: async () => undefined,
      docxEditRepresentation: "tracked-changes",
      expectedCurrentVersionId: entityVersionId,
    });
    const execute = tools[SUGGEST_CHANGES_TOOL_NAME].execute;
    if (!execute) {
      throw new Error("suggest_changes must be server-executed here");
    }

    const block = await firstBlock(sourceDocx);
    let rejection: unknown;
    try {
      await execute(
        {
          documentVersion: entityVersionId,
          operations: [
            {
              type: "replaceInBlock",
              blockId: block.id,
              find: "quick",
              replace: "slow",
            },
          ],
        },
        asTestRaw<Parameters<typeof execute>[1]>({}),
      );
    } catch (error: unknown) {
      rejection = error;
    }
    expect(rejection).toBeInstanceOf(Error);
    expect(rejection instanceof Error ? rejection.message : "").toContain(
      "Embedded executable content",
    );
    expect(insertedTables).toEqual([]);
    expect(requestKeys("PUT")).toEqual([]);
  });

  test("surfaces object-storage failures as a sanitized tool error", async () => {
    const { tx, insertedTables } = buildTx({
      preferredName: "Jana Nováková",
    });
    const { safeDb } = createScopedDbMock(tx);
    sourceDocx = await seedSourceDocx();
    // Every write attempt is rejected by the store, retries included.
    fake.failNext({
      method: "PUT",
      code: "InternalError",
      status: 500,
      times: 20,
    });
    const tools = createAutoApplySuggestChangesTools({
      safeDb,
      organizationId,
      userId,
      workspaceId,
      entityId,
      fileFieldId,
      recordAuditEvent: async () => undefined,
      docxEditRepresentation: "tracked-changes",
      expectedCurrentVersionId: entityVersionId,
    });
    const execute = tools[SUGGEST_CHANGES_TOOL_NAME].execute;
    if (!execute) {
      throw new Error("suggest_changes must be server-executed here");
    }
    const block = await firstBlock(sourceDocx);

    const rejection = await Promise.resolve(
      execute(
        {
          documentVersion: entityVersionId,
          operations: [
            {
              id: "op-1",
              type: "replaceInBlock",
              blockId: block.id,
              find: "quick",
              replace: "slow",
            },
          ],
        },
        asTestRaw<Parameters<typeof execute>[1]>({}),
      ),
    ).then(
      () => null,
      (error: unknown) => error,
    );

    expect(rejection).toMatchObject({
      kind: "server-defect",
      message: "The edited document could not be persisted",
    });
    // The store's own rejection (code, key, endpoint) stays out of the
    // message the model and the user see.
    expect(rejection instanceof Error ? rejection.message : "").not.toMatch(
      /InternalError|127\.0\.0\.1/u,
    );
    expect(insertedTables).toEqual([
      expect.objectContaining({ table: pendingUploads }),
    ]);
    expect(requestKeys("DELETE")).toHaveLength(1);
  });

  test("direct mode applies without tracked-changes markup", async () => {
    // Direct text rewrites create no authored revision, so a missing account
    // name must not block them with the tracked-changes name dialog.
    const { tx } = buildTx({ preferredName: null, name: "   " });
    const { safeDb } = createScopedDbMock(tx);
    sourceDocx = await seedSourceDocx();
    const tools = createAutoApplySuggestChangesTools({
      safeDb,
      organizationId,
      userId,
      workspaceId,
      entityId,
      fileFieldId,
      recordAuditEvent: async () => undefined,
      docxEditRepresentation: "direct",
      expectedCurrentVersionId: entityVersionId,
    });
    const execute = tools[SUGGEST_CHANGES_TOOL_NAME].execute;
    if (!execute) {
      throw new Error("suggest_changes must be server-executed here");
    }

    const block = await firstBlock(sourceDocx);
    const result = await execute(
      {
        documentVersion: entityVersionId,
        operations: [
          {
            id: "op-1",
            type: "replaceInBlock",
            blockId: block.id,
            find: "quick",
            replace: "slow",
          },
        ],
      },
      asTestRaw<Parameters<typeof execute>[1]>({}),
    );

    if (!result.success) {
      throw new Error(`Expected success, got: ${result.message}`);
    }
    expect(result.representation).toBe("direct");

    const writtenArrayBuffer = writtenDocx();
    const reviewer = await FolioDocxReviewer.fromBuffer(writtenArrayBuffer);
    // Direct mode edits in place: no tracked-change revisions at all.
    expect(reviewer.getChanges()).toEqual([]);
    const content = reviewer.getContentAsText();
    expect(content).toContain("slow");
    expect(content).not.toContain("quick brown");
  });

  test("an all-skipped batch writes no version and reports the skip reason", async () => {
    const { tx } = buildTx({ preferredName: "Jana Nováková" });
    const { safeDb } = createScopedDbMock(tx);
    sourceDocx = await seedSourceDocx();
    const tools = createAutoApplySuggestChangesTools({
      safeDb,
      organizationId,
      userId,
      workspaceId,
      entityId,
      fileFieldId,
      recordAuditEvent: async () => undefined,
      docxEditRepresentation: "tracked-changes",
      expectedCurrentVersionId: entityVersionId,
    });
    const execute = tools[SUGGEST_CHANGES_TOOL_NAME].execute;
    if (!execute) {
      throw new Error("suggest_changes must be server-executed here");
    }

    const block = await firstBlock(sourceDocx);
    const rejection = await Promise.resolve(
      execute(
        {
          documentVersion: entityVersionId,
          operations: [
            {
              id: "op-1",
              type: "replaceInBlock",
              blockId: block.id,
              // Text that does not exist in the block: the op is skipped
              // (missingFind), never silently dropped.
              find: "this text is not in the document",
              replace: "slow",
            },
          ],
        },
        asTestRaw<Parameters<typeof execute>[1]>({}),
      ),
    ).then(
      () => null,
      (error: unknown) => error,
    );

    expect(rejection).toBeInstanceOf(Error);
    const skippedMessage = rejection instanceof Error ? rejection.message : "";
    // Folio explains the skip in prose keyed by operation id, not as a
    // machine code the model would have to decode.
    expect(skippedMessage).toContain("No operations could be applied");
    expect(skippedMessage).toContain(
      "op-1: `find` was not found in this block",
    );
    expect(requestKeys("PUT")).toEqual([]);
  });

  test("rejects automatic write-back while a live edit session exists", async () => {
    const { tx, insertedTables } = buildTx({
      openDesktopEditSession: true,
      preferredName: "Jana Nováková",
    });
    const { safeDb } = createScopedDbMock(tx);
    sourceDocx = await seedSourceDocx();
    const tools = createAutoApplySuggestChangesTools({
      safeDb,
      organizationId,
      userId,
      workspaceId,
      entityId,
      fileFieldId,
      recordAuditEvent: async () => undefined,
      docxEditRepresentation: "tracked-changes",
      expectedCurrentVersionId: entityVersionId,
    });
    const execute = tools[SUGGEST_CHANGES_TOOL_NAME].execute;
    if (!execute) {
      throw new Error("suggest_changes must be server-executed here");
    }
    const block = await firstBlock(sourceDocx);

    const rejection = await Promise.resolve(
      execute(
        {
          documentVersion: entityVersionId,
          operations: [
            {
              id: "op-1",
              type: "replaceInBlock",
              blockId: block.id,
              find: "quick",
              replace: "slow",
            },
          ],
        },
        asTestRaw<Parameters<typeof execute>[1]>({}),
      ),
    ).then(
      () => null,
      (error: unknown) => error,
    );

    expect(rejection).toBeInstanceOf(Error);
    expect(rejection instanceof Error ? rejection.message : "").toMatch(
      /active edit session/iu,
    );
    expect(insertedTables).toEqual([
      expect.objectContaining({ table: pendingUploads }),
    ]);
    expect(insertedTables).not.toContainEqual(
      expect.objectContaining({ table: entityVersions }),
    );
    expect(requestKeys("DELETE")).toHaveLength(1);
  });

  test("rejects a stale write when the current version changes during apply", async () => {
    const { tx, insertedTables } = buildTx({
      lockedCurrentVersionId: newerEntityVersionId,
      preferredName: "Jana Nováková",
    });
    const { safeDb } = createScopedDbMock(tx);
    sourceDocx = await seedSourceDocx();
    const recordedAuditEvents: unknown[] = [];
    const tools = createAutoApplySuggestChangesTools({
      safeDb,
      organizationId,
      userId,
      workspaceId,
      entityId,
      fileFieldId,
      recordAuditEvent: async (_tx, event) => {
        recordedAuditEvents.push(event);
      },
      docxEditRepresentation: "tracked-changes",
      expectedCurrentVersionId: entityVersionId,
    });
    const execute = tools[SUGGEST_CHANGES_TOOL_NAME].execute;
    if (!execute) {
      throw new Error("suggest_changes must be server-executed here");
    }
    const block = await firstBlock(sourceDocx);

    const rejection = await Promise.resolve(
      execute(
        {
          documentVersion: entityVersionId,
          operations: [
            {
              id: "op-1",
              type: "replaceInBlock",
              blockId: block.id,
              find: "quick",
              replace: "slow",
            },
          ],
        },
        asTestRaw<Parameters<typeof execute>[1]>({}),
      ),
    ).then(
      () => null,
      (error: unknown) => error,
    );

    expect(rejection).toBeInstanceOf(Error);
    expect(rejection instanceof Error ? rejection.message : "").toMatch(
      /changed while edits were being applied/iu,
    );
    expect(insertedTables).toEqual([
      expect.objectContaining({ table: pendingUploads }),
    ]);
    expect(insertedTables).not.toContainEqual(
      expect.objectContaining({ table: entityVersions }),
    );
    expect(recordedAuditEvents).toEqual([]);
    expect(requestKeys("DELETE")).toHaveLength(1);
  });

  test("rejects a tool call whose documentVersion is not the loaded version", async () => {
    const { tx } = buildTx({ preferredName: "Jana Nováková" });
    const { safeDb } = createScopedDbMock(tx);
    sourceDocx = await seedSourceDocx();
    const tools = createAutoApplySuggestChangesTools({
      safeDb,
      organizationId,
      userId,
      workspaceId,
      entityId,
      fileFieldId,
      recordAuditEvent: async () => undefined,
      docxEditRepresentation: "tracked-changes",
      expectedCurrentVersionId: entityVersionId,
    });
    const execute = tools[SUGGEST_CHANGES_TOOL_NAME].execute;
    if (!execute) {
      throw new Error("suggest_changes must be server-executed here");
    }

    const block = await firstBlock(sourceDocx);
    const rejection = await Promise.resolve(
      execute(
        {
          // A version the model never read the document at: folio's
          // batch-level pin skips every operation before anything applies.
          documentVersion: newerEntityVersionId,
          operations: [
            {
              id: "op-1",
              type: "replaceInBlock",
              blockId: block.id,
              find: "quick",
              replace: "slow",
            },
          ],
        },
        asTestRaw<Parameters<typeof execute>[1]>({}),
      ),
    ).then(
      () => null,
      (error: unknown) => error,
    );

    expect(rejection).toMatchObject({ kind: "invalid-input" });
    const message = rejection instanceof Error ? rejection.message : "";
    expect(message).toContain("No operations could be applied");
    expect(message).toContain(
      "the document changed after these edits were proposed",
    );
    expect(requestKeys("PUT")).toEqual([]);
  });

  test("rejects an approved edit when the document changed after proposal", async () => {
    const { tx } = buildTx({
      loadedCurrentVersionId: newerEntityVersionId,
      preferredName: "Jana Nováková",
    });
    const { safeDb } = createScopedDbMock(tx);
    sourceDocx = await seedSourceDocx();
    const tools = createAutoApplySuggestChangesTools({
      safeDb,
      organizationId,
      userId,
      workspaceId,
      entityId,
      fileFieldId,
      recordAuditEvent: async () => undefined,
      docxEditRepresentation: "tracked-changes",
      expectedCurrentVersionId: entityVersionId,
    });
    const execute = tools[SUGGEST_CHANGES_TOOL_NAME].execute;
    if (!execute) {
      throw new Error("suggest_changes must be server-executed here");
    }

    const rejection = await Promise.resolve(
      execute(
        {
          documentVersion: entityVersionId,
          operations: [
            {
              id: "op-1",
              type: "deleteBlock",
              blockId: "b-1",
            },
          ],
        },
        asTestRaw<Parameters<typeof execute>[1]>({}),
      ),
    ).then(
      () => null,
      (error: unknown) => error,
    );

    expect(rejection).toMatchObject({ kind: "invalid-input" });
    expect(rejection instanceof Error ? rejection.message : "").toContain(
      "the document changed after these edits were proposed",
    );
    expect(requestKeys("PUT")).toEqual([]);
  });
});

describe("hasSuggestChangesApprovalResponse", () => {
  const part = (overrides: Record<string, unknown>) => ({
    type: "tool-call",
    name: SUGGEST_CHANGES_TOOL_NAME,
    state: "approval-responded",
    ...overrides,
  });

  test("detects an answered approval request on suggest_changes", () => {
    expect(hasSuggestChangesApprovalResponse([part({})])).toBe(true);
  });

  test("ignores other states, other tools, and non-object parts", () => {
    expect(
      hasSuggestChangesApprovalResponse([
        part({ state: "approval-requested" }),
      ]),
    ).toBe(false);
    expect(
      hasSuggestChangesApprovalResponse([part({ name: "add_comment" })]),
    ).toBe(false);
    expect(hasSuggestChangesApprovalResponse([part({ type: "text" })])).toBe(
      false,
    );
    expect(
      hasSuggestChangesApprovalResponse(["approval-responded", null]),
    ).toBe(false);
    expect(hasSuggestChangesApprovalResponse([])).toBe(false);
  });
});
