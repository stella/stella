import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import JSZip from "jszip";

import {
  entities,
  WORK_OBLIGATION_STATUS,
  workObligations,
} from "@/api/db/schema";
import { env } from "@/api/env";
import { envBase } from "@/api/env-base";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { toSafeId } from "@/api/lib/branded-types";
import { caseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";
import { encryptContent } from "@/api/lib/content-encryption";
import type { EncryptedContent } from "@/api/lib/content-encryption";
import { TimeoutError } from "@/api/lib/errors/tagged-errors";
import { createFileKey } from "@/api/lib/file-key";
import { encodePaginationCursor } from "@/api/lib/pagination";
import { pgFtsProvider } from "@/api/lib/search/pg-fts-provider";
import type { SearchHit, SearchResult } from "@/api/lib/search/types";
import type { withTimeout } from "@/api/lib/with-timeout";
import type { McpRequestContext } from "@/api/mcp/context";
import { deriveContactDisplayName } from "@/api/mcp/matter-tools";
import {
  findUndeclaredArguments,
  getMcpToolDefinition,
  getMcpToolRequiredScopesHint,
  handleMcpToolCall,
  isDocumentsMcpCapabilityAllowed,
  listMcpTools,
} from "@/api/mcp/tools";
import { DOCX_MIME_TYPE, PDF_MIME_TYPE } from "@/api/mime-types";
import { startFakeS3 } from "@/api/tests/helpers/fake-s3";
import type { FakeS3 } from "@/api/tests/helpers/fake-s3";
import { installRecordingAnalytics } from "@/api/tests/helpers/recording-telemetry";
import type { RecordingAnalytics } from "@/api/tests/helpers/recording-telemetry";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createScopedDbMock, toSafeDbMock } from "@/api/tests/scoped-db-mock";

/**
 * Minimal DOCX with a Heading1 paragraph, a two-row table, and a body
 * paragraph, for exercising `docxToMarkdown`'s real (unmocked) conversion in
 * `read_content_across_matters`'s markdown branch.
 */
const makeDocxBytes = async () => {
  const zip = new JSZip();
  zip.file(
    "word/document.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>
  <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Agreement</w:t></w:r></w:p>
  <w:tbl>
    <w:tr>
      <w:tc><w:p><w:r><w:t>Party</w:t></w:r></w:p></w:tc>
      <w:tc><w:p><w:r><w:t>Role</w:t></w:r></w:p></w:tc>
    </w:tr>
    <w:tr>
      <w:tc><w:p><w:r><w:t>Acme s.r.o.</w:t></w:r></w:p></w:tc>
      <w:tc><w:p><w:r><w:t>Seller</w:t></w:r></w:p></w:tc>
    </w:tr>
  </w:tbl>
  <w:p><w:r><w:t>Signed below.</w:t></w:r></w:p>
</w:body></w:document>`,
  );
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="xml" ContentType="application/xml"/>
</Types>`,
  );
  const bytes = await zip.generateAsync({ type: "uint8array" });
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  );
};

const ORGANIZATION_ID = toSafeId<"organization">("org_1");

/**
 * Id fixtures. Every id that reaches a Postgres `uuid` column is validated as
 * a UUID by the tool input schemas, so the fixtures are uuid-shaped and each
 * one is spelled once: the mocked context, the mocked rows, the tool arguments
 * and the expectations all read the same constant.
 */
const WORKSPACE_ID = "00000000-0000-4000-8000-0000000a0001";
const WORKSPACE_ID_2 = "00000000-0000-4000-8000-0000000a0002";
const WORKSPACE_ID_3 = "00000000-0000-4000-8000-0000000a0003";
const CONTACT_ID = "00000000-0000-4000-8000-0000000c0001";
const DECISION_ID = "00000000-0000-4000-8000-0000000d0001";
/** A document entity, used where a tool is handed one in place of a task. */
const DOCUMENT_ENTITY_ID = "00000000-0000-4000-8000-0000000e0d01";
const FOLDER_ENTITY_ID = "00000000-0000-4000-8000-0000000e0f01";
const ENTITY_LINK_ID = "00000000-0000-4000-8000-0000000b0001";
const FILE_PROPERTY_ID = "00000000-0000-4000-8000-0000000f0001";
const TEXT_PROPERTY_ID = "00000000-0000-4000-8000-0000000f0002";
const TIME_ENTRY_ID = "00000000-0000-4000-8000-000000010001";
const BASE_VERSION_ID = "00000000-0000-4000-8000-000000090001";

/**
 * The object store the tools really read through: `startFakeS3` points
 * `lib/s3` at an in-process S3, so the key derivation, the presigned read and
 * the DOCX conversion are all part of what these tests prove. A DOCX branch
 * seeds the one key it expects to be read; a test that must not reach the
 * store asserts on `fake.requests` instead.
 */
let fake: FakeS3;

/** Object reads that reached the store, in order. */
const objectReadKeys = (): string[] =>
  fake.requests.filter(({ method }) => method === "GET").map(({ key }) => key);

const docxKey = (fileId: string, workspaceId = WORKSPACE_ID): string =>
  createFileKey({
    organizationId: ORGANIZATION_ID,
    workspaceId: toSafeId<"workspace">(workspaceId),
    fileId,
    mimeType: DOCX_MIME_TYPE,
  });

/** Put the DOCX fixture where the tool will look for that file's bytes. */
const seedDocxFile = async (fileId: string, workspaceId = WORKSPACE_ID) => {
  fake.put(
    envBase.S3_BUCKET,
    docxKey(fileId, workspaceId),
    new Uint8Array(await makeDocxBytes()),
    DOCX_MIME_TYPE,
  );
};

// Default passthrough: just await the wrapped operation, so every existing
// test exercises the real S3-read-and-convert logic unchanged. Individual
// tests override this with `mockImplementationOnce` to simulate the
// operation timing out, without an actual wall-clock wait.
const withTimeoutMock = mock(
  async (operation: () => Promise<unknown>) => await operation(),
);
const withTimeoutDependency = asTestRaw<typeof withTimeout>(withTimeoutMock);

const anonymizeTextFieldsMock = mock();
/** Empty catalogs, one entry per requested id, like the real loaders. */
const emptyCatalogsByWorkspace = async ({
  workspaceIds,
}: {
  workspaceIds: readonly string[];
}) =>
  await Promise.resolve(
    new Map(workspaceIds.map((workspaceId) => [workspaceId, []])),
  );
const loadGazetteerByWorkspaceMock = mock(emptyCatalogsByWorkspace);
const loadAllowlistByWorkspaceMock = mock(emptyCatalogsByWorkspace);
const searchAcrossMattersExecute = mock();
const readContentAcrossMattersExecute = mock();
const readContactExecute = mock();
type MockSearchHit = {
  entityId: string;
  headline?: string | null;
  kind?: SearchHit["kind"];
  name: string;
  workspaceId: string;
  workspaceName?: string;
};
const searchProviderSearchMock = mock(
  async (input: { limit: number; query: string }): Promise<SearchResult> => {
    const result = await searchAcrossMattersExecute(
      {
        limit: input.limit,
        query: input.query,
      },
      {
        messages: [],
        toolCallId: "mcp",
      },
    );
    const hits: MockSearchHit[] =
      typeof result === "object" &&
      result !== null &&
      "hits" in result &&
      Array.isArray(result.hits)
        ? result.hits
        : [];

    return {
      facets: { kind: [], workspace: [] },
      totalCount:
        typeof result === "object" &&
        result !== null &&
        "totalCount" in result &&
        typeof result.totalCount === "number"
          ? result.totalCount
          : hits.length,
      hits: hits.map((hit) => ({
        entityId: toSafeId<"entity">(hit.entityId),
        workspaceId: toSafeId<"workspace">(hit.workspaceId),
        workspaceName: hit.workspaceName ?? "Matter Alpha",
        title: hit.name,
        kind: hit.kind ?? "document",
        headline: hit.headline ?? null,
        updatedAt: "2026-01-01T00:00:00.000Z",
      })),
      nextCursor: null,
    };
  },
);
const searchDecisionsHandlerMock = mock();
const readDecisionHandlerMock = mock();
/** The gate-and-read the tool calls; null is a denied or missing subject. */
const readGatedDecisionMock = mock();
/** The subject gate: passes whatever id it is given as redistributable. */
const withRedistributableSubjectMock = mock();
const APP_BASE_URL = env.FRONTEND_URL.replace(/\/$/u, "");

const readWorkspaceHandlerMock = mock();
const readOverviewHandlerMock = mock();
const readWorkspaceContactsHandlerMock = mock();
const readWorkspaceMembersHandlerMock = mock();

const parseToolPayload = (
  result: Awaited<ReturnType<typeof handleMcpToolCall>>,
) => {
  const item = result.content.at(0);
  expect(item?.type).toBe("text");

  if (!item || item.type !== "text") {
    throw new Error("Expected a text MCP response");
  }

  return JSON.parse(item.text) as unknown;
};

// The structured error envelope is a JSON `{"error":{code,message,hint?,...}}`
// text content with isError set. Assert both the flag and the parsed shape.
const expectErrorEnvelope = (
  result: Awaited<ReturnType<typeof handleMcpToolCall>>,
  expected: {
    code: string;
    message: string;
    hint?: string;
    retryable?: boolean;
  },
) => {
  expect(result.isError).toBe(true);
  expect(parseToolPayload(result)).toEqual({ error: expected });
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// The parsed `error` object of a structured `{ error: { code, message,
// issues? } }` envelope. Throws if the result is not a structured envelope.
const validationEnvelope = (
  result: Awaited<ReturnType<typeof handleMcpToolCall>>,
): Record<string, unknown> => {
  expect(result.isError).toBe(true);
  const payload = parseToolPayload(result);
  if (!isRecord(payload) || !isRecord(payload["error"])) {
    throw new Error("expected a structured error envelope");
  }
  return payload["error"];
};

// Assert a `validation_error` envelope carrying the given human message. The
// structured `issues` are asserted separately in the tests where their
// dot-paths are the point.
const expectValidationMessage = (
  result: Awaited<ReturnType<typeof handleMcpToolCall>>,
  message: string,
): void => {
  const error = validationEnvelope(result);
  expect(error["code"]).toBe("validation_error");
  expect(error["message"]).toBe(message);
};

const featureDisabledHint = (feature: string): string =>
  `This deployment has ${feature} turned off; a server operator enables it by setting ${feature}=true. It cannot be enabled from the client.`;

const createReadDecisionResult = () => ({
  analysis: null,
  caseNumber: "29 Cdo 123/2024",
  citationsFrom: [{ citationText: "29 Odo 1/2001", id: "c_1" }],
  citationsTo: [{ citationText: "31 Cdo 2/2025", id: "c_2" }],
  citationsNextCursor: null,
  country: "CZE",
  court: "Nejvyšší soud",
  decisionDate: new Date("2024-02-01T00:00:00.000Z"),
  decisionType: "judgment",
  documentAst: {
    blocks: [
      {
        anchorId: "a-1",
        id: "b-1",
        inlines: [],
        level: 1,
        plainText: "29 Cdo 123/2024",
        type: "heading",
      },
      {
        anchorId: "a-2",
        id: "b-2",
        inlines: [],
        plainText: "The court dismissed the appeal.",
        type: "paragraph",
      },
    ],
    metadata: {
      caseNumber: "29 Cdo 123/2024",
      court: "Nejvyšší soud",
      decisionDate: "2024-02-01",
      decisionType: "judgment",
      ecli: null,
      keywords: [],
      statutes: [],
    },
    source: {
      documentId: "doc-1",
      printUrl: "https://example.test/print",
      system: "test",
      webUrl: "https://example.test/web",
    },
    version: 1,
  },
  documentUrl: "https://example.test/document.pdf",
  ecli: null,
  fulltext: null,
  id: DECISION_ID,
  language: "cs",
  metadata: { panel: "29 Cdo" },
  slug: "stable-official-slug",
  source: {
    adapterKey: "cz-ns",
    allowsDerivedAi: true,
    id: "src_1",
    name: "Nejvyšší soud",
  },
  sourceUrl: "https://example.test/decision",
});

const createSelectBuilder = (rows: unknown[]) => {
  // `.where()` is terminal for most callers (awaited directly as the row array),
  // but the gateway connector query chains `.orderBy().limit()` after it. Return
  // an array that also answers those builder steps with the same rows so every
  // shape resolves identically; a bare array would make `.orderBy` undefined and
  // turn the connector load into a spurious McpGatewayLoadError.
  const terminal = Object.assign([...rows], {
    groupBy: () => terminal,
    orderBy: () => terminal,
    limit: () => terminal,
  });
  const builder = {
    from: () => builder,
    innerJoin: () => builder,
    leftJoin: () => builder,
    where: () => terminal,
  };

  return builder;
};

type ExtractedContentRow = {
  charCount: number;
  ciphertext: Buffer;
  entityId: string;
  extractedAt: Date;
  entity: {
    kind: string;
    name: string;
    workspaceId: string;
  };
  iv: Buffer;
  sourceEntityVersionId: string | null;
  sourceFieldId: string | null;
  sourceFileId: string | null;
  sourceSha256Hex: string | null;
  workspaceId: string;
};

type MockEqFilter = {
  eq?: unknown;
  in?: unknown[];
};

type MockEntityFindFirstInput = {
  where?: {
    id?: MockEqFilter;
    workspaceId?: MockEqFilter;
  };
};

type MockFieldContent = { type: string; [key: string]: unknown };

type MockProcessingRunQueryInput = {
  where?: {
    fieldId?: MockEqFilter;
    sourceFileId?: MockEqFilter;
    sourceSha256Hex?: MockEqFilter;
  };
  limit?: number;
};

type MockMcpTransaction = {
  query: {
    entities: {
      findFirst: (input?: MockEntityFindFirstInput) => Promise<{
        createdAt: Date;
        kind: string;
        name: string;
        updatedAt: Date;
        workspaceId: string;
        extractedContent: {
          extractedAt: Date;
          sourceEntityVersionId: string | null;
          sourceFieldId: string | null;
          sourceFileId: string | null;
          sourceSha256Hex: string | null;
        } | null;
        versions: { id: string }[];
        currentVersion: {
          createdAt: Date;
          id: string;
          fields: {
            id: string;
            propertyId: string;
            content: MockFieldContent;
          }[];
        } | null;
      } | null>;
    };
    documentProcessingRuns: {
      findMany: (input?: MockProcessingRunQueryInput) => Promise<unknown[]>;
    };
    entityVersions: {
      findFirst: () => Promise<{ id: string } | null>;
    };
    extractedContent: {
      findFirst: () => Promise<ExtractedContentRow | null>;
    };
    fields: {
      findMany: () => Promise<
        {
          content: MockFieldContent;
          id: string;
          propertyId: string;
        }[]
      >;
    };
    organizationSettings: {
      findFirst: () => Promise<{ documentProcessingMode: string }>;
    };
    searchDocuments: {
      findFirst: () => Promise<{ updatedAt: Date } | undefined>;
    };
  };
  select: () => ReturnType<typeof createSelectBuilder>;
};

/**
 * The projection ships real AES-GCM ciphertext, encrypted under the same
 * organization the request context carries, so the tools run the production
 * `decryptContent`. Tests that need different text pass their own
 * `encryptContent(ORGANIZATION_ID, ...)` envelope.
 */
const DEFAULT_EXTRACTED_TEXT = "Full document text";
const DEFAULT_EXTRACTED_CONTENT = await encryptContent(
  ORGANIZATION_ID,
  DEFAULT_EXTRACTED_TEXT,
);

const createExtractedContentRow = ({
  charCount = 321,
  encrypted = DEFAULT_EXTRACTED_CONTENT,
  entityId = "00000000-0000-4000-8000-0000000e0001",
  name = "Share Purchase Agreement",
  workspaceId = WORKSPACE_ID,
  sourceEntityVersionId = null,
  sourceFieldId = null,
  sourceFileId = null,
  sourceSha256Hex = null,
}: {
  charCount?: number;
  encrypted?: EncryptedContent;
  entityId?: string;
  name?: string;
  workspaceId?: string;
  sourceEntityVersionId?: string | null;
  sourceFieldId?: string | null;
  sourceFileId?: string | null;
  sourceSha256Hex?: string | null;
} = {}): ExtractedContentRow => ({
  charCount,
  ciphertext: encrypted.ciphertext,
  entityId,
  extractedAt: new Date("2026-01-02T00:00:00.000Z"),
  entity: {
    kind: "document",
    name,
    workspaceId,
  },
  iv: encrypted.iv,
  sourceEntityVersionId,
  sourceFieldId,
  sourceFileId,
  sourceSha256Hex,
  workspaceId,
});

// Non-DOCX file stub (no `mimeType`) so every pre-existing `createScopedDb`
// caller keeps exercising the plaintext fallback path unchanged.
const DEFAULT_CURRENT_VERSION_FILE_CONTENT: MockFieldContent = {
  type: "file",
};

const createScopedDb = (
  rows: unknown[] = [],
  extractedContentRow: ExtractedContentRow | null = null,
  // The current version's field contents, in field order. Pass a DOCX
  // `FieldContent` as the sole entry to exercise the live docx-to-markdown
  // branch, or provide provenance that selects one entry in a multi-file
  // version.
  currentVersionFields: MockFieldContent[] = [
    DEFAULT_CURRENT_VERSION_FILE_CONTENT,
  ],
  currentDocument: {
    entityId: string;
    kind: string;
    name: string;
    workspaceId: string;
  } | null = extractedContentRow
    ? {
        entityId: extractedContentRow.entityId,
        kind: extractedContentRow.entity.kind,
        name: extractedContentRow.entity.name,
        workspaceId: extractedContentRow.workspaceId,
      }
    : null,
  processingState: {
    documentProcessingMode?: "off" | "searchable-text";
    latestVersionId?: string;
    runs?: unknown[];
    searchUpdatedAt?: Date | null;
  } = {},
) =>
  asTestRaw<McpRequestContext["scopedDb"] & ReturnType<typeof mock>>(
    mock(
      async (callback: (tx: MockMcpTransaction) => unknown) =>
        await callback({
          query: {
            entities: {
              findFirst: async ({ where }: MockEntityFindFirstInput = {}) => {
                if (!currentDocument) {
                  return null;
                }

                const allowedWorkspaces = where?.workspaceId?.in;
                if (
                  where?.id?.eq !== currentDocument.entityId ||
                  (where.workspaceId?.eq !== undefined &&
                    where.workspaceId.eq !== currentDocument.workspaceId) ||
                  (allowedWorkspaces !== undefined &&
                    !allowedWorkspaces.includes(currentDocument.workspaceId))
                ) {
                  return null;
                }

                return {
                  createdAt: new Date("2025-12-01T00:00:00.000Z"),
                  kind: currentDocument.kind,
                  name: currentDocument.name,
                  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
                  workspaceId: currentDocument.workspaceId,
                  extractedContent: extractedContentRow
                    ? {
                        extractedAt: extractedContentRow.extractedAt,
                        sourceEntityVersionId:
                          extractedContentRow.sourceEntityVersionId,
                        sourceFieldId: extractedContentRow.sourceFieldId,
                        sourceFileId: extractedContentRow.sourceFileId,
                        sourceSha256Hex: extractedContentRow.sourceSha256Hex,
                      }
                    : null,
                  versions: [{ id: "entity_version_1" }],
                  currentVersion: {
                    createdAt: new Date("2026-01-01T00:00:00.000Z"),
                    id: "entity_version_1",
                    fields: currentVersionFields.map((content, index) => ({
                      id: `field_${index + 1}`,
                      propertyId: `property_${index + 1}`,
                      content,
                    })),
                  },
                };
              },
            },
            extractedContent: {
              findFirst: async () => extractedContentRow,
            },
            documentProcessingRuns: {
              findMany: async (input) => {
                const filtered = (processingState.runs ?? []).filter((run) => {
                  if (typeof run !== "object" || run === null) {
                    return true;
                  }
                  const sourceFileId =
                    "sourceFileId" in run ? run.sourceFileId : undefined;
                  const sourceSha256Hex =
                    "sourceSha256Hex" in run ? run.sourceSha256Hex : undefined;
                  const fieldId = "fieldId" in run ? run.fieldId : "field_1";
                  return (
                    (input?.where?.fieldId?.eq === undefined ||
                      fieldId === input.where.fieldId.eq) &&
                    (input?.where?.sourceFileId?.eq === undefined ||
                      sourceFileId === input.where.sourceFileId.eq) &&
                    (input?.where?.sourceSha256Hex?.eq === undefined ||
                      sourceSha256Hex === input.where.sourceSha256Hex.eq)
                  );
                });
                const selected =
                  input?.limit === undefined
                    ? filtered
                    : filtered.slice(0, input.limit);
                return selected.map((run) =>
                  typeof run === "object" && run !== null && !("fieldId" in run)
                    ? Object.assign(run, {
                        fieldId: input?.where?.fieldId?.eq,
                      })
                    : run,
                );
              },
            },
            entityVersions: {
              findFirst: async () => ({
                id: processingState.latestVersionId ?? "entity_version_1",
              }),
            },
            fields: {
              findMany: async () => [
                {
                  content: { type: "file" },
                  id: "field_1",
                  propertyId: "property_1",
                },
              ],
            },
            organizationSettings: {
              findFirst: async () => ({
                documentProcessingMode:
                  processingState.documentProcessingMode ?? "off",
              }),
            },
            searchDocuments: {
              findFirst: async () =>
                processingState.searchUpdatedAt === undefined ||
                processingState.searchUpdatedAt === null
                  ? undefined
                  : { updatedAt: processingState.searchUpdatedAt },
            },
          },
          select: () => createSelectBuilder(rows),
        }),
    ),
  );

const createRecordAuditEventMock = () =>
  asTestRaw<AuditRecorder & ReturnType<typeof mock>>(
    mock(async () => undefined),
  );

const createContext = ({
  accessibleWorkspaceIds = [WORKSPACE_ID],
  archivedWorkspaceIds = [],
  recordAuditEvent = createRecordAuditEventMock(),
  scopedDb = createScopedDb(),
}: {
  accessibleWorkspaceIds?: string[];
  archivedWorkspaceIds?: string[];
  recordAuditEvent?: AuditRecorder;
  scopedDb?: McpRequestContext["scopedDb"];
} = {}): McpRequestContext => ({
  accessibleWorkspaceIds: accessibleWorkspaceIds.map((workspaceId) =>
    toSafeId<"workspace">(workspaceId),
  ),
  accessibleWorkspaceIdSet: new Set(accessibleWorkspaceIds),
  accessibleWorkspaceStatusById: new Map(
    accessibleWorkspaceIds.map((workspaceId) => [
      workspaceId,
      archivedWorkspaceIds.includes(workspaceId) ? "archived" : "active",
    ]),
  ),
  accessibleWorkspaces: [],
  grantedScopes: [],
  memberRole: "owner",
  organizationId: toSafeId<"organization">("org_1"),
  recordAuditEvent,
  safeDb: toSafeDbMock(scopedDb),
  scopedDb,
  testDependencies: {
    anonymizeTextFields: anonymizeTextFieldsMock,
    getSearchProvider: () => ({
      ...pgFtsProvider,
      search: searchProviderSearchMock,
    }),
    loadAnonymizationAllowlistCanonicalsByWorkspace:
      loadAllowlistByWorkspaceMock,
    loadAnonymizationGazetteerEntriesByWorkspace: loadGazetteerByWorkspaceMock,
    readGatedDecisionWithDocument: readGatedDecisionMock,
    readOverviewHandler: readOverviewHandlerMock,
    readWorkspaceContactsHandler: readWorkspaceContactsHandlerMock,
    readWorkspaceHandler: readWorkspaceHandlerMock,
    readWorkspaceMembersHandler: readWorkspaceMembersHandlerMock,
    searchDecisionsHandler: searchDecisionsHandlerMock,
    withTimeout: withTimeoutDependency,
  },
  userId: toSafeId<"user">("user_1"),
});

describe("OpenAI-compatible MCP tools", () => {
  let analytics: RecordingAnalytics;

  beforeEach(() => {
    analytics = installRecordingAnalytics();
    anonymizeTextFieldsMock.mockReset();
    loadGazetteerByWorkspaceMock.mockReset();
    loadGazetteerByWorkspaceMock.mockImplementation(emptyCatalogsByWorkspace);
    loadAllowlistByWorkspaceMock.mockReset();
    loadAllowlistByWorkspaceMock.mockImplementation(emptyCatalogsByWorkspace);
    searchAcrossMattersExecute.mockReset();
    searchProviderSearchMock.mockClear();
    readContentAcrossMattersExecute.mockReset();
    readContactExecute.mockReset();
    searchDecisionsHandlerMock.mockReset();
    readDecisionHandlerMock.mockReset();
    readGatedDecisionMock.mockReset();
    // The gate passes by default and the read answers; a denied subject is
    // set up per test by resolving the gate to null.
    readGatedDecisionMock.mockImplementation(
      async ({ locator, ...rest }: { locator: { kind: "id"; id: string } }) =>
        await readDecisionHandlerMock({ subject: { id: locator.id }, ...rest }),
    );
    withRedistributableSubjectMock.mockReset();
    withRedistributableSubjectMock.mockImplementation(
      async (
        _db: unknown,
        locator: { kind: "id"; id: string },
        read: (subject: { id: string }) => Promise<unknown>,
      ) => await read({ id: locator.id }),
    );
    withTimeoutMock.mockClear();
    fake = startFakeS3();
  });

  afterEach(() => {
    analytics.restore();
    fake.stop();
  });

  afterAll(() => {
    mock.restore();
  });

  test("advertises the exact search compatibility input schema", async () => {
    const searchTool = (await listMcpTools(createContext())).find(
      (tool) => tool.name === "search",
    );

    expect(searchTool?.inputSchema).toEqual({
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query",
          minLength: 1,
          maxLength: 500,
        },
        cursor: {
          type: "string",
          description:
            "Opaque cursor from a previous search call to fetch the next page",
          minLength: 1,
          maxLength: 512,
        },
      },
      required: ["query"],
      additionalProperties: false,
    });
  });

  test("advertises the case-law search tool with filter support", async () => {
    const searchTool = (await listMcpTools(createContext())).find(
      (tool) => tool.name === "search_case_law",
    );

    expect(searchTool?.inputSchema).toEqual({
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query",
          minLength: 1,
          maxLength: 500,
        },
        limit: {
          type: "integer",
          description: "Max results to return",
          minimum: 1,
          maximum: 20,
        },
        cursor: {
          type: "string",
          description: "Opaque cursor from a previous search_case_law call",
          maxLength: 128,
        },
        court: {
          type: "string",
          description: "Filter by court name",
          maxLength: 512,
        },
        country: {
          type: "string",
          description: "Filter by country code",
          maxLength: 3,
        },
        language: {
          type: "string",
          description: "Filter by language code",
          maxLength: 8,
        },
        decision_type: {
          type: "string",
          description: "Filter by decision type",
          maxLength: 128,
        },
        source_id: {
          type: "string",
          format: "uuid",
          description: "Filter by source ID",
        },
        date_from: {
          type: "string",
          description: "Filter decisions from this ISO date (YYYY-MM-DD)",
          maxLength: 10,
        },
        date_to: {
          type: "string",
          description: "Filter decisions up to this ISO date (YYYY-MM-DD)",
          maxLength: 10,
        },
      },
      required: ["query"],
      additionalProperties: false,
    });
  });

  test("requires search scope for the case-law search tool", async () => {
    expect(
      (await getMcpToolDefinition("search_case_law", createContext()))?.scope,
    ).toBe("stella:search");
  });

  test("delete_task is a matter write and confirm-gated like the other deletes", async () => {
    const definition = await getMcpToolDefinition(
      "delete_task",
      createContext(),
    );
    expect(definition?.scope).toBe("stella:matters_write");
    expect(definition?.annotations.destructiveHint).toBe(true);
  });

  test("separates organization-wide contact mutations from matter writes", async () => {
    expect(
      (await getMcpToolDefinition("save_contact", createContext()))?.scope,
    ).toBe("stella:contacts_write");
    expect(
      (await getMcpToolDefinition("delete_contact", createContext()))?.scope,
    ).toBe("stella:contacts_write");
  });

  test("hints dynamic tool scopes from names before resolving definitions", () => {
    expect(getMcpToolRequiredScopesHint("search_case_law")).toEqual([
      "stella:search",
    ]);
    expect(getMcpToolRequiredScopesHint("save_filled_template")).toEqual([
      "stella:documents_write",
      "stella:templates",
    ]);
    expect(getMcpToolRequiredScopesHint("mcp__registry__lookup")).toEqual([
      "stella:external_mcps",
    ]);
    expect(getMcpToolRequiredScopesHint("skill__research")).toEqual([
      "stella:skills",
    ]);
    expect(
      getMcpToolRequiredScopesHint("mcp__registry__lookup", "anonymized"),
    ).toBe(undefined);
  });

  test("does not resolve dynamic definitions for unprefixed unknown tools", async () => {
    const scopedDb = createScopedDb();

    expect(
      await getMcpToolDefinition(
        "not_a_tool",
        createContext({ scopedDb }),
        "default",
      ),
    ).toBe(undefined);
    expect(scopedDb).not.toHaveBeenCalled();
  });

  test("filters listed tools by granted scopes", async () => {
    const scopedDb = createScopedDb();
    const toolNames = (
      await listMcpTools(createContext({ scopedDb }), "default", [
        "stella:read",
      ])
    ).map((tool) => tool.name);

    expect(toolNames).toContain("list_matters");
    expect(toolNames).not.toContain("search_case_law");
    expect(toolNames).not.toContain("set_practice_jurisdictions");
    expect(scopedDb).not.toHaveBeenCalled();
  });

  test("lists the projected read surface in anonymized mode", async () => {
    // The anonymized surface is the registry minus excluded (write / dynamic
    // gateway) tools: every read/search/reference tool, in registry order.
    expect(
      (await listMcpTools(createContext(), "anonymized")).map(
        (tool) => tool.name,
      ),
    ).toEqual([
      "search",
      "fetch",
      "list_matters",
      "search_across_matters",
      "search_case_law",
      "read_content_across_matters",
      "read_case_law_decision",
      "read_contact",
      "list_templates",
      "list_documents",
      "read_document",
      "list_properties",
      "lookup_business_registry",
      "list_tasks",
      "list_clauses",
      "list_playbooks",
      "list_time_entries",
      "resolve_rate",
      "list_invoices",
      "get_usage",
      "search_legislation",
    ]);
  });

  describe("lookup_business_registry org narrowing", () => {
    const registryTool = async (context: McpRequestContext) =>
      (await listMcpTools(context)).find(
        (tool) => tool.name === "lookup_business_registry",
      );

    test("narrows the registry enum to the org's enabled registries", async () => {
      const tool = await registryTool({
        ...createContext(),
        enabledRegistrySlugs: ["orsr", "vies"],
      });

      expect(tool?.inputSchema.properties?.["registry"]).toEqual({
        type: "string",
        enum: ["orsr", "vies"],
        description: "Business register to query",
      });
    });

    test("drops the tool when the org can reach no registry", async () => {
      const tool = await registryTool({
        ...createContext(),
        enabledRegistrySlugs: [],
      });

      expect(tool).toBeUndefined();
    });

    test("leaves the full enum when the enabled set is unresolved", async () => {
      const tool = await registryTool(createContext());

      // A context that never resolved its reachable registries (test/synthetic
      // or a bootstrap read fault) keeps the full advertisement.
      expect(tool?.inputSchema.properties?.["registry"]).toMatchObject({
        enum: expect.arrayContaining(["ares", "vies"]),
      });
    });

    test("refuses a disabled registry with the enablement path, not a bare enum error", async () => {
      // The org declares no practice jurisdictions in the settings mock, so KRS
      // is off on the jurisdiction default rather than an explicit override.
      // The call-time schema still accepts every registry in the dispatch
      // table, so the refusal can say where to enable it instead of failing as
      // an unexplained enum mismatch.
      const result = await handleMcpToolCall({
        args: { registry: "krs", query: "0000592109" },
        context: { ...createContext(), enabledRegistrySlugs: ["ares"] },
        toolName: "lookup_business_registry",
      });

      expectErrorEnvelope(result, {
        code: "feature_disabled",
        message:
          "The KRS registry is disabled for this organization. An " +
          "organization admin can enable it at " +
          `${APP_BASE_URL}/knowledge/tools?slug=krs, or add Poland to the ` +
          "practice jurisdictions.",
        hint:
          "Ask an organization admin to enable KRS at " +
          `${APP_BASE_URL}/knowledge/tools?slug=krs, or to add Poland to the ` +
          "practice jurisdictions. It cannot be enabled from the client.",
      });
    });
  });

  test("remaps case-law tools to anonymized scopes", async () => {
    expect(
      (
        await getMcpToolDefinition(
          "search_case_law",
          createContext(),
          "anonymized",
        )
      )?.scope,
    ).toBe("stella:search_anonymized");
    expect(
      (
        await getMcpToolDefinition(
          "read_case_law_decision",
          createContext(),
          "anonymized",
        )
      )?.scope,
    ).toBe("stella:read_anonymized");
  });

  test("returns only fetchable documents with canonical document URLs", async () => {
    searchAcrossMattersExecute.mockResolvedValue({
      hits: [
        {
          entityId: "00000000-0000-4000-8000-0000000e0001",
          workspaceId: WORKSPACE_ID,
          name: "Share Purchase Agreement",
        },
        {
          entityId: "00000000-0000-4000-8000-0000000e0002",
          workspaceId: WORKSPACE_ID_2,
          name: "Not Fetchable",
        },
      ],
    });

    const result = await handleMcpToolCall({
      args: { query: "share purchase" },
      context: createContext({
        scopedDb: createScopedDb([
          {
            entityId: "00000000-0000-4000-8000-0000000e0001",
            fieldId: "field_1",
            workspaceId: WORKSPACE_ID,
          },
        ]),
      }),
      toolName: "search",
    });

    expect(searchAcrossMattersExecute).toHaveBeenCalledWith(
      {
        limit: 8,
        query: "share purchase",
      },
      {
        messages: [],
        toolCallId: "mcp",
      },
    );

    expect(parseToolPayload(result)).toEqual({
      nextCursor: null,
      results: [
        {
          id: "00000000-0000-4000-8000-0000000e0001",
          title: "Share Purchase Agreement",
          url: `${APP_BASE_URL}/workspaces/${WORKSPACE_ID}/all/pdf?entity=00000000-0000-4000-8000-0000000e0001&field=field_1`,
        },
      ],
    });
  });

  test("fetch returns document text with citation metadata", async () => {
    const context = createContext({
      scopedDb: createScopedDb(
        [],
        createExtractedContentRow({ name: "Share Purchase Agreement" }),
      ),
    });
    const result = await handleMcpToolCall({
      args: { id: "00000000-0000-4000-8000-0000000e0001" },
      context,
      toolName: "fetch",
    });

    expect(parseToolPayload(result)).toEqual({
      id: "00000000-0000-4000-8000-0000000e0001",
      title: "Share Purchase Agreement",
      text: "Full document text",
      url: `${APP_BASE_URL}/workspaces/${WORKSPACE_ID}/all/pdf?entity=00000000-0000-4000-8000-0000000e0001&field=field_1`,
      nextCursor: null,
      metadata: {
        charCount: "Full document text".length,
        source: "stella",
        truncated: false,
        workspaceId: WORKSPACE_ID,
      },
    });
  });

  test("fetch rejects a resource URI passed as an id", async () => {
    // A client that hands the fetch tool a `stella://` resource URI must get a
    // validation_error naming `id` and pointing at resources/read. The id is
    // matched against a uuid column, so reaching the query at all is the
    // Postgres cast failure this once surfaced as internal_error.
    const result = await handleMcpToolCall({
      args: { id: "stella://reference/template-markers" },
      context: createContext({
        scopedDb: asTestRaw<McpRequestContext["scopedDb"]>(() => {
          throw new Error("the malformed id must never reach the database");
        }),
      }),
      toolName: "fetch",
    });

    const error = validationEnvelope(result);
    expect(error["code"]).toBe("validation_error");
    expect(error["issues"]).toEqual([
      {
        path: "id",
        message: 'Invalid UUID: Received "stella://reference/template-markers"',
      },
    ]);
    expect(error["hint"]).toContain("resources/read");
  });

  test("fetch pages long document text via the returned cursor", async () => {
    const longText = "x".repeat(8000) + "y".repeat(1000);
    const context = createContext({
      scopedDb: createScopedDb(
        [],
        createExtractedContentRow({
          encrypted: await encryptContent(ORGANIZATION_ID, longText),
        }),
      ),
    });

    const first = asTestRaw<{
      text: string;
      nextCursor: string | null;
      metadata: { charCount: number; truncated: boolean };
    }>(
      parseToolPayload(
        await handleMcpToolCall({
          args: { id: "00000000-0000-4000-8000-0000000e0001" },
          context,
          toolName: "fetch",
        }),
      ),
    );
    expect(first.text).toBe("x".repeat(8000));
    expect(first.metadata.charCount).toBe(9000);
    expect(first.metadata.truncated).toBe(true);
    expect(first.nextCursor).not.toBeNull();

    const second = asTestRaw<{
      text: string;
      nextCursor: string | null;
      metadata: { truncated: boolean };
    }>(
      parseToolPayload(
        await handleMcpToolCall({
          args: {
            id: "00000000-0000-4000-8000-0000000e0001",
            cursor: first.nextCursor,
          },
          context,
          toolName: "fetch",
        }),
      ),
    );
    expect(second.text).toBe("y".repeat(1000));
    expect(second.metadata.truncated).toBe(false);
    expect(second.nextCursor).toBeNull();
  });

  test("search_case_law maps filters and returns decision links", async () => {
    searchDecisionsHandlerMock.mockResolvedValue({
      facets: {
        country: [{ count: 1, value: "CZE" }],
        court: [{ count: 1, value: "Nejvyšší soud" }],
        language: [{ count: 1, value: "cs" }],
      },
      hits: [
        {
          caseNumber: "29 Cdo 123/2024",
          citationCount: 7,
          country: "CZE",
          court: "Nejvyšší soud",
          decisionDate: "2024-02-01",
          decisionId: DECISION_ID,
          decisionType: "judgment",
          ecli: "ECLI:CZ:NS:2024:29.CDO.123.2024.1",
          // The handler builds the headline for the web UI; the MCP snippet
          // must come back as plain text.
          headline: "Relevant <mark>holding</mark> on &quot;smlouva&quot;",
          language: "cs",
          languageAlternates: [
            {
              caseNumber: "29 Cdo 123/2024",
              country: "CZE",
              court: "Nejvyšší soud",
              decisionDate: "2024-02-01",
              id: DECISION_ID,
              language: "cs",
              slug: "stable-official-slug",
            },
            {
              caseNumber: "29 Cdo 123/2024",
              country: "CZE",
              court: "Nejvyšší soud",
              decisionDate: "2024-02-01",
              id: "dec_124",
              language: "en",
              slug: "stable-official-slug-en",
            },
          ],
          slug: "stable-official-slug",
          sourceUrl: "https://example.test/decision",
        },
      ],
      nextCursor: "cursor_2",
      totalCount: 1,
    });

    const context = createContext();
    const result = await handleMcpToolCall({
      args: {
        country: "CZE",
        court: "Nejvyšší soud",
        date_from: "2024-01-01",
        decision_type: "judgment",
        limit: 5,
        query: "shareholder dispute",
        source_id: "11111111-1111-4111-8111-111111111111",
      },
      context,
      toolName: "search_case_law",
    });

    expect(searchDecisionsHandlerMock).toHaveBeenCalledWith(
      {
        country: "CZE",
        court: "Nejvyšší soud",
        dateFrom: "2024-01-01",
        decisionType: "judgment",
        limit: 5,
        query: "shareholder dispute",
        sourceId: "11111111-1111-4111-8111-111111111111",
      },
      caseLawPublicReadDb,
    );

    expect(parseToolPayload(result)).toEqual({
      facets: {
        country: [{ count: 1, value: "CZE" }],
        court: [{ count: 1, value: "Nejvyšší soud" }],
        language: [{ count: 1, value: "cs" }],
      },
      nextCursor: "cursor_2",
      results: [
        {
          appUrl: `${APP_BASE_URL}/law/cze/cases/nejvyssi-soud/cs/stable-official-slug`,
          caseNumber: "29 Cdo 123/2024",
          citationCount: 7,
          country: "CZE",
          court: "Nejvyšší soud",
          decisionDate: "2024-02-01",
          decisionId: DECISION_ID,
          resourceName: `stella://resource/case_law_decision/id=${DECISION_ID}`,
          decisionType: "judgment",
          ecli: "ECLI:CZ:NS:2024:29.CDO.123.2024.1",
          language: "cs",
          snippet: 'Relevant holding on "smlouva"',
          sourceUrl: "https://example.test/decision",
        },
      ],
      totalCount: 1,
    });
  });

  test("search_case_law returns the same payload in anonymized mode", async () => {
    searchDecisionsHandlerMock.mockResolvedValue({
      facets: {
        country: [{ count: 1, value: "CZE" }],
      },
      hits: [
        {
          caseNumber: "29 Cdo 123/2024",
          citationCount: 7,
          country: "CZE",
          court: "Nejvyšší soud",
          decisionDate: "2024-02-01",
          decisionId: DECISION_ID,
          decisionType: "judgment",
          ecli: "ECLI:CZ:NS:2024:29.CDO.123.2024.1",
          headline: "Relevant <mark>holding</mark>",
          language: "cs",
          slug: "stable-official-slug",
          sourceUrl: "https://example.test/decision",
        },
      ],
      nextCursor: null,
      totalCount: 1,
    });

    const result = await handleMcpToolCall({
      args: { query: "shareholder dispute" },
      context: createContext(),
      mode: "anonymized",
      toolName: "search_case_law",
    });

    expect(parseToolPayload(result)).toEqual({
      facets: {
        country: [{ count: 1, value: "CZE" }],
      },
      nextCursor: null,
      results: [
        {
          appUrl: `${APP_BASE_URL}/law/cze/cases/nejvyssi-soud/stable-official-slug`,
          caseNumber: "29 Cdo 123/2024",
          citationCount: 7,
          country: "CZE",
          court: "Nejvyšší soud",
          decisionDate: "2024-02-01",
          decisionId: DECISION_ID,
          resourceName: `stella://resource/case_law_decision/id=${DECISION_ID}`,
          decisionType: "judgment",
          ecli: "ECLI:CZ:NS:2024:29.CDO.123.2024.1",
          language: "cs",
          snippet: "Relevant holding",
          sourceUrl: "https://example.test/decision",
        },
      ],
      totalCount: 1,
    });
    expect(anonymizeTextFieldsMock).not.toHaveBeenCalled();
  });

  // A deployment feature flag gates BOTH surfaces of a tagged tool: the
  // advertised list and dispatch. The case-law tools carry FEATURE_PUBLIC_LAW,
  // matching the public-routes gate on their backing corpus. Dev deployments
  // bypass the gate so local work is never blocked. The env object is mutated
  // in place (same approach the rest of this suite uses) and restored in a
  // finally so the flip cannot leak into a neighbouring test.
  const withPublicLaw = async (
    { featurePublicLaw, isDev }: { featurePublicLaw: boolean; isDev: boolean },
    run: () => Promise<void>,
  ) => {
    const previousFeaturePublicLaw = env.FEATURE_PUBLIC_LAW;
    const previousIsDev = env.isDev;
    env.FEATURE_PUBLIC_LAW = featurePublicLaw;
    env.isDev = isDev;
    try {
      await run();
    } finally {
      env.FEATURE_PUBLIC_LAW = previousFeaturePublicLaw;
      env.isDev = previousIsDev;
    }
  };

  test("hides feature-gated tools from the list when the flag is off outside dev", async () => {
    await withPublicLaw({ featurePublicLaw: false, isDev: false }, async () => {
      const toolNames = (await listMcpTools(createContext())).map(
        (tool) => tool.name,
      );

      expect(toolNames).not.toContain("search_case_law");
      expect(toolNames).not.toContain("read_case_law_decision");
      // Untagged tools stay listed: the gate only drops flagged tools.
      expect(toolNames).toContain("list_matters");
    });
  });

  test("lists feature-gated tools once the flag is on", async () => {
    await withPublicLaw({ featurePublicLaw: true, isDev: false }, async () => {
      const toolNames = (await listMcpTools(createContext())).map(
        (tool) => tool.name,
      );

      expect(toolNames).toContain("search_case_law");
      expect(toolNames).toContain("read_case_law_decision");
    });
  });

  test("lists feature-gated tools in dev even when the flag is off", async () => {
    await withPublicLaw({ featurePublicLaw: false, isDev: true }, async () => {
      const toolNames = (await listMcpTools(createContext())).map(
        (tool) => tool.name,
      );

      expect(toolNames).toContain("search_case_law");
      expect(toolNames).toContain("read_case_law_decision");
    });
  });

  test("rejects dispatch of a feature-gated tool when the flag is off outside dev", async () => {
    await withPublicLaw({ featurePublicLaw: false, isDev: false }, async () => {
      const result = await handleMcpToolCall({
        args: { query: "shareholder dispute" },
        context: createContext(),
        toolName: "search_case_law",
      });

      expectErrorEnvelope(result, {
        code: "feature_disabled",
        message: "This feature is not enabled on this deployment",
        hint: featureDisabledHint("FEATURE_PUBLIC_LAW"),
      });
      // The gate short-circuits before the backing handler runs, so guessing
      // the tool name cannot reach the corpus.
      expect(searchDecisionsHandlerMock).not.toHaveBeenCalled();
    });
  });

  test("dispatches a feature-gated tool once the flag is on", async () => {
    await withPublicLaw({ featurePublicLaw: true, isDev: false }, async () => {
      searchDecisionsHandlerMock.mockResolvedValue({
        facets: { country: [{ count: 1, value: "CZE" }] },
        hits: [
          {
            caseNumber: "29 Cdo 123/2024",
            citationCount: 7,
            country: "CZE",
            court: "Nejvyšší soud",
            decisionDate: "2024-02-01",
            decisionId: DECISION_ID,
            decisionType: "judgment",
            ecli: null,
            headline: null,
            language: "cs",
            slug: "stable-official-slug",
            sourceUrl: "https://example.test/decision",
          },
        ],
        nextCursor: null,
        totalCount: 1,
      });

      const result = await handleMcpToolCall({
        args: { query: "shareholder dispute" },
        context: createContext(),
        toolName: "search_case_law",
      });

      // The gate opened: the backing handler ran instead of the not-enabled
      // rejection, which would short-circuit before any handler call. With the
      // flag on, app URLs resolve just as in dev.
      expect(searchDecisionsHandlerMock).toHaveBeenCalledTimes(1);
      expect(parseToolPayload(result)).toMatchObject({
        results: [
          {
            appUrl: `${APP_BASE_URL}/law/cze/cases/nejvyssi-soud/stable-official-slug`,
            decisionId: DECISION_ID,
            resourceName: `stella://resource/case_law_decision/id=${DECISION_ID}`,
          },
        ],
        totalCount: 1,
      });
    });
  });

  test("search_case_law rejects invalid ISO dates", async () => {
    const result = await handleMcpToolCall({
      args: {
        date_from: "2024-02-30",
        query: "shareholder dispute",
      },
      context: createContext(),
      toolName: "search_case_law",
    });

    const error = validationEnvelope(result);
    expect(error["code"]).toBe("validation_error");
    expect(error["message"]).toBe(
      "Invalid parameter: date_from. Expected an ISO date in YYYY-MM-DD format",
    );
    expect(error["issues"]).toEqual([
      {
        path: "date_from",
        message:
          "Invalid parameter: date_from. Expected an ISO date in YYYY-MM-DD format",
      },
    ]);
    expect(searchDecisionsHandlerMock).not.toHaveBeenCalled();
  });

  test("search_case_law rejects invalid source IDs", async () => {
    const result = await handleMcpToolCall({
      args: {
        query: "shareholder dispute",
        source_id: "not-a-uuid",
      },
      context: createContext(),
      toolName: "search_case_law",
    });

    const error = validationEnvelope(result);
    expect(error["code"]).toBe("validation_error");
    expect(error["issues"]).toEqual([
      {
        path: "source_id",
        message: 'Invalid UUID: Received "not-a-uuid"',
      },
    ]);
    expect(searchDecisionsHandlerMock).not.toHaveBeenCalled();
  });

  test("read_case_law_decision derives plain text from the AST fallback", async () => {
    readDecisionHandlerMock.mockResolvedValue(createReadDecisionResult());

    const context = createContext();
    const result = await handleMcpToolCall({
      args: { decision_id: DECISION_ID },
      context,
      toolName: "read_case_law_decision",
    });

    // An agent read is attributable, so it may queue demand for a
    // decision whose document has not been fetched yet.
    // The gate and the read are one call, so the tool names the decision
    // by locator and never holds an ungated id.
    expect(readGatedDecisionMock).toHaveBeenCalledWith({
      locator: { kind: "id", id: DECISION_ID },
      caseLawDb: caseLawPublicReadDb,
      caller: "attributed",
      citationsCursor: undefined,
    });

    expect(parseToolPayload(result)).toEqual({
      nextCursor: null,
      decision: {
        appUrl: `${APP_BASE_URL}/law/cze/cases/nejvyssi-soud/stable-official-slug`,
        caseNumber: "29 Cdo 123/2024",
        citationsFrom: [{ citationText: "29 Odo 1/2001", id: "c_1" }],
        citationsTo: [{ citationText: "31 Cdo 2/2025", id: "c_2" }],
        country: "CZE",
        court: "Nejvyšší soud",
        decisionDate: "2024-02-01",
        decisionId: DECISION_ID,
        resourceName: `stella://resource/case_law_decision/id=${DECISION_ID}`,
        decisionType: "judgment",
        documentUrl: "https://example.test/document.pdf",
        ecli: null,
        language: "cs",
        metadata: { panel: "29 Cdo" },
        source: {
          adapterKey: "cz-ns",
          allowsDerivedAi: true,
          id: "src_1",
          name: "Nejvyšší soud",
        },
        sourceUrl: "https://example.test/decision",
        text: "29 Cdo 123/2024\n\nThe court dismissed the appeal.",
        charCount: "29 Cdo 123/2024\n\nThe court dismissed the appeal.".length,
        truncated: false,
      },
    });
  });

  test("read_case_law_decision answers not found for a subject the gate denies", async () => {
    // A restricted or missing decision does not exist for any caller, and
    // the reader must not run for it: the gate answers before there is
    // anything to read.
    readGatedDecisionMock.mockImplementation(
      async ({
        caseLawDb,
        locator,
      }: {
        caseLawDb: unknown;
        locator: { kind: "id"; id: string };
      }) =>
        await withRedistributableSubjectMock(
          caseLawDb,
          locator,
          async (subject: { id: string }) =>
            await readDecisionHandlerMock({ subject }),
        ),
    );
    withRedistributableSubjectMock.mockResolvedValue(null);

    const result = await handleMcpToolCall({
      args: { decision_id: DECISION_ID },
      context: createContext(),
      toolName: "read_case_law_decision",
    });

    expectErrorEnvelope(result, {
      code: "not_found",
      message: "Decision not found",
    });
    expect(readDecisionHandlerMock).not.toHaveBeenCalled();
  });

  test("read_case_law_decision withholds text when the source bars AI use", async () => {
    const base = createReadDecisionResult();
    readDecisionHandlerMock.mockResolvedValue({
      ...base,
      source: { ...base.source, allowsDerivedAi: false },
    });

    const result = await handleMcpToolCall({
      args: { decision_id: DECISION_ID },
      context: createContext(),
      toolName: "read_case_law_decision",
    });

    expect(parseToolPayload(result)).toMatchObject({
      decision: {
        text: null,
        textWithheldReason:
          "The source licence does not permit AI use of the full text.",
      },
    });
  });

  test("read_case_law_decision returns the same payload in anonymized mode", async () => {
    readDecisionHandlerMock.mockResolvedValue(createReadDecisionResult());

    const result = await handleMcpToolCall({
      args: { decision_id: DECISION_ID },
      context: createContext(),
      mode: "anonymized",
      toolName: "read_case_law_decision",
    });

    expect(parseToolPayload(result)).toEqual({
      nextCursor: null,
      decision: {
        appUrl: `${APP_BASE_URL}/law/cze/cases/nejvyssi-soud/stable-official-slug`,
        caseNumber: "29 Cdo 123/2024",
        citationsFrom: [{ citationText: "29 Odo 1/2001", id: "c_1" }],
        citationsTo: [{ citationText: "31 Cdo 2/2025", id: "c_2" }],
        country: "CZE",
        court: "Nejvyšší soud",
        decisionDate: "2024-02-01",
        decisionId: DECISION_ID,
        resourceName: `stella://resource/case_law_decision/id=${DECISION_ID}`,
        decisionType: "judgment",
        documentUrl: "https://example.test/document.pdf",
        ecli: null,
        language: "cs",
        metadata: { panel: "29 Cdo" },
        source: {
          adapterKey: "cz-ns",
          allowsDerivedAi: true,
          id: "src_1",
          name: "Nejvyšší soud",
        },
        sourceUrl: "https://example.test/decision",
        text: "29 Cdo 123/2024\n\nThe court dismissed the appeal.",
        charCount: "29 Cdo 123/2024\n\nThe court dismissed the appeal.".length,
        truncated: false,
      },
    });
    expect(anonymizeTextFieldsMock).not.toHaveBeenCalled();
  });

  test("read_case_law_decision pages citation lists via the compound cursor", async () => {
    const base = createReadDecisionResult();
    readDecisionHandlerMock.mockImplementation(
      async ({ citationsCursor }: { citationsCursor?: string }) => {
        const page = citationsCursor === undefined ? 0 : 1;
        const fromStart = page * 50;
        const toStart = page * 50;
        return {
          ...base,
          citationsFrom: Array.from(
            { length: page === 0 ? 50 : 10 },
            (_unused, i) => ({
              citationText: `from-${String(fromStart + i)}`,
              id: `cf_${String(fromStart + i)}`,
            }),
          ),
          citationsTo: Array.from(
            { length: page === 0 ? 50 : 20 },
            (_unused, i) => ({
              citationText: `to-${String(toStart + i)}`,
              id: `ct_${String(toStart + i)}`,
            }),
          ),
          citationsNextCursor: page === 0 ? "citations-next" : null,
        };
      },
    );

    type DecisionPage = {
      nextCursor: string | null;
      decision: {
        citationsFrom: { id: string }[];
        citationsTo: { id: string }[];
        text: string | null;
      };
    };

    const page1 = asTestRaw<DecisionPage>(
      parseToolPayload(
        await handleMcpToolCall({
          args: { decision_id: DECISION_ID },
          context: createContext(),
          toolName: "read_case_law_decision",
        }),
      ),
    );
    expect(page1.decision.citationsFrom).toHaveLength(50);
    expect(page1.decision.citationsTo).toHaveLength(50);
    expect(page1.nextCursor).not.toBeNull();

    const page2 = asTestRaw<DecisionPage>(
      parseToolPayload(
        await handleMcpToolCall({
          args: { decision_id: DECISION_ID, cursor: page1.nextCursor },
          context: createContext(),
          toolName: "read_case_law_decision",
        }),
      ),
    );
    expect(page2.decision.citationsFrom).toHaveLength(10);
    expect(page2.decision.citationsTo).toHaveLength(20);
    expect(page2.decision.citationsFrom.at(0)?.id).toBe("cf_50");
    expect(page2.decision.citationsTo.at(0)?.id).toBe("ct_50");
    expect(page2.decision.text).toBeNull();
    expect(page2.nextCursor).toBeNull();
    expect(readGatedDecisionMock).toHaveBeenLastCalledWith({
      locator: { kind: "id", id: DECISION_ID },
      caseLawDb: caseLawPublicReadDb,
      caller: "attributed",
      citationsCursor: "citations-next",
    });
  });

  test("fetch rejects documents outside the MCP workspace allowlist", async () => {
    const result = await handleMcpToolCall({
      args: { id: "00000000-0000-4000-8000-0000000e0001" },
      context: createContext({
        accessibleWorkspaceIds: [WORKSPACE_ID],
        scopedDb: createScopedDb(
          [],
          createExtractedContentRow({
            workspaceId: WORKSPACE_ID_2,
          }),
        ),
      }),
      toolName: "fetch",
    });

    expectErrorEnvelope(result, {
      code: "not_found",
      message: "Matter not found or not accessible",
    });
  });

  test("search_across_matters passes the MCP workspace allowlist to search", async () => {
    searchAcrossMattersExecute.mockResolvedValue({
      hits: [],
      totalCount: 0,
    });

    const context = createContext({
      accessibleWorkspaceIds: [WORKSPACE_ID, WORKSPACE_ID_3],
    });
    await handleMcpToolCall({
      args: { query: "share purchase" },
      context,
      toolName: "search_across_matters",
    });

    expect(searchProviderSearchMock).toHaveBeenCalledWith({
      limit: 10,
      organizationId: toSafeId<"organization">("org_1"),
      query: "share purchase",
      workspaceIds: [
        toSafeId<"workspace">(WORKSPACE_ID),
        toSafeId<"workspace">(WORKSPACE_ID_3),
      ],
    });
  });

  test("search_across_matters rejects a malformed cursor instead of resetting to page 1", async () => {
    const result = await handleMcpToolCall({
      args: { query: "share purchase", cursor: "not-a-valid-cursor" },
      context: createContext(),
      toolName: "search_across_matters",
    });

    const error = validationEnvelope(result);
    expect(error["code"]).toBe("validation_error");
    expect(searchProviderSearchMock).not.toHaveBeenCalled();
  });

  test("read_content_across_matters returns content from allowed workspaces", async () => {
    const context = createContext({
      accessibleWorkspaceIds: [WORKSPACE_ID, WORKSPACE_ID_3],
      scopedDb: createScopedDb([], createExtractedContentRow()),
    });
    const result = await handleMcpToolCall({
      args: { entity_id: "00000000-0000-4000-8000-0000000e0001" },
      context,
      toolName: "read_content_across_matters",
    });

    expect(parseToolPayload(result)).toEqual({
      charCount: "Full document text".length,
      entityId: "00000000-0000-4000-8000-0000000e0001",
      kind: "document",
      name: "Share Purchase Agreement",
      text: "Full document text",
      truncated: false,
      nextCursor: null,
      workspaceId: WORKSPACE_ID,
    });
  });

  test("read_content_across_matters returns folio Markdown when the current version holds a DOCX file", async () => {
    await seedDocxFile("file_1");
    const context = createContext({
      accessibleWorkspaceIds: [WORKSPACE_ID, WORKSPACE_ID_3],
      scopedDb: createScopedDb([], createExtractedContentRow(), [
        {
          type: "file",
          id: "file_1",
          fileName: "agreement.docx",
          mimeType: DOCX_MIME_TYPE,
        },
      ]),
    });
    const result = await handleMcpToolCall({
      args: { entity_id: "00000000-0000-4000-8000-0000000e0001" },
      context,
      toolName: "read_content_across_matters",
    });

    const payload = parseToolPayload(result);
    expect(payload).toMatchObject({
      entityId: "00000000-0000-4000-8000-0000000e0001",
      kind: "document",
      name: "Share Purchase Agreement",
      workspaceId: WORKSPACE_ID,
    });
    if (!isRecord(payload) || typeof payload["text"] !== "string") {
      throw new Error("Expected payload.text to be a string");
    }
    const { text } = payload;
    // Headings and tables survive the conversion; the cached plaintext
    // extraction is not what gets served once markdown conversion succeeds.
    expect(text).toContain("# Agreement");
    expect(text).toContain("| Party | Role |");
    expect(text).toContain("| Acme s.r.o. | Seller |");
    expect(text).toContain("Signed below.");
    expect(text).not.toContain("Full document text");
    // The bytes came from the current version's own file key, not from any
    // other object the store happens to hold.
    expect(objectReadKeys()).toEqual([docxKey("file_1")]);
  });

  test("read_content_across_matters reads a fresh DOCX before asynchronous extraction exists", async () => {
    await seedDocxFile("file_1");
    const context = createContext({
      accessibleWorkspaceIds: [WORKSPACE_ID, WORKSPACE_ID_3],
      scopedDb: createScopedDb(
        [],
        null,
        [
          {
            type: "file",
            id: "file_1",
            fileName: "agreement.docx",
            mimeType: DOCX_MIME_TYPE,
          },
        ],
        {
          entityId: "00000000-0000-4000-8000-0000000e0001",
          kind: "document",
          name: "Fresh Agreement",
          workspaceId: WORKSPACE_ID,
        },
      ),
    });

    const result = await handleMcpToolCall({
      args: { entity_id: "00000000-0000-4000-8000-0000000e0001" },
      context,
      toolName: "read_content_across_matters",
    });

    expect(parseToolPayload(result)).toMatchObject({
      entityId: "00000000-0000-4000-8000-0000000e0001",
      name: "Fresh Agreement",
      text: expect.stringContaining("# Agreement"),
    });
  });

  test("read_content_across_matters rejects cached text from a previous version", async () => {
    const stale = {
      ...createExtractedContentRow(),
      sourceEntityVersionId: "entity_version_old",
      sourceFieldId: "field_1",
      sourceFileId: "file_old",
      sourceSha256Hex: "a".repeat(64),
    };
    const context = createContext({
      scopedDb: createScopedDb([], stale, [
        {
          type: "file",
          id: "file_current",
          fileName: "agreement.pdf",
          mimeType: "application/pdf",
          sha256Hex: "b".repeat(64),
        },
      ]),
    });

    const result = await handleMcpToolCall({
      args: { entity_id: "00000000-0000-4000-8000-0000000e0001" },
      context,
      toolName: "read_content_across_matters",
    });

    expectErrorEnvelope(result, {
      code: "conflict",
      message: "Current document content is not ready",
      hint: "Call read_document to inspect contentState and searchIndexState, then follow the returned action or retry when processing completes.",
      retryable: true,
    });
  });

  test("read_content_across_matters reads one current DOCX while extraction still names the previous version", async () => {
    await seedDocxFile("file_current");
    const stale = createExtractedContentRow({
      sourceEntityVersionId: "entity_version_old",
      sourceFieldId: "field_old",
      sourceFileId: "file_old",
      sourceSha256Hex: "a".repeat(64),
    });
    const context = createContext({
      scopedDb: createScopedDb([], stale, [
        {
          type: "file",
          id: "file_current",
          fileName: "replacement.docx",
          mimeType: DOCX_MIME_TYPE,
          sha256Hex: "b".repeat(64),
        },
      ]),
    });

    const result = await handleMcpToolCall({
      args: { entity_id: "00000000-0000-4000-8000-0000000e0001" },
      context,
      toolName: "read_content_across_matters",
    });

    // The current file's markdown is served; the stale projection's plaintext
    // never reaches the payload.
    expect(parseToolPayload(result)).toMatchObject({
      text: expect.stringContaining("# Agreement"),
    });
    expect(parseToolPayload(result)).not.toMatchObject({
      text: expect.stringContaining(DEFAULT_EXTRACTED_TEXT),
    });
  });

  test("read_content_across_matters does not guess between current files while extraction names the previous version", async () => {
    const stale = createExtractedContentRow({
      sourceEntityVersionId: "entity_version_old",
      sourceFieldId: "field_old",
      sourceFileId: "file_old",
      sourceSha256Hex: "a".repeat(64),
    });
    const context = createContext({
      scopedDb: createScopedDb([], stale, [
        {
          type: "file",
          id: "file_primary",
          fileName: "primary.pdf",
          mimeType: "application/pdf",
          sha256Hex: "b".repeat(64),
        },
        {
          type: "file",
          id: "file_auxiliary",
          fileName: "auxiliary.docx",
          mimeType: DOCX_MIME_TYPE,
          sha256Hex: "c".repeat(64),
        },
      ]),
    });

    const result = await handleMcpToolCall({
      args: { entity_id: "00000000-0000-4000-8000-0000000e0001" },
      context,
      toolName: "read_content_across_matters",
    });

    expectErrorEnvelope(result, {
      code: "conflict",
      message: "Current document content is not ready",
      hint: "Call read_document to inspect contentState and searchIndexState, then follow the returned action or retry when processing completes.",
      retryable: true,
    });
    // Neither candidate DOCX is read: the tool refuses rather than picking one.
    expect(objectReadKeys()).toEqual([]);
  });

  test("read_content_across_matters rejects legacy text after a version rollback", async () => {
    const context = createContext({
      scopedDb: createScopedDb(
        [],
        createExtractedContentRow(),
        [
          {
            type: "file",
            id: "file_current",
            fileName: "promoted-version.pdf",
            mimeType: "application/pdf",
          },
        ],
        {
          entityId: "00000000-0000-4000-8000-0000000e0001",
          kind: "document",
          name: "Promoted Version",
          workspaceId: WORKSPACE_ID,
        },
        { latestVersionId: "entity_version_deleted_newer" },
      ),
    });

    const result = await handleMcpToolCall({
      args: { entity_id: "00000000-0000-4000-8000-0000000e0001" },
      context,
      toolName: "read_content_across_matters",
    });

    expectErrorEnvelope(result, {
      code: "conflict",
      message: "Current document content is not ready",
      hint: "Call read_document to inspect contentState and searchIndexState, then follow the returned action or retry when processing completes.",
      retryable: true,
    });
  });

  test("read_content_across_matters selects the SAME file the extraction pipeline indexed, not just any DOCX field", async () => {
    // The persisted source is a non-DOCX system document; an auxiliary field
    // happens to hold a DOCX. The markdown branch must not scan for another
    // DOCX and return a different document than the plaintext projection.
    // The auxiliary DOCX is seeded, so reading it would succeed: the tool
    // leaves it alone by choice, not because the store lacks it.
    await seedDocxFile("file_auxiliary");
    const context = createContext({
      accessibleWorkspaceIds: [WORKSPACE_ID, WORKSPACE_ID_3],
      scopedDb: createScopedDb(
        [],
        createExtractedContentRow({
          sourceEntityVersionId: "entity_version_1",
          sourceFieldId: "field_1",
          sourceFileId: "file_system",
          sourceSha256Hex: "a".repeat(64),
        }),
        [
          {
            type: "file",
            id: "file_system",
            fileName: "agreement.pdf",
            mimeType: "application/pdf",
            sha256Hex: "a".repeat(64),
          },
          {
            type: "file",
            id: "file_auxiliary",
            fileName: "exhibit.docx",
            mimeType: DOCX_MIME_TYPE,
          },
        ],
      ),
    });
    const result = await handleMcpToolCall({
      args: { entity_id: "00000000-0000-4000-8000-0000000e0001" },
      context,
      toolName: "read_content_across_matters",
    });

    const payload = parseToolPayload(result);
    // Falls back to the cached plaintext of the SYSTEM file, never the
    // auxiliary DOCX's converted markdown.
    expect(payload).toMatchObject({ text: "Full document text" });
    if (!isRecord(payload) || typeof payload["text"] !== "string") {
      throw new Error("Expected payload.text to be a string");
    }
    expect(payload["text"]).not.toContain("# Agreement");
    expect(objectReadKeys()).toEqual([]);
  });

  test("read_content_across_matters follows a persisted non-first DOCX source", async () => {
    await seedDocxFile("file_selected");
    const context = createContext({
      accessibleWorkspaceIds: [WORKSPACE_ID, WORKSPACE_ID_3],
      scopedDb: createScopedDb(
        [],
        createExtractedContentRow({
          sourceEntityVersionId: "entity_version_1",
          sourceFieldId: "field_2",
          sourceFileId: "file_selected",
          sourceSha256Hex: "b".repeat(64),
        }),
        [
          {
            type: "file",
            id: "file_sibling",
            fileName: "sibling.pdf",
            mimeType: "application/pdf",
            sha256Hex: "a".repeat(64),
          },
          {
            type: "file",
            id: "file_selected",
            fileName: "selected.docx",
            mimeType: DOCX_MIME_TYPE,
            sha256Hex: "b".repeat(64),
          },
        ],
      ),
    });

    const result = await handleMcpToolCall({
      args: { entity_id: "00000000-0000-4000-8000-0000000e0001" },
      context,
      toolName: "read_content_across_matters",
    });

    expect(parseToolPayload(result)).toMatchObject({
      text: expect.stringContaining("# Agreement"),
    });
    // The persisted source field selects the second file, not the first.
    expect(objectReadKeys()).toEqual([docxKey("file_selected")]);
  });

  test("read_content_across_matters falls back to plaintext when docx-to-markdown conversion fails", async () => {
    // The object exists; the store rejects the read.
    await seedDocxFile("file_1");
    fake.failNext({ method: "GET", code: "InternalError", status: 500 });
    const context = createContext({
      accessibleWorkspaceIds: [WORKSPACE_ID, WORKSPACE_ID_3],
      scopedDb: createScopedDb([], createExtractedContentRow(), [
        {
          type: "file",
          id: "file_1",
          fileName: "agreement.docx",
          mimeType: DOCX_MIME_TYPE,
        },
      ]),
    });
    const result = await handleMcpToolCall({
      args: { entity_id: "00000000-0000-4000-8000-0000000e0001" },
      context,
      toolName: "read_content_across_matters",
    });

    expect(parseToolPayload(result)).toMatchObject({
      text: "Full document text",
    });
  });

  test("read_content_across_matters returns a retryable error instead of switching representation when a paginated DOCX conversion fails", async () => {
    await seedDocxFile("file_1");
    fake.failNext({ method: "GET", code: "InternalError", status: 500 });
    const context = createContext({
      accessibleWorkspaceIds: [WORKSPACE_ID, WORKSPACE_ID_3],
      scopedDb: createScopedDb([], createExtractedContentRow(), [
        {
          type: "file",
          id: "file_1",
          fileName: "agreement.docx",
          mimeType: DOCX_MIME_TYPE,
        },
      ]),
    });

    // Simulates a client mid-pagination: a cursor already encodes an offset
    // into whatever representation the (unseen) first read served. This
    // call's conversion attempt fails; the tool must not guess by silently
    // falling back to plaintext, which could be a different length/content
    // than the Markdown the cursor was computed against (skipped/duplicated
    // content).
    const result = await handleMcpToolCall({
      args: {
        entity_id: "00000000-0000-4000-8000-0000000e0001",
        cursor: encodePaginationCursor([5]),
      },
      context,
      toolName: "read_content_across_matters",
    });

    expectErrorEnvelope(result, {
      code: "internal_error",
      message:
        "Could not continue reading this document's Markdown conversion.",
      hint: "Retry the request with the same cursor.",
      retryable: true,
    });
  });

  test("read_content_across_matters treats a DOCX conversion timeout the same as any other conversion failure", async () => {
    withTimeoutMock.mockImplementationOnce(async () => {
      throw new TimeoutError({
        message: "docx-to-markdown timed out",
        label: "read_content_across_matters:docx-to-markdown",
        timeoutMs: 30_000,
      });
    });
    const context = createContext({
      accessibleWorkspaceIds: [WORKSPACE_ID, WORKSPACE_ID_3],
      scopedDb: createScopedDb([], createExtractedContentRow(), [
        {
          type: "file",
          id: "file_1",
          fileName: "agreement.docx",
          mimeType: DOCX_MIME_TYPE,
        },
      ]),
    });

    // First read: a timeout is funneled through the exact same
    // `Result.tryPromise` catch as any other conversion failure, so it
    // still falls back to the cached plaintext rather than hanging or
    // erroring the whole request.
    const result = await handleMcpToolCall({
      args: { entity_id: "00000000-0000-4000-8000-0000000e0001" },
      context,
      toolName: "read_content_across_matters",
    });

    expect(parseToolPayload(result)).toMatchObject({
      text: "Full document text",
    });
    expect(withTimeoutMock).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({ timeoutMs: expect.any(Number) }),
    );
  });

  test("search anonymizes titles in anonymized mode", async () => {
    searchAcrossMattersExecute.mockResolvedValue({
      hits: [
        {
          entityId: "00000000-0000-4000-8000-0000000e0001",
          workspaceId: WORKSPACE_ID,
          name: "John Smith SPA",
        },
      ],
    });
    anonymizeTextFieldsMock.mockResolvedValue({
      entityCount: 1,
      fields: ["[PERSON_1] SPA"],
    });

    const result = await handleMcpToolCall({
      args: { query: "john smith" },
      context: createContext({
        scopedDb: createScopedDb([
          {
            entityId: "00000000-0000-4000-8000-0000000e0001",
            fieldId: "field_1",
            workspaceId: WORKSPACE_ID,
          },
        ]),
      }),
      mode: "anonymized",
      toolName: "search",
    });

    expect(parseToolPayload(result)).toEqual({
      nextCursor: null,
      results: [
        {
          id: "00000000-0000-4000-8000-0000000e0001",
          title: "[PERSON_1] SPA",
          url: `${APP_BASE_URL}/workspaces/${WORKSPACE_ID}/all/pdf?entity=00000000-0000-4000-8000-0000000e0001&field=field_1`,
        },
      ],
    });
    const anonymizeInput = anonymizeTextFieldsMock.mock.calls.at(-1)?.[0];
    expect(anonymizeInput).toMatchObject({
      fields: ["John Smith SPA"],
      organizationId: toSafeId<"organization">("org_1"),
      workspaceId: WORKSPACE_ID,
    });
    // The egress pipeline resolves both catalogs for the workspaces its
    // payload names and hands them over pre-resolved, so the redactor holds
    // no database handle and issues no read of its own.
    expect(anonymizeInput?.catalogs).toEqual({
      type: "preloaded",
      excludedCanonicals: [],
      gazetteerEntries: [],
    });
    expect(loadGazetteerByWorkspaceMock).toHaveBeenCalledTimes(1);
    expect(loadGazetteerByWorkspaceMock.mock.calls.at(0)?.[0]).toMatchObject({
      workspaceIds: [WORKSPACE_ID],
    });
  });

  test("search batches anonymized titles by workspace", async () => {
    searchAcrossMattersExecute.mockResolvedValue({
      hits: [
        {
          entityId: "00000000-0000-4000-8000-0000000e0001",
          workspaceId: WORKSPACE_ID,
          name: "John Smith SPA",
        },
        {
          entityId: "00000000-0000-4000-8000-0000000e0002",
          workspaceId: WORKSPACE_ID,
          name: "Jane Doe NDA",
        },
      ],
    });
    anonymizeTextFieldsMock.mockResolvedValue({
      entityCount: 2,
      fields: ["[PERSON_1] SPA", "[PERSON_2] NDA"],
    });

    const result = await handleMcpToolCall({
      args: { query: "agreement" },
      context: createContext({
        scopedDb: createScopedDb([
          {
            entityId: "00000000-0000-4000-8000-0000000e0001",
            fieldId: "field_1",
            workspaceId: WORKSPACE_ID,
          },
          {
            entityId: "00000000-0000-4000-8000-0000000e0002",
            fieldId: "field_2",
            workspaceId: WORKSPACE_ID,
          },
        ]),
      }),
      mode: "anonymized",
      toolName: "search",
    });

    expect(parseToolPayload(result)).toEqual({
      nextCursor: null,
      results: [
        {
          id: "00000000-0000-4000-8000-0000000e0001",
          title: "[PERSON_1] SPA",
          url: `${APP_BASE_URL}/workspaces/${WORKSPACE_ID}/all/pdf?entity=00000000-0000-4000-8000-0000000e0001&field=field_1`,
        },
        {
          id: "00000000-0000-4000-8000-0000000e0002",
          title: "[PERSON_2] NDA",
          url: `${APP_BASE_URL}/workspaces/${WORKSPACE_ID}/all/pdf?entity=00000000-0000-4000-8000-0000000e0002&field=field_2`,
        },
      ],
    });
    expect(anonymizeTextFieldsMock).toHaveBeenCalledTimes(1);
    expect(anonymizeTextFieldsMock.mock.calls.at(0)?.[0]).toMatchObject({
      fields: ["John Smith SPA", "Jane Doe NDA"],
      workspaceId: WORKSPACE_ID,
    });
  });

  test("search preserves empty anonymized output instead of leaking the original title", async () => {
    searchAcrossMattersExecute.mockResolvedValue({
      hits: [
        {
          entityId: "00000000-0000-4000-8000-0000000e0001",
          workspaceId: WORKSPACE_ID,
          name: "John Smith",
        },
      ],
    });
    anonymizeTextFieldsMock.mockResolvedValue({
      entityCount: 1,
      fields: [""],
    });

    const result = await handleMcpToolCall({
      args: { query: "john smith" },
      context: createContext({
        scopedDb: createScopedDb([
          {
            entityId: "00000000-0000-4000-8000-0000000e0001",
            fieldId: "field_1",
            workspaceId: WORKSPACE_ID,
          },
        ]),
      }),
      mode: "anonymized",
      toolName: "search",
    });

    expect(parseToolPayload(result)).toEqual({
      nextCursor: null,
      results: [
        {
          id: "00000000-0000-4000-8000-0000000e0001",
          title: "",
          url: `${APP_BASE_URL}/workspaces/${WORKSPACE_ID}/all/pdf?entity=00000000-0000-4000-8000-0000000e0001&field=field_1`,
        },
      ],
    });
  });

  test("search uses a generic placeholder when anonymized fields are unexpectedly missing", async () => {
    searchAcrossMattersExecute.mockResolvedValue({
      hits: [
        {
          entityId: "00000000-0000-4000-8000-0000000e0001",
          workspaceId: WORKSPACE_ID,
          name: "John Smith",
        },
      ],
    });
    anonymizeTextFieldsMock.mockResolvedValue({
      entityCount: 1,
      fields: [],
    });

    const result = await handleMcpToolCall({
      args: { query: "john smith" },
      context: createContext({
        scopedDb: createScopedDb([
          {
            entityId: "00000000-0000-4000-8000-0000000e0001",
            fieldId: "field_1",
            workspaceId: WORKSPACE_ID,
          },
        ]),
      }),
      mode: "anonymized",
      toolName: "search",
    });

    expect(parseToolPayload(result)).toEqual({
      nextCursor: null,
      results: [
        {
          id: "00000000-0000-4000-8000-0000000e0001",
          title: "[REDACTED]",
          url: `${APP_BASE_URL}/workspaces/${WORKSPACE_ID}/all/pdf?entity=00000000-0000-4000-8000-0000000e0001&field=field_1`,
        },
      ],
    });
  });

  test("fetch anonymizes title and text in anonymized mode", async () => {
    anonymizeTextFieldsMock.mockResolvedValue({
      entityCount: 2,
      fields: ["[PERSON_1] SPA", "[PERSON_1] signed the agreement"],
    });

    const result = await handleMcpToolCall({
      args: { id: "00000000-0000-4000-8000-0000000e0001" },
      context: createContext({
        scopedDb: createScopedDb(
          [],
          createExtractedContentRow({
            encrypted: await encryptContent(
              ORGANIZATION_ID,
              "John Smith signed the agreement",
            ),
            name: "John Smith SPA",
          }),
        ),
      }),
      mode: "anonymized",
      toolName: "fetch",
    });

    expect(parseToolPayload(result)).toEqual({
      id: "00000000-0000-4000-8000-0000000e0001",
      title: "[PERSON_1] SPA",
      text: "[PERSON_1] signed the agreement",
      url: `${APP_BASE_URL}/workspaces/${WORKSPACE_ID}/all/pdf?entity=00000000-0000-4000-8000-0000000e0001&field=field_1`,
      nextCursor: null,
      metadata: {
        anonymized: true,
        anonymizedEntityCount: 2,
        charCount: "[PERSON_1] signed the agreement".length,
        source: "stella",
        truncated: false,
        workspaceId: WORKSPACE_ID,
      },
    });
  });

  test("fetch preserves empty anonymized output instead of leaking original content", async () => {
    anonymizeTextFieldsMock.mockResolvedValue({
      entityCount: 1,
      fields: ["", ""],
    });

    const result = await handleMcpToolCall({
      args: { id: "00000000-0000-4000-8000-0000000e0001" },
      context: createContext({
        scopedDb: createScopedDb(
          [],
          createExtractedContentRow({
            charCount: 42,
            encrypted: await encryptContent(ORGANIZATION_ID, "John Smith"),
            name: "John Smith",
          }),
        ),
      }),
      mode: "anonymized",
      toolName: "fetch",
    });

    expect(parseToolPayload(result)).toEqual({
      id: "00000000-0000-4000-8000-0000000e0001",
      title: "",
      text: "",
      url: `${APP_BASE_URL}/workspaces/${WORKSPACE_ID}/all/pdf?entity=00000000-0000-4000-8000-0000000e0001&field=field_1`,
      nextCursor: null,
      metadata: {
        anonymized: true,
        anonymizedEntityCount: 1,
        charCount: 0,
        source: "stella",
        truncated: false,
        workspaceId: WORKSPACE_ID,
      },
    });
  });

  test("fetch uses generic placeholders when anonymized fields are unexpectedly missing", async () => {
    anonymizeTextFieldsMock.mockResolvedValue({
      entityCount: 1,
      fields: [],
    });

    const result = await handleMcpToolCall({
      args: { id: "00000000-0000-4000-8000-0000000e0001" },
      context: createContext({
        scopedDb: createScopedDb(
          [],
          createExtractedContentRow({
            charCount: 42,
            encrypted: await encryptContent(ORGANIZATION_ID, "John Smith"),
            name: "John Smith",
          }),
        ),
      }),
      mode: "anonymized",
      toolName: "fetch",
    });

    expect(parseToolPayload(result)).toEqual({
      id: "00000000-0000-4000-8000-0000000e0001",
      title: "[REDACTED]",
      text: "[REDACTED]",
      url: `${APP_BASE_URL}/workspaces/${WORKSPACE_ID}/all/pdf?entity=00000000-0000-4000-8000-0000000e0001&field=field_1`,
      nextCursor: null,
      metadata: {
        anonymized: true,
        anonymizedEntityCount: 1,
        charCount: "[REDACTED]".length,
        source: "stella",
        truncated: false,
        workspaceId: WORKSPACE_ID,
      },
    });
  });

  test("tool failures return a generic MCP error and capture the original exception", async () => {
    searchAcrossMattersExecute.mockRejectedValue(new Error("database timeout"));

    const result = await handleMcpToolCall({
      args: { query: "share purchase" },
      context: createContext(),
      toolName: "search",
    });

    expectErrorEnvelope(result, {
      code: "internal_error",
      message: "Tool execution failed",
      hint: "If this looks like a stella bug, report it with the send_feedback tool.",
    });
    // The message stays out of the event by design; the class, tool, and
    // source are what identify the failure.
    expect(
      analytics.exceptions().map((event) => event.properties),
    ).toMatchObject([
      { "error.class": "Error", source: "mcp", toolName: "search" },
    ]);
    expect(JSON.stringify(analytics.exceptions())).not.toContain(
      "database timeout",
    );
  });

  // Document tools share resolveEntityWorkspace, which confines them to the
  // document/folder kinds list_documents surfaces. An entity ID that names a
  // task/message/link (kinds hidden from list_documents) must be rejected, not
  // acted on, even though the caller can read that workspace.
  const createEntityKindScopedDb = (kind: string) =>
    asTestRaw<McpRequestContext["scopedDb"]>(
      mock(
        async (
          callback: (tx: {
            query: {
              entities: {
                findFirst: () => Promise<{
                  kind: string;
                  name: string;
                  workspaceId: string;
                }>;
              };
            };
          }) => unknown,
        ) =>
          await callback({
            query: {
              entities: {
                findFirst: async () => ({
                  kind,
                  name: "Weekly sync",
                  workspaceId: WORKSPACE_ID,
                }),
              },
            },
          }),
      ),
    );

  test("read_document rejects an entity that is not a document or folder", async () => {
    const result = await handleMcpToolCall({
      args: { entity_id: "00000000-0000-4000-8000-0000000e7a5c" },
      context: createContext({ scopedDb: createEntityKindScopedDb("task") }),
      toolName: "read_document",
    });

    expect(result).toEqual({
      content: [{ type: "text", text: "Not a document or folder entity" }],
      isError: true,
    });
  });

  test("save_document (update branch) rejects an entity that is not a document or folder", async () => {
    const result = await handleMcpToolCall({
      args: {
        entity_id: "00000000-0000-4000-8000-0000000e0e5a",
        name: "Renamed",
      },
      context: createContext({ scopedDb: createEntityKindScopedDb("message") }),
      toolName: "save_document",
    });

    expect(result).toEqual({
      content: [{ type: "text", text: "Not a document or folder entity" }],
      isError: true,
    });
  });

  // Cross-field shape rules live in the tool schemas (v.partialCheck), so an
  // invalid combination fails at parse time before any workspace/DB access; the
  // partial_check message is surfaced instead of the generic shape hint.

  test("list_documents rejects flat mode combined with parent_id", async () => {
    const result = await handleMcpToolCall({
      args: {
        matter_id: WORKSPACE_ID,
        mode: "flat",
        parent_id: FOLDER_ENTITY_ID,
      },
      context: createContext(),
      toolName: "list_documents",
    });

    expectValidationMessage(result, "parent_id requires mode 'children'");
  });

  test("list_documents surfaces a field-level issue with a dot-path", async () => {
    const result = await handleMcpToolCall({
      // matter_id must be a string; a number fails the field validator, so the
      // envelope carries a structured issue pinpointing the offending field.
      args: { matter_id: 123 },
      context: createContext(),
      toolName: "list_documents",
    });

    const error = validationEnvelope(result);
    expect(error["code"]).toBe("validation_error");
    expect(error["issues"]).toEqual([
      { path: "matter_id", message: expect.any(String) },
    ]);
  });

  test("read_document rejects compare_with_version_id without version_id", async () => {
    const result = await handleMcpToolCall({
      args: {
        entity_id: "00000000-0000-4000-8000-0000000e0001",
        compare_with_version_id: BASE_VERSION_ID,
      },
      context: createContext(),
      toolName: "read_document",
    });

    expectValidationMessage(
      result,
      "compare_with_version_id requires version_id (the target version)",
    );
  });

  test("read_document reports direct DOCX readability separately from pending search indexing", async () => {
    const currentDocx = {
      encrypted: false,
      fileName: "agreement.docx",
      id: "file_1",
      mimeType: DOCX_MIME_TYPE,
      pdfFileId: null,
      sha256Hex: "a".repeat(64),
      sizeBytes: 128,
      type: "file",
      version: 1,
    };
    const result = await handleMcpToolCall({
      args: { entity_id: "00000000-0000-4000-8000-0000000e0001" },
      context: createContext({
        scopedDb: createScopedDb([], null, [currentDocx], {
          entityId: "00000000-0000-4000-8000-0000000e0001",
          kind: "document",
          name: "Fresh Agreement",
          workspaceId: WORKSPACE_ID,
        }),
      }),
      toolName: "read_document",
    });

    expect(parseToolPayload(result)).toMatchObject({
      contentState: {
        status: "ready",
        source: "direct_docx",
        sourceVersionId: "entity_version_1",
      },
      searchIndexState: {
        status: "pending",
        sourceVersionId: "entity_version_1",
      },
    });
  });

  test("read_document does not advertise a failed DOCX source as readable", async () => {
    const sha256Hex = "a".repeat(64);
    const currentDocx = {
      encrypted: false,
      fileName: "corrupt.docx",
      id: "file_1",
      mimeType: DOCX_MIME_TYPE,
      pdfFileId: null,
      sha256Hex,
      sizeBytes: 128,
      type: "file",
      version: 1,
    };
    const result = await handleMcpToolCall({
      args: { entity_id: "00000000-0000-4000-8000-0000000e0001" },
      context: createContext({
        scopedDb: createScopedDb(
          [],
          null,
          [currentDocx],
          {
            entityId: "00000000-0000-4000-8000-0000000e0001",
            kind: "document",
            name: "Corrupt Agreement",
            workspaceId: WORKSPACE_ID,
          },
          {
            runs: [
              {
                errorCode: "processing_failed",
                finishedAt: new Date("2026-01-02T00:00:00.000Z"),
                id: "run_native",
                kind: "native-extraction",
                sourceFileId: "file_1",
                sourceSha256Hex: sha256Hex,
                status: "failed",
              },
            ],
          },
        ),
      }),
      toolName: "read_document",
    });

    expect(parseToolPayload(result)).toMatchObject({
      contentState: {
        status: "failed",
        processingKind: "document-processing",
        runId: "run_native",
        errorCode: "document_processing_failed",
        retryable: true,
      },
    });
  });

  test("read_document returns the exact manual OCR action for an extension-resolved PDF when automatic OCR is off", async () => {
    const textlessProjection = createExtractedContentRow({ charCount: 0 });
    const currentPdf = {
      encrypted: false,
      fileName: "scan.pdf",
      id: "file_1",
      mimeType: "application/octet-stream",
      pdfFileId: null,
      sha256Hex: "a".repeat(64),
      sizeBytes: 128,
      type: "file",
      version: 1,
    };
    const result = await handleMcpToolCall({
      args: { entity_id: "00000000-0000-4000-8000-0000000e0001" },
      context: {
        ...createContext({
          scopedDb: createScopedDb([], textlessProjection, [currentPdf]),
        }),
        grantedScopes: ["stella:read", "stella:matters_write"],
        request: new Request("https://example.test/mcp"),
      },
      toolName: "read_document",
    });

    expect(parseToolPayload(result)).toMatchObject({
      contentState: {
        status: "requires_processing",
        sourceVersionId: "entity_version_1",
        remediation: {
          type: "action",
          tool: "invoke_capability",
          arguments: {
            capability: "entities.ocr.create",
            input: {
              params: {
                matterId: WORKSPACE_ID,
                entityId: "00000000-0000-4000-8000-0000000e0001",
              },
              body: { fieldId: "field_1" },
            },
          },
        },
      },
    });
  });

  test("read_document derives state and remediation from the persisted non-first source", async () => {
    const sourceSha256Hex = "b".repeat(64);
    const result = await handleMcpToolCall({
      args: { entity_id: "00000000-0000-4000-8000-0000000e0001" },
      context: {
        ...createContext({
          scopedDb: createScopedDb(
            [],
            createExtractedContentRow({
              charCount: 0,
              sourceEntityVersionId: "entity_version_1",
              sourceFieldId: "field_2",
              sourceFileId: "file_source",
              sourceSha256Hex,
            }),
            [
              {
                encrypted: false,
                fileName: "sibling.docx",
                id: "file_sibling",
                mimeType: DOCX_MIME_TYPE,
                pdfFileId: null,
                sha256Hex: "a".repeat(64),
                sizeBytes: 128,
                type: "file",
                version: 1,
              },
              {
                encrypted: false,
                fileName: "source.pdf",
                id: "file_source",
                mimeType: "application/pdf",
                pdfFileId: null,
                sha256Hex: sourceSha256Hex,
                sizeBytes: 128,
                type: "file",
                version: 1,
              },
            ],
          ),
        }),
        grantedScopes: ["stella:read", "stella:matters_write"],
        request: new Request("https://example.test/mcp"),
      },
      toolName: "read_document",
    });

    expect(parseToolPayload(result)).toMatchObject({
      contentState: {
        status: "requires_processing",
        remediation: {
          type: "action",
          arguments: {
            input: { body: { fieldId: "field_2" } },
          },
        },
      },
    });
  });

  test.each([
    {
      label: "missing matter-write scope",
      memberRole: "owner" as const,
      grantedScopes: ["stella:read"],
    },
    {
      label: "missing entity permission",
      memberRole: "intern" as const,
      grantedScopes: ["stella:read", "stella:matters_write"],
    },
  ])(
    "read_document returns an OCR escalation for a caller $label",
    async ({ grantedScopes, memberRole }) => {
      const textlessProjection = createExtractedContentRow({ charCount: 0 });
      const currentPdf = {
        encrypted: false,
        fileName: "scan.pdf",
        id: "file_1",
        mimeType: "application/pdf",
        pdfFileId: null,
        sha256Hex: "a".repeat(64),
        sizeBytes: 128,
        type: "file",
        version: 1,
      };
      const context = createContext({
        scopedDb: createScopedDb([], textlessProjection, [currentPdf]),
      });
      const result = await handleMcpToolCall({
        args: { entity_id: "00000000-0000-4000-8000-0000000e0001" },
        context: {
          ...context,
          grantedScopes,
          memberRole,
          request: new Request("https://example.test/mcp"),
        },
        toolName: "read_document",
      });

      expect(parseToolPayload(result)).toMatchObject({
        contentState: {
          status: "requires_processing",
          sourceVersionId: "entity_version_1",
          remediation: {
            type: "escalation",
            requiredScope: "stella:matters_write",
            requiredPermission: "entity:update",
          },
        },
      });
    },
  );

  test("read_document returns an OCR escalation to internal chat", async () => {
    const result = await handleMcpToolCall({
      args: { entity_id: "00000000-0000-4000-8000-0000000e0001" },
      context: createContext({
        scopedDb: createScopedDb(
          [],
          createExtractedContentRow({ charCount: 0 }),
          [
            {
              encrypted: false,
              fileName: "scan.pdf",
              id: "file_1",
              mimeType: PDF_MIME_TYPE,
              pdfFileId: null,
              sha256Hex: "a".repeat(64),
              sizeBytes: 128,
              type: "file",
              version: 1,
            },
          ],
        ),
      }),
      toolName: "read_document",
    });

    expect(parseToolPayload(result)).toMatchObject({
      contentState: {
        status: "requires_processing",
        remediation: { type: "escalation" },
      },
    });
  });

  test("read_document keeps extracted OCR content ready when only indexing failed", async () => {
    const sha256Hex = "a".repeat(64);
    const currentPdf = {
      encrypted: false,
      fileName: "scan.pdf",
      id: "file_1",
      mimeType: "application/pdf",
      pdfFileId: null,
      sha256Hex,
      sizeBytes: 128,
      type: "file",
      version: 1,
    };
    const result = await handleMcpToolCall({
      args: { entity_id: "00000000-0000-4000-8000-0000000e0001" },
      context: {
        ...createContext({
          scopedDb: createScopedDb(
            [],
            createExtractedContentRow(),
            [currentPdf],
            {
              entityId: "00000000-0000-4000-8000-0000000e0001",
              kind: "document",
              name: "Scan",
              workspaceId: WORKSPACE_ID,
            },
            {
              runs: [
                {
                  errorCode: "search_index_failed",
                  finishedAt: null,
                  id: "run_ocr",
                  kind: "ocr",
                  sourceFileId: "file_1",
                  sourceSha256Hex: sha256Hex,
                  status: "failed",
                },
              ],
            },
          ),
        }),
        grantedScopes: ["stella:read", "stella:matters_write"],
        request: new Request("https://example.test/mcp"),
      },
      toolName: "read_document",
    });

    expect(parseToolPayload(result)).toMatchObject({
      contentState: { status: "ready", source: "extracted_text" },
      searchIndexState: {
        status: "failed",
        errorCode: "search_index_failed",
        runId: "run_ocr",
      },
    });
  });

  test("read_document treats workspace-unavailable OCR cancellation as terminal", async () => {
    const sha256Hex = "a".repeat(64);
    const result = await handleMcpToolCall({
      args: { entity_id: "00000000-0000-4000-8000-0000000e0001" },
      context: createContext({
        scopedDb: createScopedDb(
          [],
          createExtractedContentRow({ charCount: 0 }),
          [
            {
              encrypted: false,
              fileName: "scan.pdf",
              id: "file_1",
              mimeType: PDF_MIME_TYPE,
              pdfFileId: null,
              sha256Hex,
              sizeBytes: 128,
              type: "file",
              version: 1,
            },
          ],
          undefined,
          {
            runs: [
              {
                errorCode: "workspace_unavailable",
                fieldId: "field_1",
                finishedAt: new Date("2026-01-03T00:00:00.000Z"),
                id: "run_ocr",
                kind: "ocr",
                sourceFileId: "file_1",
                sourceSha256Hex: sha256Hex,
                status: "cancelled",
              },
            ],
          },
        ),
      }),
      toolName: "read_document",
    });

    expect(parseToolPayload(result)).toMatchObject({
      contentState: {
        status: "unsupported",
        reason:
          "Document processing is unavailable while the matter is not active.",
      },
    });
  });

  test("read_document preserves current content and indexing after an optional OCR attempt fails", async () => {
    const sha256Hex = "a".repeat(64);
    const nativeIndexedAt = new Date("2026-01-02T00:00:00.000Z");
    const currentPdf = {
      encrypted: false,
      fileName: "scan.pdf",
      id: "file_1",
      mimeType: "application/pdf",
      pdfFileId: null,
      sha256Hex,
      sizeBytes: 128,
      type: "file",
      version: 1,
    };
    const result = await handleMcpToolCall({
      args: { entity_id: "00000000-0000-4000-8000-0000000e0001" },
      context: createContext({
        scopedDb: createScopedDb(
          [],
          createExtractedContentRow(),
          [currentPdf],
          {
            entityId: "00000000-0000-4000-8000-0000000e0001",
            kind: "document",
            name: "Scan",
            workspaceId: WORKSPACE_ID,
          },
          {
            runs: [
              {
                errorCode: "processing_failed",
                finishedAt: new Date("2026-01-03T00:00:00.000Z"),
                id: "run_ocr",
                kind: "ocr",
                sourceFileId: "file_1",
                sourceSha256Hex: sha256Hex,
                status: "failed",
              },
              {
                errorCode: null,
                finishedAt: nativeIndexedAt,
                id: "run_native",
                kind: "native-extraction",
                sourceFileId: "file_1",
                sourceSha256Hex: sha256Hex,
                status: "succeeded",
              },
            ],
            searchUpdatedAt: new Date("2026-01-01T00:00:00.000Z"),
          },
        ),
      }),
      toolName: "read_document",
    });

    expect(parseToolPayload(result)).toMatchObject({
      contentState: { status: "ready", source: "extracted_text" },
      searchIndexState: {
        status: "ready",
        updatedAt: nativeIndexedAt.toISOString(),
      },
    });
  });

  test("read_document treats policy-disabled OCR as manually retryable without masking native indexing", async () => {
    const sha256Hex = "a".repeat(64);
    const nativeIndexedAt = new Date("2026-01-02T00:00:00.000Z");
    const currentPdf = {
      encrypted: false,
      fileName: "scan.pdf",
      id: "file_1",
      mimeType: "application/pdf",
      pdfFileId: null,
      sha256Hex,
      sizeBytes: 128,
      type: "file",
      version: 1,
    };
    const result = await handleMcpToolCall({
      args: { entity_id: "00000000-0000-4000-8000-0000000e0001" },
      context: {
        ...createContext({
          scopedDb: createScopedDb(
            [],
            createExtractedContentRow({ charCount: 0 }),
            [currentPdf],
            {
              entityId: "00000000-0000-4000-8000-0000000e0001",
              kind: "document",
              name: "Scan",
              workspaceId: WORKSPACE_ID,
            },
            {
              documentProcessingMode: "off",
              runs: [
                {
                  errorCode: "policy_disabled",
                  finishedAt: new Date("2026-01-03T00:00:00.000Z"),
                  id: "run_ocr",
                  kind: "ocr",
                  sourceFileId: "file_1",
                  sourceSha256Hex: sha256Hex,
                  status: "cancelled",
                },
                {
                  errorCode: null,
                  finishedAt: nativeIndexedAt,
                  id: "run_native",
                  kind: "native-extraction",
                  sourceFileId: "file_1",
                  sourceSha256Hex: sha256Hex,
                  status: "succeeded",
                },
              ],
              searchUpdatedAt: new Date("2026-01-01T00:00:00.000Z"),
            },
          ),
        }),
        grantedScopes: ["stella:read", "stella:matters_write"],
        request: new Request("https://example.test/mcp"),
      },
      toolName: "read_document",
    });

    expect(parseToolPayload(result)).toMatchObject({
      contentState: {
        status: "requires_processing",
        remediation: { type: "action" },
      },
      searchIndexState: {
        status: "ready",
        updatedAt: nativeIndexedAt.toISOString(),
      },
    });
  });

  test("read_document filters processing runs by current source before selecting state", async () => {
    const sha256Hex = "a".repeat(64);
    const currentPdf = {
      encrypted: false,
      fileName: "current.pdf",
      id: "file_current",
      mimeType: "application/pdf",
      pdfFileId: null,
      sha256Hex,
      sizeBytes: 128,
      type: "file",
      version: 1,
    };
    const supersededRuns = Array.from({ length: 5 }, (_, index) => ({
      errorCode: null,
      finishedAt: null,
      id: `run_old_${index}`,
      kind: "ocr",
      sourceFileId: `file_old_${index}`,
      sourceSha256Hex: "b".repeat(64),
      status: "running",
    }));
    const indexedAt = new Date("2026-01-03T00:00:00.000Z");
    const result = await handleMcpToolCall({
      args: { entity_id: "00000000-0000-4000-8000-0000000e0001" },
      context: createContext({
        scopedDb: createScopedDb(
          [],
          createExtractedContentRow(),
          [currentPdf],
          {
            entityId: "00000000-0000-4000-8000-0000000e0001",
            kind: "document",
            name: "Current PDF",
            workspaceId: WORKSPACE_ID,
          },
          {
            runs: [
              {
                errorCode: "search_index_failed",
                fieldId: "field_2",
                finishedAt: new Date("2026-01-04T00:00:00.000Z"),
                id: "run_wrong_field",
                kind: "native-extraction",
                sourceFileId: currentPdf.id,
                sourceSha256Hex: sha256Hex,
                status: "failed",
              },
              ...supersededRuns,
              {
                errorCode: null,
                finishedAt: indexedAt,
                id: "run_current",
                kind: "native-extraction",
                sourceFileId: currentPdf.id,
                sourceSha256Hex: sha256Hex,
                status: "succeeded",
              },
            ],
            searchUpdatedAt: new Date("2026-01-01T00:00:00.000Z"),
          },
        ),
      }),
      toolName: "read_document",
    });

    expect(parseToolPayload(result)).toMatchObject({
      searchIndexState: {
        status: "ready",
        updatedAt: indexedAt.toISOString(),
      },
    });
  });

  test("read_document uses the newest processing kind for search readiness", async () => {
    const sha256Hex = "a".repeat(64);
    const indexedAt = new Date("2026-01-04T00:00:00.000Z");
    const currentPdf = {
      encrypted: false,
      fileName: "current.pdf",
      id: "file_1",
      mimeType: "application/pdf",
      pdfFileId: null,
      sha256Hex,
      sizeBytes: 128,
      type: "file",
      version: 1,
    };
    const result = await handleMcpToolCall({
      args: { entity_id: "00000000-0000-4000-8000-0000000e0001" },
      context: createContext({
        scopedDb: createScopedDb(
          [],
          createExtractedContentRow(),
          [currentPdf],
          {
            entityId: "00000000-0000-4000-8000-0000000e0001",
            kind: "document",
            name: "Current PDF",
            workspaceId: WORKSPACE_ID,
          },
          {
            runs: [
              {
                errorCode: null,
                finishedAt: indexedAt,
                id: "run_native_new",
                kind: "native-extraction",
                sourceFileId: currentPdf.id,
                sourceSha256Hex: sha256Hex,
                status: "succeeded",
              },
              {
                errorCode: "ocr_failed",
                finishedAt: new Date("2026-01-03T00:00:00.000Z"),
                id: "run_ocr_old",
                kind: "ocr",
                sourceFileId: currentPdf.id,
                sourceSha256Hex: sha256Hex,
                status: "failed",
              },
            ],
            searchUpdatedAt: new Date("2026-01-01T00:00:00.000Z"),
          },
        ),
      }),
      toolName: "read_document",
    });

    expect(parseToolPayload(result)).toMatchObject({
      searchIndexState: {
        status: "ready",
        updatedAt: indexedAt.toISOString(),
      },
    });
  });

  test("read_document uses successful processing runs as index completion provenance", async () => {
    const sha256Hex = "a".repeat(64);
    const indexedAt = new Date("2026-01-03T00:00:00.000Z");
    const currentPdf = {
      encrypted: false,
      fileName: "searchable.pdf",
      id: "file_1",
      mimeType: "application/pdf",
      pdfFileId: null,
      sha256Hex,
      sizeBytes: 128,
      type: "file",
      version: 1,
    };
    const result = await handleMcpToolCall({
      args: { entity_id: "00000000-0000-4000-8000-0000000e0001" },
      context: createContext({
        scopedDb: createScopedDb(
          [],
          createExtractedContentRow(),
          [currentPdf],
          {
            entityId: "00000000-0000-4000-8000-0000000e0001",
            kind: "document",
            name: "Searchable PDF",
            workspaceId: WORKSPACE_ID,
          },
          {
            runs: [
              {
                errorCode: null,
                finishedAt: indexedAt,
                id: "run_native",
                kind: "native-extraction",
                sourceFileId: "file_1",
                sourceSha256Hex: sha256Hex,
                status: "succeeded",
              },
            ],
            // Search projections persist the entity's semantic timestamp,
            // which legitimately predates extraction completion.
            searchUpdatedAt: new Date("2026-01-01T00:00:00.000Z"),
          },
        ),
      }),
      toolName: "read_document",
    });

    expect(parseToolPayload(result)).toMatchObject({
      contentState: { status: "ready", source: "extracted_text" },
      searchIndexState: {
        status: "ready",
        updatedAt: indexedAt.toISOString(),
      },
    });
  });

  test("read_document terminates unsupported extraction while reporting metadata indexing", async () => {
    const unsupportedFile = {
      encrypted: false,
      fileName: "payload.bin",
      id: "file_1",
      mimeType: "application/octet-stream",
      pdfFileId: null,
      sha256Hex: "a".repeat(64),
      sizeBytes: 128,
      type: "file",
      version: 1,
    };
    const result = await handleMcpToolCall({
      args: { entity_id: "00000000-0000-4000-8000-0000000e0001" },
      context: createContext({
        scopedDb: createScopedDb(
          [],
          null,
          [unsupportedFile],
          {
            entityId: "00000000-0000-4000-8000-0000000e0001",
            kind: "document",
            name: "Binary payload",
            workspaceId: WORKSPACE_ID,
          },
          {
            searchUpdatedAt: new Date("2026-01-02T00:00:00.000Z"),
          },
        ),
      }),
      toolName: "read_document",
    });

    expect(parseToolPayload(result)).toMatchObject({
      contentState: {
        status: "unsupported",
        reason:
          "Content extraction is not supported for application/octet-stream.",
      },
      searchIndexState: { status: "ready" },
    });
  });

  test("list_properties declares how file and scalar properties are written", async () => {
    const result = await handleMcpToolCall({
      args: { matter_id: WORKSPACE_ID },
      context: createContext({
        accessibleWorkspaceIds: [WORKSPACE_ID],
        scopedDb: createScopedDb([
          {
            content: { type: "file", version: 1 },
            createdAt: "2026-01-01T00:00:00.000000",
            id: FILE_PROPERTY_ID,
            name: "Documents",
            status: "fresh",
          },
          {
            content: { type: "text", version: 1 },
            createdAt: "2026-01-02T00:00:00.000000",
            id: TEXT_PROPERTY_ID,
            name: "Summary",
            status: "fresh",
          },
        ]),
      }),
      toolName: "list_properties",
    });

    expect(parseToolPayload(result)).toMatchObject({
      properties: [
        {
          id: FILE_PROPERTY_ID,
          valueType: "file",
          writeMethod: "unsupported",
        },
        {
          id: TEXT_PROPERTY_ID,
          valueType: "text",
          writeMethod: "set_field_value",
        },
      ],
    });
  });

  test("set_field_value explains the primary-file upload boundary", async () => {
    const result = await handleMcpToolCall({
      args: {
        entity_id: "00000000-0000-4000-8000-0000000e0001",
        property_id: FILE_PROPERTY_ID,
        content: { type: "file", value: "not-supported" },
      },
      context: createContext(),
      toolName: "set_field_value",
    });

    const error = validationEnvelope(result);
    expect(error).toMatchObject({
      code: "validation_error",
      message: "File properties cannot be targeted by set_field_value",
      hint: "To replace the document's primary file, call open_document_version_upload or upload_document_version. These tools do not target an arbitrary property_id.",
    });
    expect(error["issues"]).toEqual([
      {
        path: "content.type",
        message: "Arbitrary file-property cells are not writable",
      },
    ]);
  });

  test("save_document (update branch) rejects an empty update", async () => {
    const result = await handleMcpToolCall({
      args: { entity_id: "00000000-0000-4000-8000-0000000e0001" },
      context: createContext(),
      toolName: "save_document",
    });

    expectValidationMessage(
      result,
      "Provide at least one change: name, parent_id/move_to_root, or version_id with label/description",
    );
  });

  test("save_document (update branch) rejects parent_id together with move_to_root", async () => {
    const result = await handleMcpToolCall({
      args: {
        entity_id: "00000000-0000-4000-8000-0000000e0001",
        move_to_root: true,
        parent_id: FOLDER_ENTITY_ID,
      },
      context: createContext(),
      toolName: "save_document",
    });

    expectValidationMessage(
      result,
      "Provide either parent_id or move_to_root, not both",
    );
  });

  test("save_document (update branch) rejects label without version_id", async () => {
    // A rename keeps rule 1 (at least one change) satisfied so the failure
    // isolates the label-requires-version_id rule.
    const result = await handleMcpToolCall({
      args: {
        entity_id: "00000000-0000-4000-8000-0000000e0001",
        name: "Renamed",
        label: "Signed copy",
      },
      context: createContext(),
      toolName: "save_document",
    });

    expectValidationMessage(result, "label and description require version_id");
  });

  test("save_document rejects matter_id (a create field) alongside entity_id", async () => {
    const result = await handleMcpToolCall({
      args: {
        entity_id: "00000000-0000-4000-8000-0000000e0001",
        matter_id: WORKSPACE_ID,
        name: "Renamed",
      },
      context: createContext(),
      toolName: "save_document",
    });

    expectValidationMessage(
      result,
      "matter_id applies only when creating; omit it when updating a document",
    );
  });

  test("list_matters rejects matter_id combined with a list filter", async () => {
    const result = await handleMcpToolCall({
      args: { matter_id: WORKSPACE_ID, limit: 10 },
      context: createContext(),
      toolName: "list_matters",
    });

    const error = validationEnvelope(result);
    expect(error["code"]).toBe("validation_error");
    expect(error["message"]).toBe(
      "status, limit, and cursor apply when listing matters; omit matter_id to list",
    );
    expect(error["issues"]).toEqual([
      {
        path: "matter_id",
        message:
          "status, limit, and cursor apply when listing matters; omit matter_id to list",
      },
    ]);
  });

  // read_document's default branch returns the version history. Each version's
  // label/description are tenant-authored, so they must be pushed through the
  // anonymization plan (not left raw) on the anonymized surface.
  type VersionHistoryRow = {
    createdAt: Date;
    description: string | null;
    id: string;
    label: string | null;
    stamp: string | null;
    versionNumber: number;
  };

  const createVersionHistoryScopedDb = (rows: VersionHistoryRow[]) =>
    asTestRaw<McpRequestContext["scopedDb"]>(
      mock(async (callback: (tx: unknown) => unknown) => {
        const selectBuilder = {
          from: () => selectBuilder,
          where: () => selectBuilder,
          orderBy: () => selectBuilder,
          limit: () => rows,
        };
        return await callback({
          query: {
            entities: {
              findFirst: async () => ({
                createdAt: new Date("2025-12-01T00:00:00.000Z"),
                kind: "document",
                name: "Secret Doc for John Smith",
                updatedAt: new Date("2026-01-01T00:00:00.000Z"),
                workspaceId: WORKSPACE_ID,
                extractedContent: null,
                currentVersion: {
                  createdAt: new Date("2026-01-01T00:00:00.000Z"),
                  id: "ver_current",
                  fields: [],
                },
                versions: [{ id: "ver_current" }],
              }),
            },
            documentProcessingRuns: { findMany: async () => [] },
            entityVersions: {
              findFirst: async () => ({ id: "ver_current" }),
            },
            extractedContent: { findFirst: async () => null },
            fields: {
              findMany: async () => [],
            },
            organizationSettings: {
              findFirst: async () => ({ documentProcessingMode: "off" }),
            },
            searchDocuments: {
              findFirst: async () => ({
                updatedAt: new Date("2026-01-02T00:00:00.000Z"),
              }),
            },
          },
          select: () => selectBuilder,
        });
      }),
    );

  test("read_document anonymizes version-history labels and descriptions", async () => {
    anonymizeTextFieldsMock.mockResolvedValue({
      entityCount: 1,
      fields: ["[DOC]", "[PERSON_1] draft", "Redacted note"],
    });

    const result = await handleMcpToolCall({
      args: {
        entity_id: "00000000-0000-4000-8000-0000000e0001",
        include_versions: true,
      },
      context: createContext({
        scopedDb: createVersionHistoryScopedDb([
          {
            createdAt: new Date("2026-01-01T00:00:00.000Z"),
            description: "Note authored by John Smith",
            id: "ver_1",
            label: "Draft by John Smith",
            stamp: null,
            versionNumber: 2,
          },
        ]),
      }),
      mode: "anonymized",
      toolName: "read_document",
    });

    // The version label and description reach the redactor as raw text fields;
    // without the fix they would never be enqueued and would leak verbatim.
    const anonymizeInput = anonymizeTextFieldsMock.mock.calls.at(-1)?.[0];
    expect(anonymizeInput).toMatchObject({
      fields: [
        "Secret Doc for John Smith",
        "Draft by John Smith",
        "Note authored by John Smith",
      ],
      workspaceId: WORKSPACE_ID,
    });

    expect(parseToolPayload(result)).toMatchObject({
      versions: [
        expect.objectContaining({
          description: "Redacted note",
          label: "[PERSON_1] draft",
        }),
      ],
    });
  });

  // --- Wave 2: matter / contact / task tools ---------------------------

  // save_* tools enforce their create/update shape with v.partialCheck at the
  // schema, so an invalid combination fails before any permission or DB access
  // and surfaces the specific partial_check message.
  test("save_matter rejects a create with no name", async () => {
    const result = await handleMcpToolCall({
      args: {},
      context: createContext(),
      toolName: "save_matter",
    });

    expectValidationMessage(result, "name is required to create a matter");
  });

  // Archived matters stay readable but are read-only through the write tools,
  // mirroring the HTTP validateWorkspaceAccess macro (which 404s a workspace
  // whose status is not "active"). A field edit on an archived matter is
  // rejected before any backing handler runs.
  test("save_matter rejects a write to an archived matter", async () => {
    const result = await handleMcpToolCall({
      args: { matter_id: WORKSPACE_ID, name: "Renamed" },
      context: createContext({ archivedWorkspaceIds: [WORKSPACE_ID] }),
      toolName: "save_matter",
    });

    expect(result).toEqual({
      content: [
        { type: "text", text: "Matter is archived; unarchive it first" },
      ],
      isError: true,
    });
  });

  // The one write allowed on an archived matter is a pure status:"active" flip
  // (unarchive); it must still go through.
  const createWorkspaceUnarchiveScopedDb = () =>
    asTestRaw<McpRequestContext["scopedDb"]>(
      mock(async (callback: (tx: unknown) => unknown) => {
        const builder = {
          set: () => builder,
          where: () => builder,
          returning: async () => [{ id: WORKSPACE_ID }],
        };
        return await callback({ update: () => builder });
      }),
    );

  test("save_matter allows unarchiving an archived matter", async () => {
    const result = await handleMcpToolCall({
      args: { matter_id: WORKSPACE_ID, status: "active" },
      context: createContext({
        archivedWorkspaceIds: [WORKSPACE_ID],
        scopedDb: createWorkspaceUnarchiveScopedDb(),
      }),
      toolName: "save_matter",
    });

    expect(result.isError).toBeUndefined();
    expect(parseToolPayload(result)).toEqual({
      matterId: WORKSPACE_ID,
      updated: true,
    });
  });

  test("save_contact rejects a create with no type", async () => {
    const result = await handleMcpToolCall({
      args: { display_name: "Acme Corp" },
      context: createContext(),
      toolName: "save_contact",
    });

    expectValidationMessage(result, "type is required to create a contact");
  });

  test("save_contact rejects a create with no name to display", async () => {
    const result = await handleMcpToolCall({
      args: { type: "person", notes: "met at conference" },
      context: createContext(),
      toolName: "save_contact",
    });

    expectValidationMessage(
      result,
      "display_name is required to create a contact, or first_name/last_name (person) or organization_name (organization) to derive it from",
    );
  });

  describe("deriveContactDisplayName", () => {
    test("prefers an explicit display name", () => {
      expect(
        deriveContactDisplayName({
          display_name: " Acme Corp ",
          first_name: "Jan",
          type: "person",
        }),
      ).toBe("Acme Corp");
    });

    test("derives a person from first and last name", () => {
      expect(
        deriveContactDisplayName({
          first_name: " Jan ",
          last_name: " Novák ",
          type: "person",
        }),
      ).toBe("Jan Novák");
    });

    test("derives a person from whichever name part is present", () => {
      expect(
        deriveContactDisplayName({ last_name: "Novák", type: "person" }),
      ).toBe("Novák");
    });

    test("derives an organization from its organization name", () => {
      expect(
        deriveContactDisplayName({
          organization_name: "Acme s.r.o.",
          type: "organization",
        }),
      ).toBe("Acme s.r.o.");
    });

    test("falls back across kinds rather than yielding no name", () => {
      expect(
        deriveContactDisplayName({
          organization_name: "Acme s.r.o.",
          type: "person",
        }),
      ).toBe("Acme s.r.o.");
    });

    test("yields an empty name when no part carries one", () => {
      expect(
        deriveContactDisplayName({
          first_name: "  ",
          organization_name: null,
          type: "person",
        }),
      ).toBe("");
    });
  });

  test("list_contacts returns internal directory IDs from the shared query", async () => {
    const contact = {
      id: CONTACT_ID,
      type: "organization",
      displayName: "Acme Corp",
      firstName: null,
      lastName: null,
      organizationName: "Acme Corp",
      emails: [],
      phones: [],
      tags: [],
      color: null,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      clientMatterCount: 1,
    };
    const result = await handleMcpToolCall({
      args: { q: "Acme", limit: 10 },
      context: createContext({ scopedDb: createScopedDb([contact]) }),
      toolName: "list_contacts",
    });

    expect(result.isError).toBeUndefined();
    expect(parseToolPayload(result)).toMatchObject({
      items: [{ id: CONTACT_ID }],
    });
  });

  test("list_contacts rejects unknown input instead of stripping it", async () => {
    const result = await handleMcpToolCall({
      args: { registry: "ares" },
      context: createContext(),
      toolName: "list_contacts",
    });

    const error = validationEnvelope(result);
    expect(error["code"]).toBe("validation_error");
    expect(error["issues"]).toEqual([
      { path: "registry", message: expect.any(String) },
    ]);
  });

  test("save_task rejects a create with no matter_id", async () => {
    const result = await handleMcpToolCall({
      args: { name: "Draft motion" },
      context: createContext(),
      toolName: "save_task",
    });

    expectValidationMessage(result, "matter_id is required to create a task");
  });

  // list_tasks (detail) and save_task confine themselves to entities of kind
  // "task": a document/folder ID the caller can otherwise access is rejected as
  // wrong-kind, not acted on.
  const createTaskKindScopedDb = (kind: string) =>
    asTestRaw<McpRequestContext["scopedDb"]>(
      mock(
        async (
          callback: (tx: {
            query: {
              entities: {
                findFirst: () => Promise<{
                  kind: string;
                  workspaceId: string;
                }>;
              };
            };
          }) => unknown,
        ) =>
          await callback({
            query: {
              entities: {
                findFirst: async () => ({ kind, workspaceId: WORKSPACE_ID }),
              },
            },
          }),
      ),
    );

  test("list_tasks rejects a task_id that is not a task", async () => {
    const result = await handleMcpToolCall({
      args: { task_id: DOCUMENT_ENTITY_ID },
      context: createContext({ scopedDb: createTaskKindScopedDb("document") }),
      toolName: "list_tasks",
    });

    expect(result).toEqual({
      content: [{ type: "text", text: "Not a task entity" }],
      isError: true,
    });
  });

  test("save_task rejects a task_id that is not a task", async () => {
    const result = await handleMcpToolCall({
      args: { task_id: DOCUMENT_ENTITY_ID, name: "Renamed" },
      context: createContext({ scopedDb: createTaskKindScopedDb("document") }),
      toolName: "save_task",
    });

    expect(result).toEqual({
      content: [{ type: "text", text: "Not a task entity" }],
      isError: true,
    });
  });

  // save_task ignored matter_id on update, so a mismatched pair silently
  // updated a task under the wrong matter. The handler now rejects it.
  test("save_task rejects a task whose matter_id does not match", async () => {
    const result = await handleMcpToolCall({
      args: {
        task_id: "00000000-0000-4000-8000-00000007a001",
        matter_id: WORKSPACE_ID_2,
        name: "Renamed",
      },
      context: createContext({ scopedDb: createTaskKindScopedDb("task") }),
      toolName: "save_task",
    });

    expect(result).toEqual({
      content: [{ type: "text", text: "task_id does not belong to matter_id" }],
      isError: true,
    });
  });

  // list_tasks detail resolved by task_id alone, so a task_id paired with a
  // different accessible matter_id leaked a task from the wrong matter. The
  // detail branch now enforces the same pairing check as save_task.
  test("list_tasks detail rejects a task whose matter_id does not match", async () => {
    const result = await handleMcpToolCall({
      args: {
        task_id: "00000000-0000-4000-8000-00000007a001",
        matter_id: WORKSPACE_ID_2,
      },
      context: createContext({
        accessibleWorkspaceIds: [WORKSPACE_ID, WORKSPACE_ID_2],
        scopedDb: createTaskKindScopedDb("task"),
      }),
      toolName: "list_tasks",
    });

    expect(result).toEqual({
      content: [{ type: "text", text: "task_id does not belong to matter_id" }],
      isError: true,
    });
  });

  // unlink_link_id is validated against the task up front: a link belonging to
  // a different task in the same matter is rejected before any mutation runs.
  const createUnlinkMismatchScopedDb = () =>
    asTestRaw<McpRequestContext["scopedDb"]>(
      mock(
        async (
          callback: (tx: {
            query: {
              entities: {
                findFirst: () => Promise<{
                  kind: string;
                  workspaceId: string;
                }>;
              };
              entityLinks: {
                findFirst: () => Promise<{
                  sourceEntityId: string;
                  targetEntityId: string;
                }>;
              };
            };
          }) => unknown,
        ) =>
          await callback({
            query: {
              entities: {
                findFirst: async () => ({
                  kind: "task",
                  workspaceId: WORKSPACE_ID,
                }),
              },
              entityLinks: {
                findFirst: async () => ({
                  sourceEntityId: "other_task",
                  targetEntityId: "other_doc",
                }),
              },
            },
          }),
      ),
    );

  test("save_task rejects an unlink_link_id that belongs to another task", async () => {
    const result = await handleMcpToolCall({
      args: {
        task_id: "00000000-0000-4000-8000-00000007a001",
        unlink_link_id: ENTITY_LINK_ID,
      },
      context: createContext({ scopedDb: createUnlinkMismatchScopedDb() }),
      toolName: "save_task",
    });

    expect(result).toEqual({
      content: [
        { type: "text", text: "unlink_link_id does not belong to this task" },
      ],
      isError: true,
    });
  });

  // link_entity_id is validated up front against every rejection the backing
  // createEntityLinkHandler applies (self-link, duplicate, read-only target),
  // so a field edit bundled with a doomed link cannot half-apply.
  const createLinkRejectionScopedDb = ({
    existingLink = null,
    updateMock,
  }: {
    existingLink?: { id: string } | null;
    updateMock: ReturnType<typeof mock>;
  }) =>
    asTestRaw<McpRequestContext["scopedDb"]>(
      mock(
        async (
          callback: (tx: {
            query: {
              entities: {
                findFirst: () => Promise<{
                  kind: string;
                  readOnly: boolean;
                  workspaceId: string;
                }>;
              };
              entityLinks: {
                findFirst: () => Promise<{ id: string } | null>;
              };
            };
            update: typeof updateMock;
          }) => unknown,
        ) =>
          await callback({
            query: {
              entities: {
                findFirst: async () => ({
                  kind: "task",
                  readOnly: false,
                  workspaceId: WORKSPACE_ID,
                }),
              },
              entityLinks: {
                findFirst: async () => existingLink,
              },
            },
            update: updateMock,
          }),
      ),
    );

  test("save_task rejects a field edit combined with a self-link, without applying the edit", async () => {
    const updateMock = mock(() => ({
      set: () => ({ where: () => ({ returning: async () => [] }) }),
    }));

    const result = await handleMcpToolCall({
      args: {
        task_id: "00000000-0000-4000-8000-00000007a001",
        name: "Renamed",
        link_entity_id: "00000000-0000-4000-8000-00000007a001",
      },
      context: createContext({
        scopedDb: createLinkRejectionScopedDb({ updateMock }),
      }),
      toolName: "save_task",
    });

    expect(result).toEqual({
      content: [{ type: "text", text: "Cannot link an entity to itself" }],
      isError: true,
    });
    expect(updateMock).not.toHaveBeenCalled();
  });

  test("save_task rejects a field edit combined with a duplicate link, without applying the edit", async () => {
    const updateMock = mock(() => ({
      set: () => ({ where: () => ({ returning: async () => [] }) }),
    }));

    const result = await handleMcpToolCall({
      args: {
        task_id: "00000000-0000-4000-8000-00000007a001",
        name: "Renamed",
        link_entity_id: "00000000-0000-4000-8000-00000007a002",
      },
      context: createContext({
        scopedDb: createLinkRejectionScopedDb({
          existingLink: { id: "link_existing" },
          updateMock,
        }),
      }),
      toolName: "save_task",
    });

    expect(result).toEqual({
      content: [
        { type: "text", text: "A link between these entities already exists" },
      ],
      isError: true,
    });
    expect(updateMock).not.toHaveBeenCalled();
  });

  // save_task writes task status through the same handler as the task API, so
  // the governed lifecycle binds it too. Governed enforcement is off in this
  // deployment, so the legacy freedom to complete cancelled work has to
  // survive: the shared transition table is not consulted at all.
  const createTaskStatusScopedDb = () => {
    const workflowUpdates: Record<string, unknown>[] = [];
    const { scopedDb } = createScopedDbMock({
      query: {
        entities: {
          findFirst: async () => ({
            kind: "task",
            readOnly: false,
            workspaceId: WORKSPACE_ID,
          }),
        },
      },
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => ({
              for: async () => [
                {
                  entityId: "00000000-0000-4000-8000-00000007a001",
                  workspaceId: WORKSPACE_ID,
                  type: "task",
                  status: WORK_OBLIGATION_STATUS.CANCELLED,
                  ownerUserId: null,
                  acknowledgedAt: null,
                  workingTargetDate: null,
                  hardDeadlineDate: null,
                },
              ],
            }),
          }),
        }),
      }),
      update: (table: unknown) => ({
        set: (values: Record<string, unknown>) => {
          if (table === workObligations) {
            workflowUpdates.push(values);
          }
          return {
            where: () => ({
              returning: async () =>
                table === entities
                  ? [{ id: "00000000-0000-4000-8000-00000007a001" }]
                  : [{ entityId: "00000000-0000-4000-8000-00000007a001" }],
            }),
          };
        },
      }),
      insert: () => ({ values: async () => {} }),
    });
    return { scopedDb, workflowUpdates };
  };

  test("save_task completes cancelled work while governed enforcement is off", async () => {
    const { scopedDb, workflowUpdates } = createTaskStatusScopedDb();

    const result = await handleMcpToolCall({
      args: { task_id: "00000000-0000-4000-8000-00000007a001", status: "done" },
      context: createContext({ scopedDb }),
      toolName: "save_task",
    });

    expect(result).toEqual({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            taskId: "00000000-0000-4000-8000-00000007a001",
            updated: true,
          }),
        },
      ],
      structuredContent: {
        taskId: "00000000-0000-4000-8000-00000007a001",
        updated: true,
      },
    });
    expect(workflowUpdates).toEqual([
      expect.objectContaining({ status: WORK_OBLIGATION_STATUS.COMPLETED }),
    ]);
  });

  // link_matter_contact accepts contact_id as an unlink selector, but a contact
  // holding several roles maps to several links, so it must ask for the precise
  // matter_contact_id instead of guessing.
  const createMultiRoleContactScopedDb = () =>
    asTestRaw<McpRequestContext["scopedDb"]>(
      mock(
        async (
          callback: (tx: {
            query: {
              workspaceContacts: {
                findMany: () => Promise<{ id: string }[]>;
              };
            };
          }) => unknown,
        ) =>
          await callback({
            query: {
              workspaceContacts: {
                findMany: async () => [{ id: "wc_1" }, { id: "wc_2" }],
              },
            },
          }),
      ),
    );

  test("link_matter_contact rejects an ambiguous contact_id unlink", async () => {
    const result = await handleMcpToolCall({
      args: { matter_id: WORKSPACE_ID, contact_id: CONTACT_ID },
      context: createContext({ scopedDb: createMultiRoleContactScopedDb() }),
      toolName: "link_matter_contact",
    });

    expect(result).toEqual({
      content: [
        {
          type: "text",
          text: "That contact holds multiple roles on the matter; pass matter_contact_id to remove one link",
        },
      ],
      isError: true,
    });
  });

  // A scopedDb whose single select builder returns the given rows from
  // `.limit()`. Shared by the list_tasks and list_time_entries anonymized-egress
  // tests, both of which run one `.select().from().where().orderBy().limit()`
  // read through the structured egress pipeline.
  const createSelectListScopedDb = (rows: readonly Record<string, unknown>[]) =>
    asTestRaw<McpRequestContext["scopedDb"]>(
      mock(async (callback: (tx: unknown) => unknown) => {
        const builder = {
          from: () => builder,
          where: () => builder,
          orderBy: () => builder,
          limit: () => rows,
        };
        return await callback({ select: () => builder });
      }),
    );

  test("list_tasks anonymizes task names in anonymized mode", async () => {
    anonymizeTextFieldsMock.mockResolvedValue({
      entityCount: 1,
      fields: ["[PERSON_1] deposition"],
    });

    const result = await handleMcpToolCall({
      args: { matter_id: WORKSPACE_ID },
      context: createContext({
        scopedDb: createSelectListScopedDb([
          {
            createdAt: "2026-01-01T00:00:00.000000",
            id: "00000000-0000-4000-8000-00000007a001",
            name: "John Smith deposition",
            status: "open",
            priority: "high",
            dueDate: "2026-02-01",
          },
        ]),
      }),
      mode: "anonymized",
      toolName: "list_tasks",
    });

    const anonymizeInput = anonymizeTextFieldsMock.mock.calls.at(-1)?.[0];
    expect(anonymizeInput).toMatchObject({
      fields: ["John Smith deposition"],
      workspaceId: WORKSPACE_ID,
    });

    expect(parseToolPayload(result)).toEqual({
      tasks: [
        {
          id: "00000000-0000-4000-8000-00000007a001",
          itemType: "task",
          name: "[PERSON_1] deposition",
          status: "open",
          priority: "high",
          dueDate: "2026-02-01",
        },
      ],
      nextCursor: null,
    });
  });

  // list_time_entries (list mode) runs through the structured egress pipeline,
  // so in anonymized mode each entry's narrative is redacted under its matter's
  // workspace scope before it leaves Stella. A null userId keeps the user-name
  // lookup from running, so only the narrative is pushed.
  test("list_time_entries anonymizes narratives in anonymized mode", async () => {
    anonymizeTextFieldsMock.mockResolvedValue({
      entityCount: 1,
      fields: ["Call with [PERSON_1]"],
    });

    const result = await handleMcpToolCall({
      args: { matter_id: WORKSPACE_ID },
      context: createContext({
        scopedDb: createSelectListScopedDb([
          {
            id: TIME_ENTRY_ID,
            entityId: "00000000-0000-4000-8000-0000000e0001",
            userId: null,
            dateWorked: "2026-02-01",
            durationMinutes: 60,
            billedMinutes: 60,
            rateAtEntry: 25_000,
            currency: "EUR",
            narrative: "Call with John Smith",
            invoiceNarrative: null,
            billable: true,
            noCharge: false,
            status: "draft",
          },
        ]),
      }),
      mode: "anonymized",
      toolName: "list_time_entries",
    });

    const anonymizeInput = anonymizeTextFieldsMock.mock.calls.at(-1)?.[0];
    expect(anonymizeInput).toMatchObject({
      fields: ["Call with John Smith"],
      workspaceId: WORKSPACE_ID,
    });

    expect(parseToolPayload(result)).toEqual({
      visibility: "all_entries",
      entries: [
        {
          id: TIME_ENTRY_ID,
          entityId: "00000000-0000-4000-8000-0000000e0001",
          userId: null,
          userName: null,
          dateWorked: "2026-02-01",
          durationMinutes: 60,
          billedMinutes: 60,
          rateAtEntry: 25_000,
          currency: "EUR",
          narrative: "Call with [PERSON_1]",
          invoiceNarrative: null,
          billable: true,
          noCharge: false,
          status: "draft",
        },
      ],
      nextCursor: null,
    });
  });

  // save_time_entry merges create and update. An update (time_entry_id present)
  // with no other field is a no-op the caller almost certainly did not intend;
  // the cross-field schema rejects it before touching the database.
  test("save_time_entry rejects an update with no changes", async () => {
    const result = await handleMcpToolCall({
      args: { time_entry_id: TIME_ENTRY_ID },
      context: createContext(),
      toolName: "save_time_entry",
    });

    expectValidationMessage(
      result,
      "Provide at least one change to the time entry",
    );
  });

  // Time-and-billing tools carry FEATURE_TIME_BILLING; get_usage carries
  // FEATURE_USAGE. The gate hides a flagged tool from the list and rejects its
  // dispatch when the flag is off outside dev. Both flags are flipped in place
  // and restored in a finally so the change cannot leak into a neighbour.
  const withBillingFlags = async (
    {
      featureTimeBilling,
      featureUsage,
      isDev,
    }: { featureTimeBilling: boolean; featureUsage: boolean; isDev: boolean },
    run: () => Promise<void>,
  ) => {
    const previousTimeBilling = env.FEATURE_TIME_BILLING;
    const previousUsage = env.FEATURE_USAGE;
    const previousIsDev = env.isDev;
    env.FEATURE_TIME_BILLING = featureTimeBilling;
    env.FEATURE_USAGE = featureUsage;
    env.isDev = isDev;
    try {
      await run();
    } finally {
      env.FEATURE_TIME_BILLING = previousTimeBilling;
      env.FEATURE_USAGE = previousUsage;
      env.isDev = previousIsDev;
    }
  };

  test("hides time-and-billing tools when FEATURE_TIME_BILLING is off outside dev", async () => {
    await withBillingFlags(
      { featureTimeBilling: false, featureUsage: true, isDev: false },
      async () => {
        const toolNames = (await listMcpTools(createContext())).map(
          (tool) => tool.name,
        );

        expect(toolNames).not.toContain("list_time_entries");
        expect(toolNames).not.toContain("save_time_entry");
        // Untagged tools stay listed.
        expect(toolNames).toContain("list_matters");
      },
    );
  });

  test("lists time-and-billing tools once FEATURE_TIME_BILLING is on", async () => {
    await withBillingFlags(
      { featureTimeBilling: true, featureUsage: true, isDev: false },
      async () => {
        const toolNames = (await listMcpTools(createContext())).map(
          (tool) => tool.name,
        );

        expect(toolNames).toContain("list_time_entries");
        expect(toolNames).toContain("save_time_entry");
        expect(toolNames).toContain("delete_time_entry");
      },
    );
  });

  test("rejects dispatch of save_time_entry when FEATURE_TIME_BILLING is off outside dev", async () => {
    await withBillingFlags(
      { featureTimeBilling: false, featureUsage: true, isDev: false },
      async () => {
        const recordAuditEvent = createRecordAuditEventMock();
        const result = await handleMcpToolCall({
          args: {
            matter_id: WORKSPACE_ID,
            entity_id: "00000000-0000-4000-8000-0000000e0001",
            date_worked: "2026-02-01",
            timezone_id: "Europe/Prague",
            duration_minutes: 60,
            rate_at_entry: 25_000,
            currency: "EUR",
            narrative: "Call with client",
          },
          context: createContext({ recordAuditEvent }),
          toolName: "save_time_entry",
        });

        expectErrorEnvelope(result, {
          code: "feature_disabled",
          message: "This feature is not enabled on this deployment",
          hint: featureDisabledHint("FEATURE_TIME_BILLING"),
        });
        // The gate short-circuits before the backing handler runs, so no audit
        // row is written by guessing the tool name.
        expect(recordAuditEvent).not.toHaveBeenCalled();
      },
    );
  });

  // get_usage is gated by FEATURE_USAGE, independently of FEATURE_TIME_BILLING:
  // with time-billing on but usage off, the billing tools list but get_usage
  // does not, and its dispatch is rejected.
  test("gates get_usage on FEATURE_USAGE independently of FEATURE_TIME_BILLING", async () => {
    await withBillingFlags(
      { featureTimeBilling: true, featureUsage: false, isDev: false },
      async () => {
        const toolNames = (await listMcpTools(createContext())).map(
          (tool) => tool.name,
        );
        expect(toolNames).toContain("list_time_entries");
        expect(toolNames).not.toContain("get_usage");

        const result = await handleMcpToolCall({
          args: {},
          context: createContext(),
          toolName: "get_usage",
        });
        expectErrorEnvelope(result, {
          code: "feature_disabled",
          message: "This feature is not enabled on this deployment",
          hint: featureDisabledHint("FEATURE_USAGE"),
        });
      },
    );

    await withBillingFlags(
      { featureTimeBilling: true, featureUsage: true, isDev: false },
      async () => {
        const toolNames = (await listMcpTools(createContext())).map(
          (tool) => tool.name,
        );
        expect(toolNames).toContain("get_usage");
      },
    );
  });

  // --- Destructive-op confirm guardrail --------------------------------

  // A destructiveHint tool (delete_*) is refused before dispatch unless the
  // caller passes confirm: true, so an agent cannot delete without an explicit
  // human-approved confirmation. The gate runs before any DB access.
  test("delete_document refuses to run without confirm: true", async () => {
    const result = await handleMcpToolCall({
      args: { entity_id: "00000000-0000-4000-8000-0000000e0001" },
      context: createContext(),
      toolName: "delete_document",
    });

    expectErrorEnvelope(result, {
      code: "confirmation_required",
      message:
        "delete_document is an irreversible operation and was called without confirmation",
      hint: "This operation is irreversible. Confirm with the human user, then retry with confirm: true.",
    });
  });

  test("delete_document clears the confirm gate when confirm is true", async () => {
    // confirm: true clears the guardrail; the call proceeds to the handler,
    // which 404s the unknown entity — proving the gate no longer short-circuits
    // and that the handler tolerates the extra confirm arg.
    const result = await handleMcpToolCall({
      args: {
        entity_id: "00000000-0000-4000-8000-0000000e0404",
        confirm: true,
      },
      context: createContext(),
      toolName: "delete_document",
    });

    expectErrorEnvelope(result, {
      code: "not_found",
      message: "Document not found or not accessible",
    });
  });

  // A guessed tool name reports unknown_tool rather than a bare string, so an
  // agent can branch on the code.
  test("dispatching an unknown tool returns the unknown_tool envelope", async () => {
    const result = await handleMcpToolCall({
      args: {},
      context: createContext(),
      toolName: "not_a_real_tool",
    });

    expectErrorEnvelope(result, {
      code: "unknown_tool",
      message: "Unknown tool: not_a_real_tool",
      hint: "Call tools/list for the tools available to this session.",
    });
  });

  test("documents mode admits only the canonical version-upload lifecycle", async () => {
    for (const capability of [
      "uploads.create",
      "uploads.update",
      "uploads.delete",
    ]) {
      expect(isDocumentsMcpCapabilityAllowed({ capability })).toBe(true);
    }
    expect(
      isDocumentsMcpCapabilityAllowed({ capability: "matters.create" }),
    ).toBe(false);

    const result = await handleMcpToolCall({
      args: { capability: "matters.create", input: {} },
      context: createContext(),
      mode: "documents",
      toolName: "invoke_capability",
    });
    expectErrorEnvelope(result, {
      code: "feature_disabled",
      message: "This capability is not available on the documents MCP surface",
      hint: "Use one of the upload lifecycle operations exposed by the document upload panel.",
    });
  });
});

/**
 * The dispatch-level unknown-key backstop. Every curated tool derives its
 * advertised schema from the `v.strictObject` its handler parses, so this guard
 * is redundant for them by construction; it exists so a tool that ever bypasses
 * that path still cannot silently swallow a typo. Exercised against fabricated
 * schemas, which is the case the registry itself cannot produce.
 */
describe("undeclared-argument backstop", () => {
  const fakeToolSchema = {
    type: "object",
    properties: {
      matter_id: { type: "string", description: "Matter ID" },
      limit: { type: "integer", description: "Max rows" },
    },
    required: ["matter_id"],
    additionalProperties: false,
  } as const;

  test("accepts exactly the declared keys", () => {
    expect(
      findUndeclaredArguments({
        args: { matter_id: WORKSPACE_ID, limit: 10 },
        inputSchema: fakeToolSchema,
      }),
    ).toBeUndefined();
  });

  test("names every undeclared key, with a did-you-mean for case/underscore slips", () => {
    expect(
      findUndeclaredArguments({
        args: { matter_id: WORKSPACE_ID, matterId: WORKSPACE_ID, bogus: 1 },
        inputSchema: fakeToolSchema,
      }),
    ).toEqual({
      declared: ["matter_id", "limit"],
      undeclared: [
        { key: "matterId", suggestion: "matter_id" },
        { key: "bogus", suggestion: undefined },
      ],
    });
  });

  test("a no-property schema declares nothing, so any key is undeclared", () => {
    expect(
      findUndeclaredArguments({
        args: { anything: true },
        inputSchema: { type: "object" },
      }),
    ).toEqual({
      declared: [],
      undeclared: [{ key: "anything", suggestion: undefined }],
    });
  });

  test("an explicitly open schema keeps its open contract", () => {
    expect(
      findUndeclaredArguments({
        args: { passthrough: true },
        inputSchema: { type: "object", additionalProperties: true },
      }),
    ).toBeUndefined();
  });

  test("dispatch rejects an undeclared key before the handler runs", async () => {
    const result = await handleMcpToolCall({
      args: { matterId: WORKSPACE_ID },
      context: createContext(),
      toolName: "list_matters",
    });

    const error = validationEnvelope(result);
    expect(error["code"]).toBe("validation_error");
    expect(error["message"]).toBe("Unknown parameter: matterId");
    expect(error["issues"]).toEqual([
      {
        path: "matterId",
        message: "Unknown parameter: matterId (did you mean matter_id?)",
      },
    ]);
  });
});
