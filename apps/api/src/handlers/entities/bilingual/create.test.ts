import { Result } from "better-result";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { Paragraph } from "@stll/docx-core/model";
import {
  createDocx,
  createEmptyDocument,
  createStellaStyleDocumentPreset,
} from "@stll/folio-core";
import { readBilingualDocx } from "@stll/folio-core/server";

import { toSafeId } from "@/api/lib/branded-types";
import { validateDocxBuffer } from "@/api/lib/entity-versions/validate-docx-buffer";
import { DOCX_MIME_TYPE } from "@/api/mime-types";
import { installRecordingAnalytics } from "@/api/tests/helpers/recording-telemetry";
import type { RecordingAnalytics } from "@/api/tests/helpers/recording-telemetry";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

const organizationId = toSafeId<"organization">(
  "00000000-0000-0000-0000-000000000001",
);
const workspaceId = toSafeId<"workspace">(
  "00000000-0000-0000-0000-000000000002",
);
const entityId = toSafeId<"entity">("00000000-0000-0000-0000-000000000003");
const fieldId = toSafeId<"field">("00000000-0000-0000-0000-000000000004");
const userId = toSafeId<"user">("00000000-0000-0000-0000-000000000005");
const entityVersionId = toSafeId<"entityVersion">(
  "00000000-0000-0000-0000-000000000006",
);
const propertyId = toSafeId<"property">("00000000-0000-0000-0000-000000000007");

const clause = (text: string, styleId: string): Paragraph => ({
  type: "paragraph",
  formatting: { styleId },
  content: [{ type: "run", formatting: {}, content: [{ type: "text", text }] }],
});

const buildSourceDocx = async (): Promise<ArrayBuffer> => {
  const doc = createEmptyDocument({
    preset: createStellaStyleDocumentPreset(),
  });
  doc.package.document.content = [
    clause("Definitions", "ClauseHeading1"),
    clause("Agreement means this contract.", "ClauseParagraph1"),
    clause("Term", "ClauseHeading1"),
    {
      type: "table",
      rows: [
        {
          type: "tableRow",
          cells: [{ type: "tableCell", content: [clause("Name:", "Normal")] }],
        },
      ],
    },
  ];
  return createDocx(doc);
};

const sourceDocx = await buildSourceDocx();

const loadEntityVersionDocxBufferMock = mock(async () =>
  Result.ok({
    entityId,
    workspaceId,
    entityVersionId,
    buffer: sourceDocx,
    fileName: "Smlouva.docx",
    filePropertyId: propertyId,
  }),
);

type ScanFileInput = {
  buffer: Uint8Array;
  declaredMimeType: string;
  fileName: string;
};
type ScanVerdict = "accept" | "reject";
let scanVerdict: ScanVerdict = "accept";
const scanFileMock = mock(async (_input: ScanFileInput) =>
  Result.ok(
    scanVerdict === "accept"
      ? { verdict: "accept" as const, findings: [] }
      : {
          verdict: "reject" as const,
          findings: [
            {
              rule: "mime-magic-mismatch",
              severity: "reject" as const,
              message: "content does not match",
            },
          ],
        },
  ),
);

type CreateEntityFromBufferInput = {
  buffer: ArrayBuffer;
  fileName: string;
  mimeType: string;
};
const createEntityFromBufferMock = mock(
  async ({ fileName }: CreateEntityFromBufferInput) =>
    Result.ok({
      entityId: toSafeId<"entity">("00000000-0000-0000-0000-000000000099"),
      fieldId: toSafeId<"field">("00000000-0000-0000-0000-000000000098"),
      fileName,
    }),
);

const { createBilingualEntityHandler } = await import("./create");
const createBilingualEntity = createBilingualEntityHandler({
  createEntityFromBuffer: asTestRaw(createEntityFromBufferMock),
  getScanWarnings: () => null,
  loadEntityVersionDocxBuffer: loadEntityVersionDocxBufferMock,
  scanFile: asTestRaw(scanFileMock),
});

type Ctx = Parameters<typeof createBilingualEntity.handler>[0];

const createContext = (body: Partial<Ctx["body"]> = {}): Ctx =>
  asTestRaw<Ctx>({
    body: {
      entityId,
      fieldId,
      sourceLang: "cs",
      targetLang: "en",
      ...body,
    },
    ...createScopedDbMock({}),
    session: { activeOrganizationId: organizationId },
    workspaceId,
    user: { id: userId },
    recordAuditEvent: async () => {},
    memberRole: { role: "owner" },
    getActiveWorkspaceIds: async () => [workspaceId],
    getAccessibleWorkspaces: async () => [],
    getWorkspaceAccess: async () => null,
    orgAIConfig: null,
    promptCachingEnabled: true,
    request: new Request("http://localhost/entities/test/bilingual"),
    route: "/entities/:workspaceId/bilingual",
  });

describe("createBilingualEntity", () => {
  let analytics: RecordingAnalytics;

  beforeEach(() => {
    analytics = installRecordingAnalytics();
    scanVerdict = "accept";
    loadEntityVersionDocxBufferMock.mockClear();
    scanFileMock.mockClear();
    createEntityFromBufferMock.mockClear();
  });

  afterEach(() => {
    analytics.restore();
  });

  test("rejects identical source and target languages before loading anything", async () => {
    const result = await createBilingualEntity.handler(
      createContext({ sourceLang: "en", targetLang: "EN" }),
    );

    expect(result).toEqual({
      code: 400,
      response: { message: "Source and target language must differ" },
    });
    expect(loadEntityVersionDocxBufferMock).not.toHaveBeenCalled();
  });

  test("saves a valid two-column DOCX named after both languages", async () => {
    const result = await createBilingualEntity.handler(createContext());

    expect(result).toMatchObject({
      fileName: "Smlouva (CS-EN).docx",
      rowCount: 4,
      warnings: [],
    });
    expect(createEntityFromBufferMock).toHaveBeenCalledTimes(1);
    const written = createEntityFromBufferMock.mock.calls.at(0)?.[0];
    if (!written) {
      throw new Error("createEntityFromBuffer was not called");
    }
    expect(written.mimeType).toBe(DOCX_MIME_TYPE);
    expect(written.fileName).toBe("Smlouva (CS-EN).docx");
    expect(await validateDocxBuffer(written.buffer)).toEqual({ valid: true });
    const tableRow = (await readBilingualDocx(written.buffer)).find(
      (row) => row.kind === "table",
    );
    expect(tableRow).toMatchObject({ kind: "table", layout: "stacked" });
    expect(scanFileMock.mock.calls.at(0)?.[0]).toMatchObject({
      declaredMimeType: DOCX_MIME_TYPE,
      fileName: "Smlouva (CS-EN).docx",
    });
    // Layout, DOCX validation, and the scan all succeeded, so nothing was
    // reported: this pins that the happy path is silent.
    expect(analytics.exceptions()).toEqual([]);
  });

  test("does not persist a document the security scan rejects", async () => {
    scanVerdict = "reject";
    const result = await createBilingualEntity.handler(createContext());

    expect(result).toEqual({
      code: 422,
      response: {
        message: "Bilingual document rejected: content does not match",
      },
    });
    expect(createEntityFromBufferMock).not.toHaveBeenCalled();
    // A scan verdict is an expected outcome the caller is told about; only a
    // scanner that fails to run is reported.
    expect(analytics.exceptions()).toEqual([]);
  });
});
