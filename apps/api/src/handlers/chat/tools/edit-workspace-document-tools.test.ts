import { beforeEach, describe, expect, mock, test } from "bun:test";

import { FolioDocxReviewer } from "@stll/folio-core/server";

import { markdownToStellaDocx } from "@/api/handlers/chat/tools/create-workspace-document-tools";
import { toSafeId } from "@/api/lib/branded-types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

const s3WriteMock = mock(async (_key: string, _bytes: Uint8Array) => {});
const s3DeleteMock = mock(async () => {});
let s3FileBuffer: ArrayBuffer = new ArrayBuffer(0);
const processExtractionMock = mock(async () => {});
const enqueueImageThumbnailOrMarkFailedMock = mock(async () => {});
const enqueuePdfDerivativeOrMarkFailedMock = mock(async () => {});
const computeVersionDiffStatsMock = mock(async () => {});
const broadcastMock = mock(() => {});

void mock.module("@/api/lib/s3", () => ({
  getS3: () => ({
    write: s3WriteMock,
    delete: s3DeleteMock,
    file: () => ({ arrayBuffer: async () => s3FileBuffer }),
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
const entityVersionId = toSafeId<"entityVersion">(
  "00000000-0000-0000-0000-000000000006",
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
  preferredName?: string | null;
  name?: string;
  readOnly?: boolean;
};

const buildTx = ({
  preferredName = null,
  name = "Fallback Name",
  readOnly = false,
}: BuildTxOptions = {}) => {
  const insertedTables: unknown[] = [];

  const entitiesSelect = {
    from: () => ({
      where: () => ({
        limit: () => ({
          for: async () => [
            { currentVersionId: entityVersionId, docSequence: null, readOnly },
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

  const tx = {
    query: {
      user: {
        findFirst: async () => ({ name, preferredName }),
      },
      entities: {
        findFirst: async () => ({
          currentVersionId: entityVersionId,
          readOnly,
        }),
      },
      entityVersions: {
        findFirst: async () => ({
          id: entityVersionId,
          fields: [
            {
              content: {
                type: "file",
                id: "source-file-id",
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
        findFirst: async () => ({ reference: null }),
      },
    },
    select: (fields: Record<string, unknown>) => {
      if ("metadata" in fields) {
        return cellMetadataSelect;
      }
      if ("max" in fields) {
        return maxVersionNumberSelect;
      }
      return entitiesSelect;
    },
    insert: (table: unknown) => ({
      values: (values: unknown) => {
        insertedTables.push({ table, values });
        return undefined;
      },
    }),
    update: () => ({ set: () => ({ where: async () => {} }) }),
  };

  return { tx, insertedTables };
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
      recordAuditEvent: async () => undefined,
      docxEditRepresentation: "tracked-changes",
    });

    expect(Object.keys(tools)).toEqual([EDIT_WORKSPACE_DOCUMENT_TOOL_NAME]);
    const tool = tools[EDIT_WORKSPACE_DOCUMENT_TOOL_NAME];
    expect(tool.needsApproval).toBeUndefined();
    expect(tool.execute).toBeDefined();
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
      recordAuditEvent: async () => undefined,
      docxEditRepresentation: "tracked-changes",
    });
    const execute = tools[EDIT_WORKSPACE_DOCUMENT_TOOL_NAME].execute;
    if (!execute) {
      throw new Error("edit_workspace_document must be server-executed");
    }

    const block = await firstBlock(s3FileBuffer);
    const result = await execute(
      {
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

  test("tracked-changes mode writes a new version with the configured author attributed on the revision", async () => {
    const { tx, insertedTables } = buildTx({
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
      recordAuditEvent: async (_tx, event) => {
        recordedAuditEvents.push(event);
      },
      docxEditRepresentation: "tracked-changes",
    });
    const execute = tools[EDIT_WORKSPACE_DOCUMENT_TOOL_NAME].execute;
    if (!execute) {
      throw new Error("edit_workspace_document must be server-executed");
    }

    const block = await firstBlock(s3FileBuffer);
    const result = await execute(
      {
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
    expect(result).toMatchObject({
      representation: "tracked-changes",
      applied: [{ id: "op-1" }],
      skipped: [],
    });
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
    expect(computeVersionDiffStatsMock).toHaveBeenCalledTimes(1);
    expect(processExtractionMock).toHaveBeenCalledTimes(1);
  });

  test("direct mode applies without tracked-changes markup", async () => {
    const { tx } = buildTx({ preferredName: "Jana Nováková" });
    const { safeDb } = createScopedDbMock(tx);
    s3FileBuffer = await buildSourceDocx();
    const tools = createEditWorkspaceDocumentTools({
      safeDb,
      organizationId,
      userId,
      workspaceId,
      entityId,
      recordAuditEvent: async () => undefined,
      docxEditRepresentation: "direct",
    });
    const execute = tools[EDIT_WORKSPACE_DOCUMENT_TOOL_NAME].execute;
    if (!execute) {
      throw new Error("edit_workspace_document must be server-executed");
    }

    const block = await firstBlock(s3FileBuffer);
    const result = await execute(
      {
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
      recordAuditEvent: async () => undefined,
      docxEditRepresentation: "tracked-changes",
    });
    const execute = tools[EDIT_WORKSPACE_DOCUMENT_TOOL_NAME].execute;
    if (!execute) {
      throw new Error("edit_workspace_document must be server-executed");
    }

    const block = await firstBlock(s3FileBuffer);
    const rejection = await Promise.resolve(
      execute(
        {
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
});
