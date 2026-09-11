import { Result } from "better-result";
import { describe, expect, mock, test } from "bun:test";

import type { CompareDocxError, CompareResult } from "@stll/folio-core";

import {
  createDocumentCompareHandler,
  mapCompareDocxError,
} from "@/api/handlers/documents/compare";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { toSafeId } from "@/api/lib/branded-types";
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
};

type Dependencies = NonNullable<
  Parameters<typeof createDocumentCompareHandler>[0]
>;

type HarnessOptions = {
  compareResults?: Result<CompareResult, CompareDocxError>[];
  documentFound?: boolean;
  previous?: boolean;
  rows?: ReturnType<typeof versionRow>[];
  timeoutLabel?: string;
};

const createHarness = ({
  compareResults = [Result.ok(verifiedComparison)],
  documentFound = true,
  previous = false,
  rows = [baseRow, firstTargetRow],
  timeoutLabel,
}: HarnessOptions = {}) => {
  let previousRead = 0;
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
        findMany: async () => rows,
        findFirst: async () => {
          const result = previousRead === 0 ? firstTargetRow : baseRow;
          previousRead += 1;
          return result;
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
      _base: ArrayBuffer,
      _target: ArrayBuffer,
      _options: Parameters<Dependencies["compareDocx"]>[2],
    ) => {
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
        fieldId,
        fileName: "Agreement redline.docx",
        versionNumber: 4 + persistedIndex,
      });
    },
  );
  const readEntityVersionFileMock = mock(async () =>
    Result.ok(new Uint8Array([1, 2, 3]).buffer),
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
  const dependencies = asTestRaw<Dependencies>({
    applyDisposition: applyDispositionMock,
    compareDocx: compareDocxMock,
    createEntityVersionFromBuffer: createEntityVersionFromBufferMock,
    readEntityVersionFile: readEntityVersionFileMock,
    resolveDocxEditAuthorName: async () => "Ada Lovelace",
    withTimeout: withTimeoutMock,
  });
  const definition = createDocumentCompareHandler(dependencies);
  type Ctx = Parameters<typeof definition.handler>[0];
  const auditRecorder = mock(async () => {});
  const context = asTestRaw<Ctx>({
    body: {
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
    auditRecorder,
    compareDocxMock,
    context,
    createEntityVersionFromBufferMock,
    definition,
    readEntityVersionFileMock,
    withTimeoutMock,
  };
};

describe("documents.compare", () => {
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
          changes: [],
          verification: { status: "verified" },
          unsupported: [],
        },
      ],
    });
    expect(
      harness.applyDispositionMock.mock.calls.map((call) => call[1]),
    ).toEqual(["accept", "reject"]);
    expect(harness.compareDocxMock.mock.calls.at(0)?.[2]).toEqual({
      author: "Ada Lovelace",
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
        sourceVersionId: firstTargetId,
      },
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
        },
      ],
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
  });

  test("returns a named timeout failure without persisting", async () => {
    const harness = createHarness({ timeoutLabel: "documents.compare.folio" });

    const result = await harness.definition.handler(harness.context);

    expect(result).toMatchObject({
      results: [{ status: "failed", error: { code: "timeout" } }],
    });
    expect(harness.createEntityVersionFromBufferMock).not.toHaveBeenCalled();
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
