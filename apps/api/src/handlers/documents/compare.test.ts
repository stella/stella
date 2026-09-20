import { Result } from "better-result";
import { describe, expect, mock, test } from "bun:test";

import {
  compareDocx,
  createDocx,
  createEmptyDocument,
  type CompareDocxError,
  type CompareResult,
} from "@stll/folio-core";
import { FolioDocxReviewer, parseDocx } from "@stll/folio-core/server";

import {
  createDocumentCompareHandler,
  mapCompareDocxError,
} from "@/api/handlers/documents/compare";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { toSafeId } from "@/api/lib/branded-types";
import type { DocumentSource } from "@/api/lib/document-source";
import { TimeoutError } from "@/api/lib/errors/tagged-errors";
import { DOCX_MIME_TYPE } from "@/api/mime-types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

const organizationId = toSafeId<"organization">(
  "00000000-0000-4000-8000-000000000001",
);
const workspaceId = toSafeId<"workspace">(
  "00000000-0000-4000-8000-000000000002",
);
const documentId = toSafeId<"entity">("00000000-0000-4000-8000-000000000003");
const userId = toSafeId<"user">("00000000-0000-4000-8000-000000000004");
const baseVersionId = toSafeId<"entityVersion">(
  "00000000-0000-4000-8000-000000000005",
);
const firstTargetId = toSafeId<"entityVersion">(
  "00000000-0000-4000-8000-000000000006",
);
const secondTargetId = toSafeId<"entityVersion">(
  "00000000-0000-4000-8000-000000000007",
);
const redlineVersionId = toSafeId<"entityVersion">(
  "00000000-0000-4000-8000-000000000008",
);
const propertyId = toSafeId<"property">("00000000-0000-4000-8000-000000000009");
const fieldId = toSafeId<"field">("00000000-0000-4000-8000-000000000010");
const secondaryPropertyId = toSafeId<"property">(
  "00000000-0000-4000-8000-000000000012",
);
const secondaryFieldId = toSafeId<"field">(
  "00000000-0000-4000-8000-000000000013",
);

const versionRow = (
  id: typeof baseVersionId,
  versionNumber: number,
  createdAt: Date,
) => ({
  id,
  versionNumber,
  createdAt,
  fields: [
    {
      id: fieldId,
      propertyId,
      content: {
        version: 1,
        type: "file",
        id: "00000000-0000-4000-8000-000000000011",
        fileName: `Agreement v${String(versionNumber)}.docx`,
        mimeType: DOCX_MIME_TYPE,
        sizeBytes: 128,
        encrypted: false,
        sha256Hex: "a".repeat(64),
        pdfFileId: null,
      },
    },
  ],
});

const baseRow = versionRow(
  baseVersionId,
  1,
  new Date("2026-09-01T08:00:00.000Z"),
);
const firstTargetRow = versionRow(
  firstTargetId,
  2,
  new Date("2026-09-02T09:30:00.000Z"),
);
const secondTargetRow = versionRow(
  secondTargetId,
  3,
  new Date("2026-09-03T10:45:00.000Z"),
);

const verifiedComparison: CompareResult = {
  buffer: new Uint8Array([7, 8, 9]).buffer,
  changes: [],
  verification: { status: "verified" },
  unsupported: [],
  compatibility: { status: "standard-ooxml" },
};

type Dependencies = NonNullable<
  Parameters<typeof createDocumentCompareHandler>[0]
>;

type HarnessOptions = {
  compareDocx?: Dependencies["compareDocx"];
  compareResults?: Result<CompareResult, CompareDocxError>[];
  createdFieldId?: typeof fieldId;
  documentFound?: boolean;
  previous?: boolean;
  predecessors?: { id: typeof baseVersionId; source: DocumentSource | null }[];
  readBuffers?: ReadonlyMap<string, ArrayBuffer>;
  rows?: ReturnType<typeof versionRow>[];
  timeoutLabel?: string;
  downloadFails?: boolean;
  temporaryDeliveryFails?: boolean;
};

const createHarness = ({
  compareDocx: realCompareDocx,
  compareResults = [Result.ok(verifiedComparison)],
  createdFieldId = fieldId,
  documentFound = true,
  previous = false,
  predecessors,
  readBuffers,
  rows = [baseRow, firstTargetRow],
  timeoutLabel,
  downloadFails = false,
  temporaryDeliveryFails = false,
}: HarnessOptions = {}) => {
  const tx = {
    query: {
      entities: {
        findFirst: async () =>
          documentFound
            ? {
                currentVersionId: firstTargetId,
                kind: "document" as const,
                readOnly: false,
              }
            : null,
      },
      entityVersions: {
        findMany: async () => (previous && predecessors ? predecessors : rows),
        findFirst: async ({
          where,
        }: {
          where: { id?: { eq: typeof baseVersionId } };
        }) => {
          const selectedId =
            where.id?.eq ?? predecessors?.at(0)?.id ?? baseVersionId;
          return rows.find(({ id }) => id === selectedId);
        },
      },
    },
  };
  const { safeDb, scopedDb } = createScopedDbMock(tx);
  const applyDispositionMock = mock(
    async (buffer: ArrayBuffer, _disposition: "keep" | "accept" | "reject") =>
      buffer,
  );
  let comparisonIndex = 0;
  const compareDocxMock = mock(
    async (
      base: ArrayBuffer,
      target: ArrayBuffer,
      options: Parameters<Dependencies["compareDocx"]>[2],
    ) => {
      if (realCompareDocx !== undefined) {
        return await realCompareDocx(base, target, options);
      }
      const result = compareResults.at(comparisonIndex);
      comparisonIndex += 1;
      return result ?? Result.ok(verifiedComparison);
    },
  );
  const createdVersionIds = [redlineVersionId, secondTargetId];
  let persistedIndex = 0;
  const createEntityVersionFromBufferMock = mock(
    async (
      _input: Parameters<Dependencies["createEntityVersionFromBuffer"]>[0],
    ) => {
      const entityVersionId =
        createdVersionIds.at(persistedIndex) ?? redlineVersionId;
      persistedIndex += 1;
      return Result.ok({
        entityId: documentId,
        entityVersionId,
        fieldId: createdFieldId,
        fileName: "Agreement redline.docx",
        versionNumber: 4 + persistedIndex,
      });
    },
  );
  const readEntityVersionFileMock = mock(
    async (file: Parameters<Dependencies["readEntityVersionFile"]>[0]) =>
      Result.ok(
        readBuffers?.get(file.fileName) ?? new Uint8Array([1, 2, 3]).buffer,
      ),
  );
  const withTimeoutMock = mock(
    async (
      operation: (signal: AbortSignal) => Promise<unknown>,
      options: { label: string },
    ) => {
      if (options.label === timeoutLabel) {
        throw new TimeoutError({
          message: "timed out",
          label: options.label,
          timeoutMs: 1,
        });
      }
      return await operation(new AbortController().signal);
    },
  );
  const readFileHandlerMock = mock(
    async (_options: Parameters<Dependencies["readFileHandler"]>[0]) => {
      if (downloadFails) {
        throw new TimeoutError({
          message: "delivery failed",
          label: "download",
          timeoutMs: 1,
        });
      }
      return {
        fileId: "file",
        mimeType: DOCX_MIME_TYPE,
        originalMimeType: DOCX_MIME_TYPE,
        fileName: "Agreement redline.docx",
        encrypted: false,
        presignedUrl: "https://files.example/redline.docx",
        stampable: false,
      };
    },
  );
  const deliverTemporaryRedlineMock = mock(
    async (_options: Parameters<Dependencies["deliverTemporaryRedline"]>[0]) =>
      temporaryDeliveryFails
        ? Result.err({ step: "store" as const })
        : Result.ok({
            downloadUrl: "https://files.example/tmp/redline.docx",
            expiresAt: "2026-09-20T12:00:00.000Z",
          }),
  );
  const dependencies = asTestRaw<Dependencies>({
    applyDisposition: applyDispositionMock,
    compareDocx: compareDocxMock,
    createEntityVersionFromBuffer: createEntityVersionFromBufferMock,
    deliverTemporaryRedline: deliverTemporaryRedlineMock,
    readEntityVersionFile: readEntityVersionFileMock,
    readFileHandler: readFileHandlerMock,
    resolveDocxEditAuthorName: async () => "Ada Lovelace",
    withTimeout: withTimeoutMock,
  });
  const definition = createDocumentCompareHandler(dependencies);
  type Ctx = Parameters<typeof definition.handler>[0];
  const auditedEvents: unknown[] = [];
  const auditRecorder = mock(async (_tx: unknown, event: unknown) => {
    auditedEvents.push(event);
  });
  const context = asTestRaw<Ctx>({
    body: {
      filePropertyId: propertyId,
      selection: {
        type: previous ? "previous" : "versions",
        ...(previous
          ? { targetVersionId: firstTargetId }
          : {
              baseVersionId,
              targetVersionIds: [firstTargetId],
            }),
      },
      baseTrackedChanges: "accept",
      targetTrackedChanges: "reject",
      output: { type: "version" },
    },
    params: { workspaceId, documentId },
    request: new Request("http://localhost/documents/compare"),
    route: "/documents/:workspaceId/document/:documentId/compare",
    safeDb,
    scopedDb,
    session: { activeOrganizationId: organizationId },
    workspaceId,
    user: { id: userId },
    recordAuditEvent: asTestRaw<AuditRecorder>(auditRecorder),
    memberRole: { role: "owner" },
    getActiveWorkspaceIds: async () => [workspaceId],
    getAccessibleWorkspaces: async () => [],
    getWorkspaceAccess: async () => null,
    orgAIConfig: null,
    promptCachingEnabled: true,
  });

  return {
    applyDispositionMock,
    auditedEvents,
    auditRecorder,
    compareDocxMock,
    context,
    createEntityVersionFromBufferMock,
    definition,
    deliverTemporaryRedlineMock,
    readEntityVersionFileMock,
    readFileHandlerMock,
    withTimeoutMock,
  };
};

const documentWithBodyText = async (text: string): Promise<ArrayBuffer> => {
  const document = createEmptyDocument();
  document.package.document.content = [
    {
      type: "paragraph",
      paraId: "10000001",
      textId: "10000001",
      content: [
        {
          type: "run",
          content: [{ type: "text", text }],
        },
      ],
    },
  ];
  return createDocx(document);
};

const bodyText = async (buffer: ArrayBuffer): Promise<string> => {
  const document = await parseDocx(buffer, {
    detectVariables: false,
    preloadFonts: false,
  });
  const paragraphs: string[] = [];
  for (const block of document.package.document.content) {
    if (block.type !== "paragraph") {
      continue;
    }
    let text = "";
    for (const run of block.content) {
      if (run.type !== "run") {
        continue;
      }
      for (const content of run.content) {
        if (content.type === "text") {
          text += content.text;
        }
      }
    }
    paragraphs.push(text);
  }
  return paragraphs.join("\n");
};

const copyToArrayBuffer = (buffer: ArrayBuffer | Uint8Array): ArrayBuffer => {
  if (buffer instanceof ArrayBuffer) {
    return buffer;
  }
  const copy = new ArrayBuffer(buffer.byteLength);
  new Uint8Array(copy).set(buffer);
  return copy;
};

describe("documents.compare", () => {
  test("uses the requested file property for both source versions and the derived write", async () => {
    const selectedRows = [baseRow, firstTargetRow].map(
      ({ createdAt, fields: originalFields, id, versionNumber }) => {
        const fields = [...originalFields];
        fields.push({
          id: secondaryFieldId,
          propertyId: secondaryPropertyId,
          content: {
            version: 1,
            type: "file" as const,
            id: "00000000-0000-4000-8000-000000000014",
            fileName: `Exhibit v${String(versionNumber)}.docx`,
            mimeType: DOCX_MIME_TYPE,
            sizeBytes: 128,
            encrypted: false,
            sha256Hex: "b".repeat(64),
            pdfFileId: null,
          },
        });
        return { createdAt, fields, id, versionNumber };
      },
    );
    const harness = createHarness({
      createdFieldId: secondaryFieldId,
      rows: selectedRows,
    });

    const result = await harness.definition.handler({
      ...harness.context,
      body: { ...harness.context.body, filePropertyId: secondaryPropertyId },
    });

    expect(result).toMatchObject({
      results: [
        {
          status: "created",
          file: { fieldId: secondaryFieldId, propertyId: secondaryPropertyId },
        },
      ],
    });
    expect(
      harness.readEntityVersionFileMock.mock.calls.map(
        ([file]) => file.fileName,
      ),
    ).toEqual(["Exhibit v1.docx", "Exhibit v2.docx"]);
    expect(
      harness.createEntityVersionFromBufferMock.mock.calls.at(0)?.[0],
    ).toMatchObject({
      writePolicy: {
        type: "append-derived-file-from-version",
        filePropertyId: secondaryPropertyId,
      },
    });
  });

  test.each([
    {
      direction: "forward",
      baseText: "Draft terms",
      targetText: "Final terms",
    },
    {
      direction: "reverse",
      baseText: "Final terms",
      targetText: "Draft terms",
    },
  ])(
    "persists a Folio-exact redline whose resolutions recover $direction endpoints",
    async ({ baseText, targetText }) => {
      const [baseBuffer, targetBuffer] = await Promise.all([
        documentWithBodyText(baseText),
        documentWithBodyText(targetText),
      ]);
      expect(await bodyText(baseBuffer)).toBe(baseText);
      expect(await bodyText(targetBuffer)).toBe(targetText);
      expect(baseText).not.toBe(targetText);

      const harness = createHarness({
        compareDocx,
        readBuffers: new Map([
          ["Agreement v1.docx", baseBuffer],
          ["Agreement v2.docx", targetBuffer],
        ]),
      });

      const result = await harness.definition.handler(harness.context);
      expect(result).toMatchObject({
        results: [{ status: "created", verification: { status: "verified" } }],
      });
      const persisted =
        harness.createEntityVersionFromBufferMock.mock.calls.at(0)?.[0];
      if (persisted === undefined) {
        throw new Error("comparison did not persist a redline buffer");
      }

      const redlineBuffer = copyToArrayBuffer(persisted.buffer);
      const accepting = await FolioDocxReviewer.fromBuffer(redlineBuffer);
      expect(accepting.acceptAll()).toBeGreaterThan(0);
      expect(await bodyText(await accepting.toBuffer())).toBe(targetText);

      const rejecting = await FolioDocxReviewer.fromBuffer(redlineBuffer);
      expect(rejecting.rejectAll()).toBeGreaterThan(0);
      expect(await bodyText(await rejecting.toBuffer())).toBe(baseText);
    },
  );

  test("creates a strict verified derived redline with server-derived metadata and provenance", async () => {
    const harness = createHarness();

    const result = await harness.definition.handler(harness.context);

    expect(result).toEqual({
      results: [
        {
          status: "created",
          baseVersionId,
          targetVersionId: firstTargetId,
          redlineVersionId,
          file: {
            fieldId,
            propertyId,
            fileName: "Agreement redline.docx",
            mimeType: DOCX_MIME_TYPE,
            versionNumber: 5,
            openUrl: expect.stringContaining(
              `/workspaces/${workspaceId}/all/pdf?entity=${documentId}&field=${fieldId}`,
            ),
            download: {
              status: "available",
              downloadUrl: "https://files.example/redline.docx",
              expiresAt: expect.any(String),
            },
          },
          changes: [],
          verification: { status: "verified" },
          unsupported: [],
          compatibility: { status: "standard-ooxml" },
        },
      ],
    });
    expect(
      harness.applyDispositionMock.mock.calls.map((call) => call[1]),
    ).toEqual(["accept", "reject"]);
    expect(harness.compareDocxMock.mock.calls.at(0)?.[2]).toEqual({
      author: "Ada Lovelace",
      revisionFormat: "folio-exact",
      timestamp: "2026-09-02T09:30:00.000Z",
      granularity: "word",
      onUnverified: "refuse",
    });
    expect(
      harness.createEntityVersionFromBufferMock.mock.calls.at(0)?.[0],
    ).toMatchObject({
      entityId: documentId,
      workspaceId,
      organizationId,
      userId,
      recordAuditEvent: harness.auditRecorder,
      fileName: "Agreement v2 redline.docx",
      mimeType: DOCX_MIME_TYPE,
      source: {
        kind: "comparison",
        baseVersionId,
        targetVersionId: firstTargetId,
        mode: "strict",
        granularity: "word",
        baseTrackedChanges: "accept",
        targetTrackedChanges: "reject",
      },
      writePolicy: {
        type: "append-derived-file-from-version",
        expectedCurrentVersionId: firstTargetId,
        filePropertyId: propertyId,
        sourceVersionId: firstTargetId,
      },
    });
  });

  test("keeps the saved artifact recoverable when download delivery fails", async () => {
    const harness = createHarness({
      downloadFails: true,
      compareResults: [
        Result.ok({
          ...verifiedComparison,
          compatibility: {
            status: "requires-folio",
            reasons: ["section-reference-history"],
          },
        }),
      ],
    });
    const result = await harness.definition.handler(harness.context);
    expect(result).toMatchObject({
      results: [
        {
          status: "created",
          redlineVersionId,
          compatibility: {
            status: "requires-folio",
            reasons: ["section-reference-history"],
          },
          file: {
            fieldId,
            openUrl: expect.any(String),
            download: { status: "unavailable" },
          },
        },
      ],
    });
    expect(harness.createEntityVersionFromBufferMock).toHaveBeenCalledTimes(1);
    expect(harness.readFileHandlerMock).toHaveBeenCalledWith({
      scopedDb: harness.context.scopedDb,
      fieldId,
      organizationId,
      workspaceId,
      purpose: "download",
      recordAuditEvent: harness.auditRecorder,
    });
  });

  test("previews a comparison without writing a document version", async () => {
    const harness = createHarness();

    const result = await harness.definition.handler({
      ...harness.context,
      body: {
        ...harness.context.body,
        output: { type: "preview" },
      },
    });

    expect(result).toEqual({
      results: [
        {
          status: "previewed",
          baseVersionId,
          targetVersionId: firstTargetId,
          changes: [],
          verification: { status: "verified" },
          unsupported: [],
          compatibility: { status: "standard-ooxml" },
        },
      ],
    });
    expect(harness.createEntityVersionFromBufferMock).not.toHaveBeenCalled();
    expect(harness.readFileHandlerMock).not.toHaveBeenCalled();
  });

  test("delivers a download as a temporary link without touching the document", async () => {
    const harness = createHarness();

    const result = await harness.definition.handler({
      ...harness.context,
      body: { ...harness.context.body, output: { type: "download" } },
    });

    expect(result).toEqual({
      results: [
        {
          status: "downloadable",
          baseVersionId,
          targetVersionId: firstTargetId,
          fileName: "Agreement v2 redline.docx",
          download: {
            downloadUrl: "https://files.example/tmp/redline.docx",
            expiresAt: "2026-09-20T12:00:00.000Z",
          },
          changes: [],
          verification: { status: "verified" },
          unsupported: [],
          compatibility: { status: "standard-ooxml" },
        },
      ],
    });
    expect(
      harness.deliverTemporaryRedlineMock.mock.calls.at(0)?.[0],
    ).toMatchObject({
      fileName: "Agreement v2 redline.docx",
      organizationId,
      scopedDb: harness.context.scopedDb,
      userId,
    });
    // Nothing is written to the entity, and no stored file is read back.
    expect(harness.createEntityVersionFromBufferMock).not.toHaveBeenCalled();
    expect(harness.readFileHandlerMock).not.toHaveBeenCalled();
    expect(harness.auditedEvents.at(0)).toMatchObject({
      action: "execute",
      resourceType: "file_comparison",
      metadata: {
        baseSizeBytes: 128,
        changeCount: 0,
        targetSizeBytes: 128,
      },
      workspaceId,
    });
  });

  test("reports a failed temporary delivery per target without saving anything", async () => {
    const harness = createHarness({ temporaryDeliveryFails: true });

    const result = await harness.definition.handler({
      ...harness.context,
      body: { ...harness.context.body, output: { type: "download" } },
    });

    expect(result).toMatchObject({
      results: [{ status: "failed", error: { code: "delivery_failed" } }],
    });
    expect(harness.createEntityVersionFromBufferMock).not.toHaveBeenCalled();
  });

  test("applies the opposite tracked-change dispositions independently", async () => {
    const harness = createHarness();

    await harness.definition.handler({
      ...harness.context,
      body: {
        ...harness.context.body,
        baseTrackedChanges: "reject",
        targetTrackedChanges: "accept",
      },
    });

    expect(
      harness.applyDispositionMock.mock.calls.map((call) => call[1]),
    ).toEqual(["reject", "accept"]);
  });

  test("returns and labels best-effort unverified output and unsupported stories", async () => {
    const comparison = asTestRaw<CompareResult>({
      buffer: new ArrayBuffer(1),
      changes: [],
      verification: {
        status: "unverified",
        failures: [
          {
            invariant: "accept-reproduces-target",
            cause: "text",
            story: { type: "document" },
            detail: "block 1 differs",
          },
        ],
      },
      unsupported: [
        {
          reason: "story-not-editable",
          baseStory: null,
          targetStory: null,
        },
      ],
    });
    const harness = createHarness({
      compareResults: [Result.ok(comparison)],
    });

    const result = await harness.definition.handler({
      ...harness.context,
      body: {
        ...harness.context.body,
        mode: "best-effort",
        granularity: "character",
      },
    });

    expect(harness.compareDocxMock.mock.calls.at(0)?.[2]).toMatchObject({
      granularity: "character",
      onUnverified: "emit",
    });
    expect(result).toMatchObject({
      results: [
        {
          status: "created",
          verification: { status: "unverified" },
          unsupported: [{ reason: "story-not-editable" }],
        },
      ],
    });
  });

  test("resolves the immediate previous version server-side", async () => {
    const harness = createHarness({ previous: true });

    const result = await harness.definition.handler(harness.context);

    expect(result).toMatchObject({
      results: [
        {
          status: "created",
          baseVersionId,
          targetVersionId: firstTargetId,
        },
      ],
    });
  });

  test("previous skips a saved comparison between ordinary versions", async () => {
    const derived = versionRow(
      secondTargetId,
      2,
      new Date("2026-09-02T09:00:00Z"),
    );
    const target = { ...firstTargetRow, versionNumber: 3 };
    const harness = createHarness({
      previous: true,
      rows: [baseRow, derived, target],
      predecessors: [
        {
          id: derived.id,
          source: {
            kind: "comparison",
            baseVersionId,
            targetVersionId: firstTargetId,
            mode: "strict",
            granularity: "word",
            baseTrackedChanges: "keep",
            targetTrackedChanges: "keep",
          },
        },
        { id: baseRow.id, source: null },
      ],
    });
    const result = await harness.definition.handler(harness.context);
    expect(result).toMatchObject({
      results: [
        { status: "created", baseVersionId, targetVersionId: firstTargetId },
      ],
    });
    expect(
      harness.readEntityVersionFileMock.mock.calls.map(
        ([file]) => file.fileName,
      ),
    ).toEqual(["Agreement v1.docx", "Agreement v2.docx"]);
  });

  test("a persistence deadline does not start another save or request a download", async () => {
    const harness = createHarness({
      timeoutLabel: "documents.compare.persist",
    });
    const result = await harness.definition.handler(harness.context);
    expect(result).toMatchObject({
      results: [{ status: "failed", error: { code: "persistence_failed" } }],
    });
    expect(harness.createEntityVersionFromBufferMock).not.toHaveBeenCalled();
    expect(harness.readFileHandlerMock).not.toHaveBeenCalled();
  });

  test("returns per-target outcomes and never writes a failed comparison", async () => {
    const comparisonError = asTestRaw<CompareDocxError>({
      _tag: "CompareDocxOperationLimitError",
      message: "internal detail",
      limit: 10,
    });
    const harness = createHarness({
      rows: [baseRow, firstTargetRow, secondTargetRow],
      compareResults: [
        Result.err(comparisonError),
        Result.ok(verifiedComparison),
      ],
    });

    const result = await harness.definition.handler({
      ...harness.context,
      body: {
        ...harness.context.body,
        selection: {
          type: "versions",
          baseVersionId,
          targetVersionIds: [firstTargetId, secondTargetId],
        },
      },
    });

    expect(result).toMatchObject({
      results: [
        {
          status: "failed",
          targetVersionId: firstTargetId,
          error: { code: "operation_limit" },
        },
        { status: "created", targetVersionId: secondTargetId },
      ],
    });
    expect(harness.createEntityVersionFromBufferMock).toHaveBeenCalledTimes(1);
  });

  test("does not reveal a document outside the authorized matter", async () => {
    const harness = createHarness({ documentFound: false });

    const result = await harness.definition.handler(harness.context);

    expect(result).toEqual({
      code: 404,
      response: { message: "Document not found" },
    });
    expect(harness.readEntityVersionFileMock).not.toHaveBeenCalled();
    expect(harness.createEntityVersionFromBufferMock).not.toHaveBeenCalled();
    expect(harness.readFileHandlerMock).not.toHaveBeenCalled();
  });

  test("rejects inaccessible versions as a closed per-target failure", async () => {
    const harness = createHarness({ rows: [baseRow] });

    const result = await harness.definition.handler(harness.context);

    expect(result).toMatchObject({
      results: [
        {
          status: "failed",
          error: { code: "version_not_found" },
        },
      ],
    });
    expect(harness.readEntityVersionFileMock).not.toHaveBeenCalled();
    expect(harness.createEntityVersionFromBufferMock).not.toHaveBeenCalled();
    expect(harness.readFileHandlerMock).not.toHaveBeenCalled();
  });

  test("returns a named timeout failure without persisting", async () => {
    const harness = createHarness({ timeoutLabel: "documents.compare.folio" });

    const result = await harness.definition.handler(harness.context);

    expect(result).toMatchObject({
      results: [{ status: "failed", error: { code: "timeout" } }],
    });
    expect(harness.createEntityVersionFromBufferMock).not.toHaveBeenCalled();
    expect(harness.readFileHandlerMock).not.toHaveBeenCalled();
  });
});

describe("mapCompareDocxError", () => {
  test.each([
    ["CompareDocxParseError", "parse_failed", { side: "base", cause: null }],
    ["CompareDocxApplyError", "apply_failed", { skipped: [] }],
    ["CompareDocxOperationLimitError", "operation_limit", { limit: 1 }],
    [
      "CompareDocxRoundTripError",
      "round_trip_failed",
      {
        story: { type: "document" },
        invariant: "accept-reproduces-target",
        cause: "text",
        failures: [],
      },
    ],
    ["CompareDocxSerializeError", "serialization_failed", { cause: null }],
    [
      "InvalidCompareDocxOptionsError",
      "invalid_options",
      { option: "timestamp", receivedValue: "bad" },
    ],
    [
      "CompareDocxFinalParagraphMarkError",
      "final_paragraph_mark",
      { revisions: [] },
    ],
  ] as const)("maps %s to %s", (tag, code, fields) => {
    const mapped = mapCompareDocxError(
      asTestRaw<CompareDocxError>({
        _tag: tag,
        message: "sensitive substrate detail",
        ...fields,
      }),
    );

    expect(mapped.code).toBe(code);
    expect(mapped.message).not.toContain("sensitive substrate detail");
    expect(mapped.hint.length).toBeGreaterThan(0);
  });
});
