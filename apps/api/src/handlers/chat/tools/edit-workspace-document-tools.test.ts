import { Result } from "better-result";
import { beforeEach, describe, expect, mock, test } from "bun:test";

import { FolioDocxReviewer } from "@stll/folio-core/server";

import { fields, fileChatThreads } from "@/api/db/schema";
import { markdownToStellaDocx } from "@/api/handlers/chat/tools/create-workspace-document-tools";
import type { SafeId } from "@/api/lib/branded-types";
import { toSafeId } from "@/api/lib/branded-types";
import type { ScanResult } from "@/api/lib/file-scan/types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

const s3WriteMock = mock(async (_key: string, _bytes: Uint8Array) => {});
const s3DeleteMock = mock(async () => {});
let s3FileBuffer: ArrayBuffer = new ArrayBuffer(0);
const s3ReadKeys: string[] = [];
const processExtractionMock = mock(async () => {});
const enqueueImageThumbnailOrMarkFailedMock = mock(async () => {});
const enqueuePdfDerivativeOrMarkFailedMock = mock(async () => {});
const computeVersionDiffStatsMock = mock(async () => {});
const broadcastMock = mock(() => {});
let fileScanResult: ScanResult = { verdict: "pass", findings: [] };
const scanFileMock = mock(async () => Result.ok(fileScanResult));

void mock.module("@/api/lib/s3", () => ({
  getS3: () => ({
    write: s3WriteMock,
    delete: s3DeleteMock,
    file: (key: string) => {
      s3ReadKeys.push(key);
      return { arrayBuffer: async () => s3FileBuffer };
    },
  }),
}));
void mock.module("@/api/lib/search/process-extraction", () => ({
  processExtraction: processExtractionMock,
}));
void mock.module("@/api/lib/file-derivative-queue", () => ({
  enqueueImageThumbnailOrMarkFailed: enqueueImageThumbnailOrMarkFailedMock,
  enqueuePdfDerivativeOrMarkFailed: enqueuePdfDerivativeOrMarkFailedMock,
}));
void mock.module("@/api/handlers/entities/compute-version-diff", () => ({
  computeVersionDiffStats: computeVersionDiffStatsMock,
}));
void mock.module("@/api/lib/sse", () => ({ broadcast: broadcastMock }));
void mock.module("@/api/lib/file-scan/scan", () => ({
  getScanWarnings: (scanResult: ScanResult) =>
    scanResult.verdict === "warn"
      ? scanResult.findings.flatMap((finding) =>
          finding.severity === "warn" ? [finding.message] : [],
        )
      : null,
  scanFile: scanFileMock,
}));

const { EDIT_WORKSPACE_DOCUMENT_TOOL_NAME, createEditWorkspaceDocumentTools } =
  await import("./edit-workspace-document-tools");

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
const newerEntityVersionId = toSafeId<"entityVersion">(
  "00000000-0000-0000-0000-000000000010",
);

const ORIGINAL_TEXT = "The quick brown fox jumps over the lazy dog.";

/** A real, valid DOCX buffer with one paragraph of known text. */
const buildSourceDocx = async (): Promise<ArrayBuffer> =>
  await markdownToStellaDocx(ORIGINAL_TEXT);

const firstBlock = async (buffer: ArrayBuffer) => {
  const reviewer = await FolioDocxReviewer.fromBuffer(buffer);
  const snapshot = reviewer.snapshot();
  const block = snapshot.blocks.at(0);
  if (!block) {
    throw new Error("Expected the fixture DOCX to have at least one block");
  }
  return block;
};

/** The bytes passed to the mocked `getS3().write(key, bytes)` call. */
const writtenBufferFromS3Mock = (): ArrayBuffer => {
  const call = s3WriteMock.mock.calls.at(0);
  const bytes = call?.[1];
  if (!(bytes instanceof Uint8Array)) {
    throw new Error("Expected getS3().write() to have been called with bytes");
  }
  const sliced = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  );
  if (!(sliced instanceof ArrayBuffer)) {
    throw new Error(
      "Expected getS3().write()'s bytes to back a plain ArrayBuffer",
    );
  }
  return sliced;
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
                id: "00000000-0000-0000-0000-000000000011",
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
                id: "00000000-0000-0000-0000-000000000012",
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
        return undefined;
      },
    }),
    update: (table: unknown) => ({
      set: (values: unknown) => ({
        where: async () => {
          updatedTables.push({ table, values });
        },
      }),
    }),
  };

  return { tx, insertedTables, updatedTables };
};

const validateInput = async (input: unknown) => {
  const { tx } = buildTx();
  const { safeDb } = createScopedDbMock(tx);
  const tool = createEditWorkspaceDocumentTools({
    safeDb,
    organizationId,
    userId,
    workspaceId,
    entityId,
    fileFieldId,
    recordAuditEvent: async () => undefined,
    docxEditRepresentation: "tracked-changes",
    expectedCurrentVersionId: entityVersionId,
  })[EDIT_WORKSPACE_DOCUMENT_TOOL_NAME];
  if (!tool.inputSchema) {
    throw new TypeError("Expected edit workspace document input schema");
  }
  return await tool.inputSchema["~standard"].validate(input);
};

describe("createEditWorkspaceDocumentTools", () => {
  beforeEach(() => {
    s3WriteMock.mockClear();
    s3DeleteMock.mockClear();
    processExtractionMock.mockClear();
    enqueueImageThumbnailOrMarkFailedMock.mockClear();
    enqueuePdfDerivativeOrMarkFailedMock.mockClear();
    computeVersionDiffStatsMock.mockClear();
    broadcastMock.mockClear();
    scanFileMock.mockClear();
    fileScanResult = { verdict: "pass", findings: [] };
    s3ReadKeys.length = 0;
  });

  test("registers a single server-executed edit_workspace_document tool", () => {
    const { tx } = buildTx({ preferredName: "Jana Nováková" });
    const { safeDb } = createScopedDbMock(tx);
    const tools = createEditWorkspaceDocumentTools({
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

    expect(Object.keys(tools)).toEqual([EDIT_WORKSPACE_DOCUMENT_TOOL_NAME]);
    const tool = tools[EDIT_WORKSPACE_DOCUMENT_TOOL_NAME];
    expect(tool.needsApproval).toBeUndefined();
    expect(tool.execute).toBeDefined();
  });

  test("rejects unsupported operation keys instead of dropping their semantics", async () => {
    const keys = ["precondition", "mode", "position", "typoKey"];
    const results = await Promise.all(
      keys.map(async (key) => ({
        key,
        result: await validateInput({
          baseVersionId: entityVersionId,
          version: 1,
          operations: [
            {
              type: "deleteBlock",
              blockId: "b-1",
              [key]: key === "precondition" ? { blockTextHash: "fake" } : true,
            },
          ],
        }),
      })),
    );
    for (const { key, result } of results) {
      expect(result.issues).toBeDefined();
      expect(result.issues?.some((issue) => issue.path?.at(-1) === key)).toBe(
        true,
      );
    }
  });

  test("keeps omitted operation ids deterministic across repeated validation", async () => {
    const input = {
      baseVersionId: entityVersionId,
      version: 1 as const,
      operations: [
        {
          type: "deleteBlock" as const,
          blockId: "b-1",
        },
      ],
    };

    const first = await validateInput(input);
    const second = await validateInput(input);

    expect(first).toEqual(second);
    expect(first).toEqual({ value: input });
  });

  test("rejects a tool call bound to a stale document version", async () => {
    const result = await validateInput({
      baseVersionId: newerEntityVersionId,
      version: 1,
      operations: [{ type: "deleteBlock", blockId: "b-1" }],
    });

    expect(result.issues).toEqual([
      expect.objectContaining({ path: ["baseVersionId"] }),
    ]);
  });

  test("returns a structured author_name_required outcome (no version written) when no author name is configured", async () => {
    const { tx } = buildTx({ preferredName: null, name: "   " });
    const { safeDb } = createScopedDbMock(tx);
    s3FileBuffer = await buildSourceDocx();
    const tools = createEditWorkspaceDocumentTools({
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
    const execute = tools[EDIT_WORKSPACE_DOCUMENT_TOOL_NAME].execute;
    if (!execute) {
      throw new Error("edit_workspace_document must be server-executed");
    }

    const block = await firstBlock(s3FileBuffer);
    const result = await execute(
      {
        baseVersionId: entityVersionId,
        version: 1,
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
    expect(s3WriteMock).not.toHaveBeenCalled();
  });

  test("direct mode requires an author for every comment-producing operation", async () => {
    const { tx } = buildTx({ preferredName: null, name: "   " });
    const { safeDb } = createScopedDbMock(tx);
    s3FileBuffer = await buildSourceDocx();
    const tools = createEditWorkspaceDocumentTools({
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
    const execute = tools[EDIT_WORKSPACE_DOCUMENT_TOOL_NAME].execute;
    if (!execute) {
      throw new Error("edit_workspace_document must be server-executed");
    }

    const block = await firstBlock(s3FileBuffer);
    const results = await Promise.all([
      execute(
        {
          baseVersionId: entityVersionId,
          version: 1,
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
          baseVersionId: entityVersionId,
          version: 1,
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
    expect(s3WriteMock).not.toHaveBeenCalled();
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
    s3FileBuffer = await buildSourceDocx();
    const recordedAuditEvents: unknown[] = [];
    const tools = createEditWorkspaceDocumentTools({
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
    const execute = tools[EDIT_WORKSPACE_DOCUMENT_TOOL_NAME].execute;
    if (!execute) {
      throw new Error("edit_workspace_document must be server-executed");
    }

    const block = await firstBlock(s3FileBuffer);
    const result = await execute(
      {
        baseVersionId: entityVersionId,
        version: 1,
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
      applied: [{ id: expect.stringMatching(/^auto-/u) }],
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
    expect(s3WriteMock).toHaveBeenCalledTimes(1);
    expect(recordedAuditEvents).toHaveLength(1);

    // The written bytes differ from the source, and re-parsing shows a
    // tracked revision authored with the resolved preferred name -- never a
    // fabricated "Stella AI"/"AI" placeholder.
    const writtenArrayBuffer = writtenBufferFromS3Mock();
    expect(writtenArrayBuffer).not.toEqual(s3FileBuffer);

    const reviewer = await FolioDocxReviewer.fromBuffer(writtenArrayBuffer);
    const changes = reviewer.getChanges();
    expect(changes.length).toBeGreaterThan(0);
    for (const change of changes) {
      expect(change.author).toBe("Jana Nováková");
    }

    expect(insertedTables.length).toBeGreaterThan(0);
    expect(s3ReadKeys.at(0)).toContain("00000000-0000-0000-0000-000000000012");
    expect(s3ReadKeys.at(0)).not.toContain(
      "00000000-0000-0000-0000-000000000011",
    );
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
    s3FileBuffer = await buildSourceDocx();
    const tools = createEditWorkspaceDocumentTools({
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
    const execute = tools[EDIT_WORKSPACE_DOCUMENT_TOOL_NAME].execute;
    if (!execute) {
      throw new Error("edit_workspace_document must be server-executed");
    }

    const block = await firstBlock(s3FileBuffer);
    // bun-types declares `.rejects.toThrow` as void, so awaiting it trips
    // type-aware lint; capture the rejection explicitly instead.
    const rejection = await Promise.resolve(
      execute(
        {
          baseVersionId: entityVersionId,
          version: 1,
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
      ),
    ).then(
      () => null,
      (error: unknown) => error,
    );
    expect(rejection).toBeInstanceOf(Error);
    expect(rejection instanceof Error ? rejection.message : "").toContain(
      "Embedded executable content",
    );
    expect(insertedTables).toEqual([]);
    expect(s3WriteMock).not.toHaveBeenCalled();
  });

  test("direct mode applies without tracked-changes markup", async () => {
    // Direct text rewrites create no authored revision, so a missing account
    // name must not block them with the tracked-changes name dialog.
    const { tx } = buildTx({ preferredName: null, name: "   " });
    const { safeDb } = createScopedDbMock(tx);
    s3FileBuffer = await buildSourceDocx();
    const tools = createEditWorkspaceDocumentTools({
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
    const execute = tools[EDIT_WORKSPACE_DOCUMENT_TOOL_NAME].execute;
    if (!execute) {
      throw new Error("edit_workspace_document must be server-executed");
    }

    const block = await firstBlock(s3FileBuffer);
    const result = await execute(
      {
        baseVersionId: entityVersionId,
        version: 1,
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

    const writtenArrayBuffer = writtenBufferFromS3Mock();
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
    s3FileBuffer = await buildSourceDocx();
    const tools = createEditWorkspaceDocumentTools({
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
    const execute = tools[EDIT_WORKSPACE_DOCUMENT_TOOL_NAME].execute;
    if (!execute) {
      throw new Error("edit_workspace_document must be server-executed");
    }

    const block = await firstBlock(s3FileBuffer);
    const rejection = await Promise.resolve(
      execute(
        {
          baseVersionId: entityVersionId,
          version: 1,
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
    expect(rejection instanceof Error ? rejection.message : "").toMatch(
      /missingFind/u,
    );
    expect(s3WriteMock).not.toHaveBeenCalled();
  });

  test("rejects automatic write-back while a live edit session exists", async () => {
    const { tx, insertedTables } = buildTx({
      openDesktopEditSession: true,
      preferredName: "Jana Nováková",
    });
    const { safeDb } = createScopedDbMock(tx);
    s3FileBuffer = await buildSourceDocx();
    const tools = createEditWorkspaceDocumentTools({
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
    const execute = tools[EDIT_WORKSPACE_DOCUMENT_TOOL_NAME].execute;
    if (!execute) {
      throw new Error("edit_workspace_document must be server-executed");
    }
    const block = await firstBlock(s3FileBuffer);

    const rejection = await Promise.resolve(
      execute(
        {
          baseVersionId: entityVersionId,
          version: 1,
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
    expect(insertedTables).toEqual([]);
    expect(s3DeleteMock).toHaveBeenCalledTimes(1);
  });

  test("rejects a stale write when the current version changes during apply", async () => {
    const { tx, insertedTables } = buildTx({
      lockedCurrentVersionId: newerEntityVersionId,
      preferredName: "Jana Nováková",
    });
    const { safeDb } = createScopedDbMock(tx);
    s3FileBuffer = await buildSourceDocx();
    const recordedAuditEvents: unknown[] = [];
    const tools = createEditWorkspaceDocumentTools({
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
    const execute = tools[EDIT_WORKSPACE_DOCUMENT_TOOL_NAME].execute;
    if (!execute) {
      throw new Error("edit_workspace_document must be server-executed");
    }
    const block = await firstBlock(s3FileBuffer);

    const rejection = await Promise.resolve(
      execute(
        {
          baseVersionId: entityVersionId,
          version: 1,
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
    expect(insertedTables).toEqual([]);
    expect(recordedAuditEvents).toEqual([]);
    expect(s3DeleteMock).toHaveBeenCalledTimes(1);
  });

  test("rejects an approved edit when the document changed after proposal", async () => {
    const { tx } = buildTx({
      loadedCurrentVersionId: newerEntityVersionId,
      preferredName: "Jana Nováková",
    });
    const { safeDb } = createScopedDbMock(tx);
    s3FileBuffer = await buildSourceDocx();
    const tools = createEditWorkspaceDocumentTools({
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
    const execute = tools[EDIT_WORKSPACE_DOCUMENT_TOOL_NAME].execute;
    if (!execute) {
      throw new Error("edit_workspace_document must be server-executed");
    }

    const rejection = await Promise.resolve(
      execute(
        {
          baseVersionId: entityVersionId,
          version: 1,
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

    expect(rejection).toBeInstanceOf(Error);
    expect(rejection instanceof Error ? rejection.message : "").toMatch(
      /document changed/iu,
    );
    expect(s3WriteMock).not.toHaveBeenCalled();
  });
});
