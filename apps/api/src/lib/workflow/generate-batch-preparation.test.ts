import { PDF } from "@libpdf/core";
import { panic, Result } from "better-result";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { once } from "node:events";
import { createServer } from "node:http";

import type { ScopedDb } from "@/api/db/safe-db";
import type { FieldContent } from "@/api/db/schema-validators";
import { envBase } from "@/api/env-base";
import { toSafeId } from "@/api/lib/branded-types";
import { WorkflowIntegrationError } from "@/api/lib/errors/tagged-errors";
import { FILE_SIZE_LIMIT_BYTES } from "@/api/lib/limits";
import {
  configureS3ForTesting,
  isMissingCorpusObjectError,
  resetS3ForTesting,
} from "@/api/lib/s3";
import { generateWorkflowData } from "@/api/lib/workflow/ai-generate-batch";
import {
  fetchAndPrepareFiles,
  generateBatch,
} from "@/api/lib/workflow/generate-batch";
import type { GenerateBatchProps } from "@/api/lib/workflow/generate-batch-shared";
import type { AIBatchProperty } from "@/api/lib/workflow/get-execution-plan";
import { PDF_MIME_TYPE } from "@/api/mime-types";
import { startFakeS3 } from "@/api/tests/helpers/fake-s3";
import type { FakeS3 } from "@/api/tests/helpers/fake-s3";
import { testModelAdmission } from "@/api/tests/helpers/model-dispatch-admission";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const fileFieldId = toSafeId<"field">("field_file");
const propertyId = toSafeId<"property">("property_extract");

const fileContent = {
  version: 1,
  type: "file",
  id: "00000000-0000-4000-8000-000000000001",
  fileName: "contract.pdf",
  mimeType: "application/pdf",
  sizeBytes: 1024,
  encrypted: false,
  sha256Hex: "a".repeat(64),
  pdfFileId: null,
} as const satisfies FieldContent;

const dependencies = {
  fetchInputFieldsForBatch: async () => [
    { id: fileFieldId, propertyId, content: fileContent, aiSettlement: null },
  ],
  fetchAndPrepareFiles,
  generateWorkflowData,
};

// The object the PDF path reaches for: the input file's own id under the
// organization and workspace the batch runs in.
const inputObjectKey = `org_test/workspace_test/${fileContent.id}.pdf`;

const aiProperty = {
  id: propertyId,
  status: "stale",
  answerShape: "value",
  content: { version: 1, type: "text" },
  dependencies: [],
  tool: { version: 1, type: "ai-model", prompt: "Extract the parties." },
} as const satisfies AIBatchProperty;

const props = {
  abortSignal: new AbortController().signal,
  batch: { id: "batch_0", inputs: [propertyId], properties: [aiProperty] },
  entityVersionId: toSafeId<"entityVersion">("entity_version_test"),
  organizationId: toSafeId<"organization">("org_test"),
  admission: testModelAdmission(toSafeId<"organization">("org_test")),
  workspaceId: toSafeId<"workspace">("workspace_test"),
  scopedDb: asTestRaw<ScopedDb>(async () => {
    throw new Error("unexpected database access");
  }),
  orgAIConfig: null,
  managedAIResidency: "eu" as const,
  promptCachingEnabled: false,
  serviceTier: "standard",
} as const satisfies GenerateBatchProps;

describe("workflow batch input preparation", () => {
  let fake: FakeS3;

  beforeEach(() => {
    fake = startFakeS3();
  });

  afterEach(() => {
    fake.stop();
  });

  test("reports an unreadable input file as an integration failure instead of rejecting", async () => {
    // The rejection is bound to the key the preparation must ask for: a read
    // of any other key finds no object and fails as an absent object instead.
    fake.failNext({
      method: "GET",
      code: "AccessDenied",
      status: 403,
      key: inputObjectKey,
    });

    const result = await generateBatch(props, dependencies);

    expect(Result.isError(result)).toBe(true);
    if (!Result.isError(result)) {
      return;
    }

    // The declared error union is what the caller retries on and maps to a
    // gateway status; a rejection would bypass both.
    expect(WorkflowIntegrationError.is(result.error)).toBe(true);
    const cause = result.error.cause;
    // A denial is not an absence: the batch must not conclude the input file
    // is gone when the store merely refused the read.
    expect(isMissingCorpusObjectError(cause)).toBe(false);
    expect(cause instanceof Error ? cause.message : "").toBe(
      `Object read for ${inputObjectKey} failed with 403`,
    );
    expect(
      fake.requests
        .filter(({ method }) => method === "GET")
        .map(({ key }) => key),
    ).toEqual([inputObjectKey]);
  });
});

describe("an answer the batch request never returned", () => {
  const selectProperty = {
    ...aiProperty,
    id: toSafeId<"property">("property_select"),
    content: { version: 1, type: "single-select", options: [], fallback: null },
  } as const satisfies AIBatchProperty;

  const batchWithout = async (properties: readonly AIBatchProperty[]) =>
    await generateBatch(
      {
        ...props,
        batch: {
          id: "batch_0",
          inputs: [propertyId],
          properties: [...properties],
        },
      },
      {
        ...dependencies,
        fetchAndPrepareFiles: async () => [],
        // The request answered nothing for any property it was asked.
        generateWorkflowData: async () =>
          Result.ok({
            output: {},
            refusedPropertyIds: new Set(),
            properties: [...properties],
            fit: { type: "whole", files: [] },
          }),
      },
    );

  test("fails the batch instead of settling the property as not stated", async () => {
    const result = await batchWithout([aiProperty]);

    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(WorkflowIntegrationError.is(result.error)).toBe(true);
    }
  });

  test("still settles a select with no options, which is never asked, as not stated", async () => {
    const result = Result.unwrap(await batchWithout([selectProperty]));

    expect([...result.settlements]).toEqual([[selectProperty.id, "notStated"]]);
  });
});

const pdfSource = (source: "original" | "derived") => {
  const content = {
    ...fileContent,
    fileName: source === "original" ? "contract.pdf" : "contract.doc",
    mimeType: source === "original" ? PDF_MIME_TYPE : "application/msword",
    pdfFileId:
      source === "original" ? null : "00000000-0000-4000-8000-000000000002",
  } satisfies FieldContent;
  return {
    content,
    key: `org_test/workspace_test/${content.pdfFileId ?? content.id}.pdf`,
    resolved: {
      fileFieldId,
      fileId: content.id,
      mimeType: content.mimeType,
      sha256Hex: content.sha256Hex,
      encrypted: content.encrypted,
      pdfFileId: content.pdfFileId,
    },
  };
};

describe.each(["original", "derived"] as const)(
  "%s workflow PDF preparation",
  (source) => {
    test("loads and stamps a stored PDF while preserving its metadata", async () => {
      const fixture = pdfSource(source);
      const store = startFakeS3();
      try {
        const pdf = PDF.create();
        pdf.addPage({ width: 612, height: 792 });
        store.put(
          envBase.S3_BUCKET,
          fixture.key,
          await pdf.save(),
          PDF_MIME_TYPE,
        );
        const [prepared] = await fetchAndPrepareFiles(
          [fixture.resolved],
          props.organizationId,
          props.workspaceId,
        );
        expect(prepared).toMatchObject({
          kind: "pdf",
          fileFieldId,
          fileId: fixture.content.id,
          pageCount: 1,
          mimeType: PDF_MIME_TYPE,
          simplifiedName: "F0",
        });
        if (prepared?.kind !== "pdf") {
          expect.unreachable("Expected a prepared PDF");
        }
        const stamped = await PDF.load(prepared.content);
        expect(stamped.getPageCount()).toBe(1);
        expect(stamped.getPage(0)?.width).toBe(612);
        expect(stamped.getPage(0)?.height).toBe(792);
        expect(store.requests.map(({ method, key }) => [method, key])).toEqual([
          ["GET", fixture.key],
        ]);
      } finally {
        store.stop();
      }
    });

    test.each(["oversized", "undeclared"] as const)(
      "%s lengths preserve canonical and workflow failures before parsing",
      async (length) => {
        const fixture = pdfSource(source);
        const paths: string[] = [];
        // Node retains Content-Length on an unfinished response.
        const server = createServer((request, response) => {
          paths.push(new URL(request.url ?? "/", "http://127.0.0.1").pathname);
          response.writeHead(200, {
            "content-type": PDF_MIME_TYPE,
            ...(length === "oversized"
              ? { "content-length": String(FILE_SIZE_LIMIT_BYTES.document + 1) }
              : {}),
          });
          response.write(new Uint8Array([42]));
        }).listen(0, "127.0.0.1");
        try {
          await once(server, "listening");
          const address = server.address();
          if (address === null || typeof address === "string") {
            panic("Expected loopback TCP listener");
          }
          configureS3ForTesting({
            endpoint: `http://127.0.0.1:${address.port}`,
          });
          const failure = await fetchAndPrepareFiles(
            [fixture.resolved],
            props.organizationId,
            props.workspaceId,
          ).catch((error: unknown) => error);
          expect(failure).toHaveProperty(
            "_tag",
            length === "oversized"
              ? "S3ObjectBudgetError"
              : "S3ObjectReadError",
          );
          if (length === "oversized") {
            expect(failure).toHaveProperty("key", fixture.key);
            expect(failure).toHaveProperty(
              "maxBytes",
              FILE_SIZE_LIMIT_BYTES.document,
            );
            expect(failure).toHaveProperty(
              "declaredBytes",
              FILE_SIZE_LIMIT_BYTES.document + 1,
            );
          } else {
            expect(failure).toHaveProperty(
              "message",
              expect.stringContaining("declared no usable length"),
            );
          }
          const result = await generateBatch(props, {
            ...dependencies,
            fetchInputFieldsForBatch: async () => [
              {
                id: fileFieldId,
                propertyId,
                content: fixture.content,
                aiSettlement: null,
              },
            ],
          });
          expect(Result.isError(result)).toBe(true);
          if (!Result.isError(result)) {
            expect.unreachable("Expected integration failure");
          }
          expect(WorkflowIntegrationError.is(result.error)).toBe(true);
          expect(result.error.cause).toHaveProperty(
            "_tag",
            length === "oversized"
              ? "S3ObjectBudgetError"
              : "S3ObjectReadError",
          );
          expect(paths).toEqual([
            `/${envBase.S3_BUCKET}/${fixture.key}`,
            `/${envBase.S3_BUCKET}/${fixture.key}`,
          ]);
        } finally {
          resetS3ForTesting();
          server.closeAllConnections();
          await server[Symbol.asyncDispose]();
        }
      },
    );
  },
);
