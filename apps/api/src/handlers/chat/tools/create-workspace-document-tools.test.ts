import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { docxToMarkdown, inspectDocxPackage } from "@stll/folio-core/server";

import {
  documentCounters,
  entities,
  entityVersions,
  fields,
  pendingUploads,
} from "@/api/db/schema";
import { envBase } from "@/api/env-base";
import { toSafeId } from "@/api/lib/branded-types";
import { createChatRefRegistry } from "@/api/lib/chat/ref-registry";
import { DOCX_MIME_TYPE } from "@/api/mime-types";
import { startFakeS3 } from "@/api/tests/helpers/fake-s3";
import type { FakeS3 } from "@/api/tests/helpers/fake-s3";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

const processExtractionMock = mock(async () => {});
const enqueueImageThumbnailOrMarkFailedMock = mock(async () => {});
const enqueuePdfDerivativeOrMarkFailedMock = mock(async () => {});

void mock.module("@/api/lib/search/process-extraction", () => ({
  processExtraction: processExtractionMock,
  requestNativeExtractionRun: mock(async () => null),
}));

const realFileDerivativeQueue = await import("@/api/lib/file-derivative-queue");
void mock.module("@/api/lib/file-derivative-queue", () => ({
  ...realFileDerivativeQueue,
  enqueueImageThumbnailOrMarkFailed: enqueueImageThumbnailOrMarkFailedMock,
  enqueuePdfDerivativeOrMarkFailed: enqueuePdfDerivativeOrMarkFailedMock,
}));

const {
  CREATE_WORKSPACE_DOCUMENT_TOOL_NAME,
  createCreateWorkspaceDocumentTools,
  markdownToStellaDocx,
} = await import("./create-workspace-document-tools");

const organizationId = toSafeId<"organization">(
  "00000000-0000-0000-0000-000000000001",
);
const workspaceId = toSafeId<"workspace">(
  "00000000-0000-0000-0000-000000000002",
);
const userId = toSafeId<"user">("00000000-0000-0000-0000-000000000003");
const propertyId = toSafeId<"property">("00000000-0000-0000-0000-000000000004");

const bucket = envBase.S3_BUCKET;
let fake: FakeS3;

const markdown = `# Title Heading

Some **bold** paragraph text.

## Section Two

- one
- two

1. first
2. second
`;

describe("markdownToStellaDocx", () => {
  test("renders markdown content into a valid, Stella-styled DOCX", async () => {
    const bytes = await markdownToStellaDocx(markdown);
    expect(bytes.byteLength).toBeGreaterThan(0);

    // Content survives the round trip.
    const roundTripped = await docxToMarkdown(bytes);
    expect(roundTripped).toContain("# Title Heading");
    expect(roundTripped).toContain("## Section Two");
    expect(roundTripped).toContain("Some **bold** paragraph text.");
    expect(roundTripped).toContain("- one");
    expect(roundTripped).toContain("- two");
    expect(roundTripped).toContain("1. first");
    expect(roundTripped).toContain("2. second");

    // Stella's style set (not the default createEmptyDocument() one) was
    // applied: Stella's A4 page geometry and its "BodyText" style (absent
    // from the plain default style catalog) are both present.
    const inspection = await inspectDocxPackage(bytes, {
      xmlParts: ["word/document.xml", "word/styles.xml", "word/numbering.xml"],
    });
    const documentXml = inspection.xmlParts.find(
      (part) => part.path === "word/document.xml",
    );
    const stylesXml = inspection.xmlParts.find(
      (part) => part.path === "word/styles.xml",
    );
    const numberingXml = inspection.xmlParts.find(
      (part) => part.path === "word/numbering.xml",
    );
    const pageSizeTag = documentXml?.text.match(/<w:pgSz\b[^>]*\/>/u)?.[0];
    expect(pageSizeTag).toContain('w:w="11906"');
    expect(pageSizeTag).toContain('w:h="16838"');
    expect(pageSizeTag).toContain('w:orient="portrait"');
    expect(stylesXml?.text).toContain('w:styleId="BodyText"');

    // Stella's own reserved numId 1-5 definitions are untouched (still
    // present) — the markdown lists were appended after them, not merged
    // into or overwriting them.
    for (const numId of [1, 2, 3, 4, 5]) {
      expect(numberingXml?.text).toContain(`<w:num w:numId="${numId}">`);
    }
    // Two markdown-originated lists (one bullet, one ordered) were appended
    // as fresh `w:num` instances above the reserved range.
    expect(numberingXml?.text).toContain('<w:num w:numId="6">');
    expect(numberingXml?.text).toContain('<w:num w:numId="7">');
    expect(numberingXml?.text).not.toContain('<w:num w:numId="8">');
    // A round trip is the real proof the fix works: before the numId remap,
    // this same markdown rendered as Stella's clause/definitions numbering
    // ("(a) first" / "(b) second") because the markdown list numIds
    // collided with Stella's reserved 1-5 range — asserted above via the
    // plain "- one" / "1. first" content checks.
  });

  test("is a no-op on numbering when the markdown has no lists", async () => {
    const bytes = await markdownToStellaDocx("# Just a heading\n\nAnd text.");
    const inspection = await inspectDocxPackage(bytes, {
      xmlParts: ["word/numbering.xml"],
    });
    const numberingXml = inspection.xmlParts.find(
      (part) => part.path === "word/numbering.xml",
    );
    // Stella's own abstractNum / num definitions, nothing appended.
    expect(numberingXml?.text).not.toContain('w:numId="6"');
  });
});

describe("createCreateWorkspaceDocumentTools", () => {
  beforeEach(() => {
    fake = startFakeS3();
  });

  afterEach(() => {
    fake.stop();
  });

  const buildTx = () => {
    let insertedFileName: string | undefined;
    const tx = {
      query: {
        properties: {
          findMany: async () => [
            { id: propertyId, content: { type: "file" as const } },
          ],
        },
        workspaces: {
          findFirst: async () => ({ reference: null }),
        },
      },
      $count: async () => 0,
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => ({ for: async () => [{ status: "active" }] }),
          }),
        }),
      }),
      insert: (table: unknown) => ({
        values: (values: { id?: string; name?: string }) => {
          if (table === documentCounters) {
            return {
              onConflictDoUpdate: () => ({
                returning: async () => [{ lastValue: 1 }],
              }),
            };
          }
          if (table === pendingUploads) {
            return { returning: async () => [{ id: values.id }] };
          }
          if (table === entities) {
            insertedFileName = values.name;
          }
          if (
            table === entities ||
            table === entityVersions ||
            table === fields
          ) {
            return undefined;
          }
          return undefined;
        },
      }),
      update: (table: unknown) => ({
        set: () => ({
          where: () =>
            table === pendingUploads
              ? { returning: async () => [{ id: "intent_1" }] }
              : undefined,
        }),
      }),
    };
    return { tx, getInsertedFileName: () => insertedFileName };
  };

  test("registers a single server-executed create_workspace_document tool", () => {
    const { tx } = buildTx();
    const { scopedDb } = createScopedDbMock(tx);
    const tools = createCreateWorkspaceDocumentTools({
      scopedDb,
      organizationId,
      userId,
      workspaceId,
      recordAuditEvent: async () => undefined,
      refRegistry: createChatRefRegistry(),
    });

    expect(Object.keys(tools)).toEqual([CREATE_WORKSPACE_DOCUMENT_TOOL_NAME]);
    const tool = tools[CREATE_WORKSPACE_DOCUMENT_TOOL_NAME];
    expect(tool.needsApproval).toBeUndefined();
    expect(tool.execute).toBeDefined();
  });

  test("creates the entity from the rendered DOCX and returns a ref-mediated mention", async () => {
    const { tx, getInsertedFileName } = buildTx();
    const { scopedDb } = createScopedDbMock(tx);
    const recordedAuditEvents: unknown[] = [];
    const tools = createCreateWorkspaceDocumentTools({
      scopedDb,
      organizationId,
      userId,
      workspaceId,
      recordAuditEvent: async (_tx, event) => {
        recordedAuditEvents.push(event);
      },
      refRegistry: createChatRefRegistry(),
    });
    const execute = tools[CREATE_WORKSPACE_DOCUMENT_TOOL_NAME].execute;
    if (!execute) {
      throw new Error("create_workspace_document must be server-executed");
    }

    const result = await execute(
      { title: "Loan Agreement", markdown },
      asTestRaw<Parameters<typeof execute>[1]>({}),
    );

    expect(getInsertedFileName()).toBe("Loan Agreement.docx");
    // Exactly one object landed, tenant-scoped and typed as a DOCX, and it is
    // the rendered document rather than an empty placeholder.
    expect(fake.requests.map(({ method }) => method)).toEqual(["PUT"]);
    const [storedKey = "", stored] = [...fake.objects.entries()].at(0) ?? [];
    expect(storedKey).toStartWith(
      `${bucket}/${organizationId}/${workspaceId}/`,
    );
    expect(storedKey).toEndWith(".docx");
    expect(stored?.contentType).toBe(DOCX_MIME_TYPE);
    expect(await docxToMarkdown(stored?.bytes ?? new Uint8Array())).toContain(
      "# Title Heading",
    );
    expect(recordedAuditEvents).toHaveLength(1);
    expect(result).toEqual({
      success: true,
      fileName: "Loan Agreement.docx",
      entityRef: "ent_1",
      matterRef: "mat_1",
      href: "#stella-entity-ref=ent_1",
      mention: "[Loan Agreement.docx](#stella-entity-ref=ent_1)",
    });
  });

  test("raises a chat tool error when the matter has no file property", async () => {
    const tx = {
      query: { properties: { findMany: async () => [] } },
      $count: async () => 0,
    };
    const { scopedDb } = createScopedDbMock(tx);
    const tools = createCreateWorkspaceDocumentTools({
      scopedDb,
      organizationId,
      userId,
      workspaceId,
      recordAuditEvent: async () => undefined,
      refRegistry: createChatRefRegistry(),
    });
    const execute = tools[CREATE_WORKSPACE_DOCUMENT_TOOL_NAME].execute;
    if (!execute) {
      throw new Error("create_workspace_document must be server-executed");
    }

    // bun-types declares `.rejects.toThrow` as void, so awaiting it trips
    // type-aware lint; capture the rejection explicitly instead.
    const rejection = await Promise.resolve(
      execute(
        { title: "Loan Agreement", markdown },
        asTestRaw<Parameters<typeof execute>[1]>({}),
      ),
    ).then(
      () => null,
      (error: unknown) => error,
    );
    expect(rejection).toBeInstanceOf(Error);
    expect(rejection instanceof Error ? rejection.message : "").toMatch(
      /missing a file property/iu,
    );
  });
});
