import { Result } from "better-result";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import JSZip from "jszip";

import type { Transaction } from "@/api/db/root";
import type { SafeDb } from "@/api/db/safe-db";
import { resolveToolWorkspaceIds } from "@/api/handlers/chat/tools/authorized-workspace-ids";
import { toSafeId, type SafeId } from "@/api/lib/branded-types";
import { DOCX_MIME_TYPE } from "@/api/mime-types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const organizationId = toSafeId<"organization">(
  "11111111-1111-4111-8111-111111111111",
);
const workspaceId = toSafeId<"workspace">(
  "22222222-2222-4222-8222-222222222222",
);
const entityId = "55555555-5555-4555-8555-555555555555";
const currentVersionId = toSafeId<"entityVersion">(
  "33333333-3333-4333-8333-333333333333",
);
const otherVersionId = "44444444-4444-4444-8444-444444444444";
const fileId = "66666666-6666-4666-8666-666666666666";

const toolWorkspaceIds = resolveToolWorkspaceIds({
  pinnedIds: [],
  accessibleWorkspaceIds: [workspaceId],
});

/** Minimal DOCX with a heading and a body paragraph, for markdown extraction. */
const makeDocxBytes = async (): Promise<Uint8Array> => {
  const zip = new JSZip();
  zip.file(
    "word/document.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>
  <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Agreement</w:t></w:r></w:p>
  <w:p><w:r><w:t>Jan Novak signs here.</w:t></w:r></w:p>
</w:body></w:document>`,
  );
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="xml" ContentType="application/xml"/>
</Types>`,
  );
  // Copy into a fresh ArrayBuffer-backed view so `.buffer` is an ArrayBuffer
  // (not ArrayBufferLike) for the S3 arrayBuffer mock's return type.
  return new Uint8Array(await zip.generateAsync({ type: "uint8array" }));
};

const arrayBufferMock = mock(async () => {
  const bytes = await makeDocxBytes();
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  );
});
const fileMock = mock(() => ({ arrayBuffer: arrayBufferMock }));

void mock.module("@/api/lib/s3", () => ({
  getS3: () => ({ file: fileMock }),
}));

const { createReadWorkspaceDocumentTools, READ_WORKSPACE_DOCUMENT_TOOL_NAME } =
  await import("./read-workspace-document-tools");

const mockDocxFieldContent = {
  version: 1,
  type: "file",
  id: fileId,
  fileName: "document.docx",
  mimeType: DOCX_MIME_TYPE,
  sizeBytes: 1,
  encrypted: true,
  sha256Hex: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  pdfFileId: null,
} as const;

type MockEntity = { currentVersionId: SafeId<"entityVersion"> | null };
type MockVersion = {
  workspaceId: typeof workspaceId;
  fields: { content: typeof mockDocxFieldContent }[];
};

const createSafeDb = ({
  entitiesById = {},
  versionsById = {},
}: {
  entitiesById?: Record<string, MockEntity | undefined>;
  versionsById?: Record<string, MockVersion | undefined>;
}): SafeDb => {
  const tx = {
    query: {
      entities: {
        findFirst: async ({ where }: { where: { id: { eq: string } } }) =>
          entitiesById[where.id.eq],
      },
      entityVersions: {
        findFirst: async ({ where }: { where: { id: { eq: string } } }) =>
          versionsById[where.id.eq],
      },
    },
  };
  return async (callback) =>
    // oxlint-disable-next-line node/callback-return -- result must be wrapped in Result.ok, not returned raw
    Result.ok(await callback(asTestRaw<Transaction>(tx)));
};

const getExecute = (safeDb: SafeDb) => {
  const tools = createReadWorkspaceDocumentTools({
    safeDb,
    organizationId,
    toolWorkspaceIds,
  });
  const tool = tools[READ_WORKSPACE_DOCUMENT_TOOL_NAME];
  const execute = tool.execute;
  if (!execute) {
    throw new Error("read_workspace_document must be server-executed");
  }
  return execute;
};

const runAndCaptureMessage = async (
  execute: ReturnType<typeof getExecute>,
  input: { entityId: string; versionId?: string },
) => {
  try {
    await execute(input, asTestRaw<Parameters<typeof execute>[1]>({}));
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("Expected read_workspace_document to reject");
};

describe("createReadWorkspaceDocumentTools", () => {
  beforeEach(() => {
    arrayBufferMock.mockClear();
    fileMock.mockClear();
  });

  test("registers a single server-executed read_workspace_document tool", () => {
    const tools = createReadWorkspaceDocumentTools({
      safeDb: createSafeDb({}),
      organizationId,
      toolWorkspaceIds,
    });
    expect(Object.keys(tools)).toEqual([READ_WORKSPACE_DOCUMENT_TOOL_NAME]);
    expect(
      tools[READ_WORKSPACE_DOCUMENT_TOOL_NAME].needsApproval,
    ).toBeUndefined();
    expect(tools[READ_WORKSPACE_DOCUMENT_TOOL_NAME].execute).toBeDefined();
  });

  test("reads the current version's DOCX as markdown when no versionId is given", async () => {
    const execute = getExecute(
      createSafeDb({
        entitiesById: { [entityId]: { currentVersionId } },
        versionsById: {
          [currentVersionId]: {
            workspaceId,
            fields: [{ content: mockDocxFieldContent }],
          },
        },
      }),
    );

    const result = await execute(
      { entityId },
      asTestRaw<Parameters<typeof execute>[1]>({}),
    );

    expect(result.markdown).toContain("Agreement");
    expect(result.markdown).toContain("Jan Novak signs here.");
  });

  test("reads an explicit version's DOCX as markdown, bypassing the entity lookup", async () => {
    const execute = getExecute(
      createSafeDb({
        // No entity row registered: an explicit versionId must never touch
        // `tx.query.entities`.
        versionsById: {
          [otherVersionId]: {
            workspaceId,
            fields: [{ content: mockDocxFieldContent }],
          },
        },
      }),
    );

    const result = await execute(
      { entityId, versionId: otherVersionId },
      asTestRaw<Parameters<typeof execute>[1]>({}),
    );

    expect(result.markdown).toContain("Agreement");
  });

  test("rejects a document not found in the caller's authorized workspaces", async () => {
    const message = await runAndCaptureMessage(
      getExecute(createSafeDb({ entitiesById: { [entityId]: undefined } })),
      { entityId },
    );
    expect(message).toMatch(/document was not found in your workspaces/iu);
  });

  test("rejects a document with no current version", async () => {
    const message = await runAndCaptureMessage(
      getExecute(
        createSafeDb({
          entitiesById: { [entityId]: { currentVersionId: null } },
        }),
      ),
      { entityId },
    );
    expect(message).toMatch(/no current version to read/iu);
  });

  test("rejects a version not found in the caller's authorized workspaces", async () => {
    const message = await runAndCaptureMessage(
      getExecute(
        createSafeDb({
          entitiesById: { [entityId]: { currentVersionId } },
          versionsById: { [currentVersionId]: undefined },
        }),
      ),
      { entityId },
    );
    expect(message).toMatch(
      /document version was not found in your workspaces/iu,
    );
  });

  test("rejects a version with no DOCX file", async () => {
    const message = await runAndCaptureMessage(
      getExecute(
        createSafeDb({
          entitiesById: { [entityId]: { currentVersionId } },
          versionsById: { [currentVersionId]: { workspaceId, fields: [] } },
        }),
      ),
      { entityId },
    );
    expect(message).toMatch(/does not contain a DOCX file/iu);
  });
});
