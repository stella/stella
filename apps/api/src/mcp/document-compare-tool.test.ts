import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import type { CompareResult } from "@stll/folio-core";

import type {
  DocumentCompareProps,
  DocumentCompareResponse,
} from "@/api/handlers/documents/compare";
import { toSafeId } from "@/api/lib/branded-types";
import type { McpRequestContext } from "@/api/mcp/context";
import { handleCompareDocumentsTool } from "@/api/mcp/document-compare-tool";
import type { CompareDocumentsDependencies } from "@/api/mcp/document-compare-tool";
import type {
  FileComparisonRunOptions,
  FileComparisonRunOutcome,
} from "@/api/mcp/file-comparison-run";
import { notFoundResult } from "@/api/mcp/tool-utils";
import { DOCX_MIME_TYPE, PDF_MIME_TYPE } from "@/api/mime-types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const DOCUMENT_ID = "22222222-2222-4222-8222-222222222222";
const BASE_VERSION_ID = "33333333-3333-4333-8333-333333333333";
const TARGET_VERSION_ID = "44444444-4444-4444-8444-444444444444";
const AGREEMENT_PROPERTY_ID = "55555555-5555-4555-8555-555555555555";
const EXHIBIT_PROPERTY_ID = "66666666-6666-4666-8666-666666666666";
const BASE_UPLOAD_ID = "77777777-7777-4777-8777-777777777777";
const TARGET_UPLOAD_ID = "88888888-8888-4888-8888-888888888888";

type FieldRow = {
  versionId: string;
  propertyId: string;
  propertyName: string;
  content: { type: string; mimeType?: string; encrypted?: boolean };
};

const docxField = (versionId: string, propertyId: string, name: string) => ({
  versionId,
  propertyId,
  propertyName: name,
  content: { type: "file", mimeType: DOCX_MIME_TYPE, encrypted: false },
});

const createHarness = ({
  fieldRows = [
    docxField(BASE_VERSION_ID, AGREEMENT_PROPERTY_ID, "Agreement"),
    docxField(TARGET_VERSION_ID, AGREEMENT_PROPERTY_ID, "Agreement"),
  ],
  response = { results: [] } satisfies DocumentCompareResponse,
  uploadsOutcome,
}: {
  fieldRows?: FieldRow[];
  response?: DocumentCompareResponse;
  uploadsOutcome?: FileComparisonRunOutcome;
} = {}) => {
  const comparedWith: DocumentCompareProps[] = [];
  const ranUploads: FileComparisonRunOptions[] = [];

  const builder = {
    select: () => builder,
    from: () => builder,
    innerJoin: () => builder,
    where: () => builder,
    limit: async () => await Promise.resolve(fieldRows),
  };
  const { safeDb, scopedDb } = createScopedDbMock({
    query: {
      entities: {
        findFirst: async () =>
          await Promise.resolve({
            workspaceId: toSafeId<"workspace">(WORKSPACE_ID),
            kind: "document",
            name: "Agreement",
          }),
      },
    },
    select: builder.select,
  });

  const context = asTestRaw<McpRequestContext>({
    accessibleWorkspaceIds: [toSafeId<"workspace">(WORKSPACE_ID)],
    accessibleWorkspaceIdSet: new Set([WORKSPACE_ID]),
    accessibleWorkspaceStatusById: new Map([[WORKSPACE_ID, "active"]]),
    accessibleWorkspaces: [
      { id: toSafeId<"workspace">(WORKSPACE_ID), status: "active" },
    ],
    grantedScopes: ["stella:documents_write"],
    memberRole: "owner",
    organizationId: toSafeId<"organization">("org_1"),
    recordAuditEvent: async () => {
      await Promise.resolve();
    },
    safeDb,
    scopedDb,
    userId: toSafeId<"user">("user_1"),
  });

  const compare: CompareDocumentsDependencies["compare"] = (props) =>
    (async function* () {
      comparedWith.push(props);
      // The real generator reads the document before comparing; the fake only
      // records what it was asked to compare.
      yield* Result.await(Promise.resolve(Result.ok(undefined)));
      return Result.ok(response);
    })();

  const runFileComparison: CompareDocumentsDependencies["runFileComparison"] =
    async (options) => {
      ranUploads.push(options);
      return await Promise.resolve(
        uploadsOutcome ?? {
          status: "error",
          response: notFoundResult("no staged uploads", "stage them first"),
        },
      );
    };

  return {
    comparedWith,
    context,
    ranUploads,
    run: async (args: Record<string, unknown>) =>
      await handleCompareDocumentsTool(
        { args, context },
        { compare, runFileComparison },
      ),
  };
};

const versionsArgs = (overrides: Record<string, unknown> = {}) => ({
  source: {
    type: "versions",
    document_id: DOCUMENT_ID,
    base_version_id: BASE_VERSION_ID,
    target_version_ids: [TARGET_VERSION_ID],
  },
  base_tracked_changes: "accept",
  target_tracked_changes: "accept",
  output_mode: "version",
  ...overrides,
});

type CompareToolResult = Awaited<ReturnType<typeof handleCompareDocumentsTool>>;

const errorOf = (result: CompareToolResult) => {
  if (
    "egress" in result ||
    result.status !== "error" ||
    result.error.type !== "structured"
  ) {
    throw new Error(
      `Expected a structured error, got ${JSON.stringify(result)}`,
    );
  }
  return result.error;
};

const dataOf = (result: CompareToolResult) => {
  if ("egress" in result || result.status !== "success") {
    throw new Error(`Expected success, got ${JSON.stringify(result)}`);
  }
  return result.data;
};

describe("compare_documents", () => {
  test("compares the requested base against every target of a versions source", async () => {
    const harness = createHarness();

    const result = await harness.run(versionsArgs());

    expect(dataOf(result)).toEqual({ results: [] });
    expect(harness.comparedWith).toHaveLength(1);
    expect(harness.comparedWith.at(0)?.body).toMatchObject({
      filePropertyId: AGREEMENT_PROPERTY_ID,
      selection: {
        type: "versions",
        baseVersionId: BASE_VERSION_ID,
        targetVersionIds: [TARGET_VERSION_ID],
      },
      baseTrackedChanges: "accept",
      targetTrackedChanges: "accept",
      mode: "strict",
      granularity: "word",
      output: { type: "version" },
    });
    expect(harness.comparedWith.at(0)?.params).toEqual({
      workspaceId: toSafeId<"workspace">(WORKSPACE_ID),
      documentId: toSafeId<"entity">(DOCUMENT_ID),
    });
  });

  test("compares a previous source against the predecessor the handler picks", async () => {
    const harness = createHarness({
      fieldRows: [
        docxField(TARGET_VERSION_ID, AGREEMENT_PROPERTY_ID, "Agreement"),
      ],
    });

    const result = await harness.run({
      source: {
        type: "previous",
        document_id: DOCUMENT_ID,
        target_version_id: TARGET_VERSION_ID,
      },
      base_tracked_changes: "keep",
      target_tracked_changes: "reject",
      output_mode: "preview",
    });

    expect(dataOf(result)).toEqual({ results: [] });
    expect(harness.comparedWith.at(0)?.body).toMatchObject({
      selection: { type: "previous", targetVersionId: TARGET_VERSION_ID },
      baseTrackedChanges: "keep",
      targetTrackedChanges: "reject",
      output: { type: "preview" },
    });
  });

  test("names the candidates instead of guessing between several DOCX properties", async () => {
    const harness = createHarness({
      fieldRows: [
        docxField(BASE_VERSION_ID, AGREEMENT_PROPERTY_ID, "Agreement"),
        docxField(TARGET_VERSION_ID, AGREEMENT_PROPERTY_ID, "Agreement"),
        docxField(BASE_VERSION_ID, EXHIBIT_PROPERTY_ID, "Exhibit"),
        docxField(TARGET_VERSION_ID, EXHIBIT_PROPERTY_ID, "Exhibit"),
      ],
    });

    const error = errorOf(await harness.run(versionsArgs()));

    expect(error.code).toBe("validation_error");
    expect(error.hint).toContain(AGREEMENT_PROPERTY_ID);
    expect(error.hint).toContain(EXHIBIT_PROPERTY_ID);
    expect(error.hint).toContain("source.file_property_id");
    expect(error.issues?.map(({ path }) => path)).toEqual([
      "source.file_property_id",
      "source.file_property_id",
    ]);
    // The refusal is the point: a wrong pick redlines the wrong file.
    expect(harness.comparedWith).toHaveLength(0);
  });

  test("uses an explicitly named file property without resolving one", async () => {
    const harness = createHarness({
      fieldRows: [
        docxField(BASE_VERSION_ID, AGREEMENT_PROPERTY_ID, "Agreement"),
        docxField(TARGET_VERSION_ID, AGREEMENT_PROPERTY_ID, "Agreement"),
        docxField(BASE_VERSION_ID, EXHIBIT_PROPERTY_ID, "Exhibit"),
        docxField(TARGET_VERSION_ID, EXHIBIT_PROPERTY_ID, "Exhibit"),
      ],
    });

    const result = await harness.run(
      versionsArgs({
        source: {
          type: "versions",
          document_id: DOCUMENT_ID,
          base_version_id: BASE_VERSION_ID,
          target_version_ids: [TARGET_VERSION_ID],
          file_property_id: EXHIBIT_PROPERTY_ID,
        },
      }),
    );

    expect(dataOf(result)).toEqual({ results: [] });
    expect(harness.comparedWith.at(0)?.body.filePropertyId).toBe(
      toSafeId<"property">(EXHIBIT_PROPERTY_ID),
    );
  });

  test("reports a document that stores no DOCX on the versions being compared", async () => {
    const harness = createHarness({
      fieldRows: [
        {
          versionId: BASE_VERSION_ID,
          propertyId: AGREEMENT_PROPERTY_ID,
          propertyName: "Scan",
          content: { type: "file", mimeType: PDF_MIME_TYPE, encrypted: false },
        },
      ],
    });

    const error = errorOf(await harness.run(versionsArgs()));

    expect(error.code).toBe("not_found");
    expect(error.hint).toContain("list_properties");
    expect(harness.comparedWith).toHaveLength(0);
  });

  test("rejects a malformed version id at the boundary, naming the field", async () => {
    const harness = createHarness();

    const error = errorOf(
      await harness.run(
        versionsArgs({
          source: {
            type: "versions",
            document_id: DOCUMENT_ID,
            base_version_id: "not-a-uuid",
            target_version_ids: [TARGET_VERSION_ID],
          },
        }),
      ),
    );

    expect(error.code).toBe("validation_error");
    expect(error.issues?.map(({ path }) => path)).toContain(
      "source.base_version_id",
    );
    expect(harness.comparedWith).toHaveLength(0);
  });

  test("summarises the changes by kind and never returns the change list", async () => {
    const change = (kind: string) => ({
      kind,
      location: { story: { type: "main" } },
      targetBlockId: "1",
      after: "text",
    });
    const harness = createHarness({
      response: asTestRaw<DocumentCompareResponse>({
        results: [
          {
            status: "previewed",
            baseVersionId: toSafeId<"entityVersion">(BASE_VERSION_ID),
            targetVersionId: toSafeId<"entityVersion">(TARGET_VERSION_ID),
            changes: [change("insert"), change("insert"), change("delete")],
            verification: { status: "verified" },
            unsupported: [],
            compatibility: { status: "standard-ooxml" },
          },
        ],
      }),
    });

    const data = dataOf(await harness.run(versionsArgs()));

    expect(data).toEqual({
      results: [
        {
          status: "previewed",
          baseVersionId: BASE_VERSION_ID,
          targetVersionId: TARGET_VERSION_ID,
          changeCount: 3,
          changeCountsByKind: { insert: 2, delete: 1 },
          verification: { status: "verified" },
          compatibility: { status: "standard-ooxml" },
          unsupported: [],
        },
      ],
    });
    expect(JSON.stringify(data)).not.toContain('"changes"');
  });

  test("returns a temporary link for a stored-version download, saving no version", async () => {
    const harness = createHarness({
      response: asTestRaw<DocumentCompareResponse>({
        results: [
          {
            status: "downloadable",
            baseVersionId: toSafeId<"entityVersion">(BASE_VERSION_ID),
            targetVersionId: toSafeId<"entityVersion">(TARGET_VERSION_ID),
            fileName: "Agreement v2 redline.docx",
            download: {
              downloadUrl: "https://s3.example/stored-redline",
              expiresAt: "t",
            },
            changes: [{ kind: "insert" }],
            verification: { status: "verified" },
            unsupported: [],
            compatibility: { status: "standard-ooxml" },
          },
        ],
      }),
    });

    const data = dataOf(
      await harness.run(versionsArgs({ output_mode: "download" })),
    );

    expect(harness.comparedWith.at(0)?.body.output).toEqual({
      type: "download",
    });
    expect(data).toEqual({
      results: [
        {
          status: "downloadable",
          baseVersionId: BASE_VERSION_ID,
          targetVersionId: TARGET_VERSION_ID,
          fileName: "Agreement v2 redline.docx",
          download: {
            downloadUrl: "https://s3.example/stored-redline",
            expiresAt: "t",
          },
          changeCount: 1,
          changeCountsByKind: { insert: 1 },
          verification: { status: "verified" },
          compatibility: { status: "standard-ooxml" },
          unsupported: [],
        },
      ],
    });
    // A stored-version download names versions, never upload ids.
    expect(JSON.stringify(data)).not.toContain("UploadId");
  });
});

describe("compare_documents uploads source", () => {
  const uploadsArgs = (overrides: Record<string, unknown> = {}) => ({
    source: {
      type: "uploads",
      base_upload_id: BASE_UPLOAD_ID,
      target_upload_id: TARGET_UPLOAD_ID,
    },
    base_tracked_changes: "accept",
    target_tracked_changes: "accept",
    output_mode: "download",
    ...overrides,
  });

  test("passes the staged pair through and returns one downloadable result", async () => {
    const harness = createHarness({
      uploadsOutcome: {
        status: "ok",
        result: {
          status: "upload_downloadable",
          baseUploadId: BASE_UPLOAD_ID,
          comparison: asTestRaw<CompareResult>({
            changes: [{ kind: "insert" }, { kind: "insert" }],
            compatibility: { status: "standard-ooxml" },
            unsupported: [],
            verification: { status: "verified" },
          }),
          download: {
            downloadUrl: "https://s3.example/redline",
            expiresAt: "t",
          },
          fileName: "Revised redline.docx",
          scanWarnings: [],
          targetUploadId: TARGET_UPLOAD_ID,
        },
      },
    });

    const data = dataOf(await harness.run(uploadsArgs()));

    expect(harness.ranUploads.at(0)).toMatchObject({
      baseUploadId: BASE_UPLOAD_ID,
      outputMode: "download",
      targetUploadId: TARGET_UPLOAD_ID,
    });
    expect(data).toEqual({
      results: [
        {
          status: "upload_downloadable",
          baseUploadId: BASE_UPLOAD_ID,
          targetUploadId: TARGET_UPLOAD_ID,
          fileName: "Revised redline.docx",
          download: {
            downloadUrl: "https://s3.example/redline",
            expiresAt: "t",
          },
          changeCount: 2,
          changeCountsByKind: { insert: 2 },
          verification: { status: "verified" },
          compatibility: { status: "standard-ooxml" },
          unsupported: [],
        },
      ],
    });
    // The change list is the document, not a report on it.
    expect(JSON.stringify(data)).not.toContain('"changes"');
  });

  test("refuses output_mode version, naming the modes this source takes", async () => {
    const harness = createHarness();

    const error = errorOf(
      await harness.run(uploadsArgs({ output_mode: "version" })),
    );

    expect(error.code).toBe("validation_error");
    expect(error.hint).toContain("preview or download");
    expect(harness.ranUploads).toHaveLength(0);
  });

  test("never reaches the stored-version path for a staged pair", async () => {
    const harness = createHarness({
      uploadsOutcome: {
        status: "error",
        response: notFoundResult("gone", "stage them again"),
      },
    });

    const error = errorOf(await harness.run(uploadsArgs()));

    expect(error.code).toBe("not_found");
    expect(harness.comparedWith).toHaveLength(0);
  });
});
