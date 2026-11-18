import { PDF } from "@libpdf/core";
import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { once } from "node:events";
import { createServer } from "node:http";

import { rootDb } from "@/api/db/root";
import { fields, justifications, properties } from "@/api/db/schema";
import { envBase } from "@/api/env-base";
import { prepareJustificationData } from "@/api/lib/bbox/generate-b-boxes-shared";
import { createSafeId } from "@/api/lib/branded-types";
import type { FileKey } from "@/api/lib/file-key";
import { createFileKey } from "@/api/lib/files/utils";
import { FILE_SIZE_LIMIT_BYTES } from "@/api/lib/limits";
import { configureS3ForTesting, resetS3ForTesting } from "@/api/lib/s3";
import { PDF_MIME_TYPE } from "@/api/mime-types";
import { startFakeS3 } from "@/api/tests/helpers/fake-s3";
import { storedDocumentConsumerFixture } from "@/api/tests/helpers/stored-document-consumer";

const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const SOURCE_KINDS = ["original", "derived"] as const;

const withJustification = async (
  source: (typeof SOURCE_KINDS)[number],
  exercise: (state: {
    key: FileKey;
    prepare: () => ReturnType<typeof prepareJustificationData>;
  }) => Promise<void>,
): Promise<void> => {
  const fixture = storedDocumentConsumerFixture();
  try {
    await fixture.seed();
    const fileName = source === "original" ? "source.pdf" : "source.doc";
    const mimeType =
      source === "original" ? PDF_MIME_TYPE : "application/msword";
    const document = await fixture.addDocument({ fileName, mimeType });
    let key = document.key;
    if (source === "derived") {
      const pdfFileId = createSafeId<"userFile">();
      key = createFileKey({
        organizationId: fixture.organizationId,
        workspaceId: fixture.workspaceId,
        fileId: pdfFileId,
        mimeType: PDF_MIME_TYPE,
      });
      await rootDb
        .update(fields)
        .set({
          content: {
            version: 1,
            type: "file",
            id: document.fileId,
            fileName,
            mimeType,
            sizeBytes: 1,
            encrypted: false,
            sha256Hex: "a".repeat(64),
            pdfFileId,
            pdfDerivative: { status: "ready" },
          },
        })
        .where(eq(fields.id, document.fieldId));
    }
    const propertyId = createSafeId<"property">();
    const fieldId = createSafeId<"field">();
    const justificationId = createSafeId<"justification">();
    await rootDb.insert(properties).values({
      id: propertyId,
      workspaceId: fixture.workspaceId,
      name: "Extracted text",
      status: "fresh",
      content: { version: 1, type: "text" },
      tool: { version: 1, type: "ai-model", prompt: "Extract the cited text." },
    });
    await rootDb.insert(fields).values({
      id: fieldId,
      workspaceId: fixture.workspaceId,
      entityVersionId: document.entityVersionId,
      propertyId,
      content: { version: 1, type: "text", value: "Cited text" },
    });
    await rootDb.insert(justifications).values({
      id: justificationId,
      workspaceId: fixture.workspaceId,
      fieldId,
      fileFieldIds: [document.fieldId],
      content: {
        version: 1,
        blocks: [
          {
            kind: "pdf-bates",
            fileFieldId: document.fieldId,
            statements: [
              {
                text: "The document contains the cited text.",
                citations: [{ bates: "SOURCE-0001", pageNumber: 1 }],
              },
            ],
          },
        ],
      },
    });
    await exercise({
      key,
      prepare: async () =>
        await prepareJustificationData(
          fixture.organizationId,
          fixture.workspaceId,
          justificationId,
          fixture.scopedDb,
        ),
    });
  } finally {
    await fixture.dispose();
  }
};

describe.skipIf(!enabled).each(SOURCE_KINDS)(
  "%s bounding-box source reads",
  (source) => {
    test("loads a stored PDF and preserves the cited preparation data", async () => {
      await withJustification(source, async ({ key, prepare }) => {
        const store = startFakeS3();
        try {
          const document = PDF.create();
          document.addPage({ width: 612, height: 792 });
          store.put(
            envBase.S3_BUCKET,
            key,
            await document.save(),
            PDF_MIME_TYPE,
          );

          const result = await prepare();
          expect(Result.isOk(result)).toBe(true);
          if (Result.isOk(result)) {
            expect(result.value.prompt).toBe("Extract the cited text.");
            expect(result.value.fieldContent).toBe("Cited text");
            expect(result.value.justificationText).toBe(
              "The document contains the cited text.",
            );
            expect(result.value.pageNumbers).toEqual([1]);
            expect(result.value.pdf.getPage(0)?.width).toBe(612);
            expect(result.value.pdf.getPage(0)?.height).toBe(792);
            expect(result.value.pdf.getPageCount()).toBe(1);
          }
          expect(
            store.requests.map(({ method, key: requested }) => [
              method,
              requested,
            ]),
          ).toEqual([["GET", key]]);
        } finally {
          store.stop();
        }
      });
    });

    test.each(["oversized", "undeclared"] as const)(
      "%s lengths fail with the canonical read error before parsing the PDF",
      async (length) => {
        await withJustification(source, async ({ key, prepare }) => {
          const requests: { method: string | undefined; path: string }[] = [];
          // Node preserves Content-Length on an unfinished response; Bun replaces it.
          const server = createServer((request, response) => {
            requests.push({
              method: request.method,
              path: new URL(request.url ?? "/", "http://127.0.0.1").pathname,
            });
            response.writeHead(200, {
              "content-type": PDF_MIME_TYPE,
              ...(length === "oversized"
                ? {
                    "content-length": String(
                      FILE_SIZE_LIMIT_BYTES.document + 1,
                    ),
                  }
                : {}),
            });
            response.write(new Uint8Array([42]));
          }).listen(0, "127.0.0.1");
          try {
            await once(server, "listening");
            const address = server.address();
            if (address === null || typeof address === "string") {
              panic("Expected a loopback TCP listener");
            }
            configureS3ForTesting({
              endpoint: `http://127.0.0.1:${address.port}`,
            });
            const result = await Result.tryPromise({
              try: prepare,
              catch: (cause) => cause,
            });
            expect(Result.isError(result)).toBe(true);
            if (Result.isError(result)) {
              if (length === "oversized") {
                expect(result.error).toHaveProperty(
                  "cause._tag",
                  "S3ObjectBudgetError",
                );
                expect(result.error).toHaveProperty("cause.key", key);
                expect(result.error).toHaveProperty(
                  "cause.maxBytes",
                  FILE_SIZE_LIMIT_BYTES.document,
                );
                expect(result.error).toHaveProperty(
                  "cause.declaredBytes",
                  FILE_SIZE_LIMIT_BYTES.document + 1,
                );
              } else {
                expect(result.error).toHaveProperty(
                  "cause._tag",
                  "S3ObjectReadError",
                );
                expect(result.error).toHaveProperty(
                  "cause.message",
                  expect.stringContaining("declared no usable length"),
                );
              }
            }
            expect(requests).toEqual([
              { method: "GET", path: `/${envBase.S3_BUCKET}/${key}` },
            ]);
          } finally {
            resetS3ForTesting();
            server.closeAllConnections();
            await server[Symbol.asyncDispose]();
          }
        });
      },
    );
  },
);
