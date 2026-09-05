import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { docxToMarkdown } from "@stll/folio-core/server";

import {
  documentCounters,
  entities,
  entityVersions,
  fields,
  pendingUploads,
} from "@/api/db/schema";
import { envBase } from "@/api/env-base";
import {
  CREATE_MATTER_DOCUMENT_TOOL_NAME,
  createCreateWorkspaceDocumentTools,
} from "@/api/handlers/chat/tools/create-workspace-document-tools";
import { toSafeId } from "@/api/lib/branded-types";
import { createChatRefRegistry } from "@/api/lib/chat/ref-registry";
import { createEntityFromBuffer } from "@/api/lib/entities/create-from-buffer";
import type { CreateEntityFromBufferDependencies } from "@/api/lib/entities/create-from-buffer";
import { DOCX_MIME_TYPE } from "@/api/mime-types";
import { startFakeS3 } from "@/api/tests/helpers/fake-s3";
import type { FakeS3 } from "@/api/tests/helpers/fake-s3";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

const processExtractionMock = mock(async () => {});
const enqueueImageThumbnailOrMarkFailedMock = mock(async () => {});
const enqueuePdfDerivativeOrMarkFailedMock = mock(async () => {});

const createEntityDependencies = {
  broadcastWorkspaceResourceUpdated: () => undefined,
  enqueueImageThumbnailOrMarkFailed: enqueueImageThumbnailOrMarkFailedMock,
  enqueuePdfDerivativeOrMarkFailed: enqueuePdfDerivativeOrMarkFailedMock,
  processExtraction: processExtractionMock,
  requestNativeExtractionRun: mock(async () => null),
} satisfies CreateEntityFromBufferDependencies;

const createEntityForTest: typeof createEntityFromBuffer = async (input) =>
  await createEntityFromBuffer({
    ...input,
    dependencies: createEntityDependencies,
  });

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

  test("registers a single server-executed create_matter_document tool", () => {
    const { tx } = buildTx();
    const { scopedDb } = createScopedDbMock(tx);
    const tools = createCreateWorkspaceDocumentTools({
      scopedDb,
      organizationId,
      userId,
      workspaceId,
      recordAuditEvent: async () => undefined,
      refRegistry: createChatRefRegistry(),
      createEntityFromBuffer: createEntityForTest,
    });

    expect(Object.keys(tools)).toEqual([CREATE_MATTER_DOCUMENT_TOOL_NAME]);
    const tool = tools[CREATE_MATTER_DOCUMENT_TOOL_NAME];
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
      createEntityFromBuffer: createEntityForTest,
    });
    const execute = tools[CREATE_MATTER_DOCUMENT_TOOL_NAME].execute;
    if (!execute) {
      throw new Error("create_matter_document must be server-executed");
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
      createEntityFromBuffer: createEntityForTest,
    });
    const execute = tools[CREATE_MATTER_DOCUMENT_TOOL_NAME].execute;
    if (!execute) {
      throw new Error("create_matter_document must be server-executed");
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
