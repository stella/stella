import { PDF } from "@libpdf/core";
import { describe, expect, spyOn, test } from "bun:test";
import { eq } from "drizzle-orm";

import { createTestClock } from "@stll/test-kit";
import { createTestState } from "@stll/test-state";

import { rootDb } from "@/api/db/root";
import { bufferObjectCleanupIntents, fields } from "@/api/db/schema";
import { DERIVATIVE_FAILURE_REASON } from "@/api/db/schema-validators";
import { env } from "@/api/env";
import { envBase } from "@/api/env-base";
import { envConverter } from "@/api/env-converter";
import * as cleanup from "@/api/lib/buffer-intent-reconciliation";
import { createFileDerivativeProcessor } from "@/api/lib/file-derivative-queue";
import { allocateFileObject } from "@/api/lib/files/file-object-ids";
import { FILE_SIZE_LIMIT_BYTES, LIMITS } from "@/api/lib/limits";
import { createMemoryPressureGate } from "@/api/lib/memory-pressure";
import * as realtime from "@/api/lib/resource-realtime";
import * as extraction from "@/api/lib/search/process-extraction";
import { PDF_MIME_TYPE } from "@/api/mime-types";
import { startFakeS3 } from "@/api/tests/helpers/fake-s3";
import { legacyWordFile } from "@/api/tests/helpers/legacy-word-fixture";
import { storedDocumentConsumerFixture } from "@/api/tests/helpers/stored-document-consumer";

const state = createTestState({
  file: import.meta.path,
  config: FILE_SIZE_LIMIT_BYTES,
});
const converterState = state.forConfig(envConverter);
const deploymentState = state.forConfig(env);

// The small limit belongs only to this isolated database fixture. Production
// always uses the canonical stored-document limit, including for converted PDFs.
describe.skipIf(process.env["STELLA_RUN_POSTGRES_TESTS"] !== "true")(
  "stored PDF publication budget",
  () => {
    test.each(["below", "exact", "over"] as const)(
      "%s the document limit preserves the publication contract",
      async (boundary) => {
        const fixture = storedDocumentConsumerFixture();
        const store = startFakeS3();
        const pdf = PDF.create();
        pdf.addPage({ width: 612, height: 792 });
        const converted = await pdf.save();
        const originalDescriptor = Object.getOwnPropertyDescriptor(
          FILE_SIZE_LIMIT_BYTES,
          "document",
        );
        const originalLimit = FILE_SIZE_LIMIT_BYTES.document;
        const conversions: string[] = [];
        const converter = Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          fetch(request) {
            conversions.push(new URL(request.url).pathname);
            return new Response(converted, {
              headers: { "content-type": PDF_MIME_TYPE },
            });
          },
        });
        const reserve = spyOn(cleanup, "reserveObjectCleanupIntent");
        const broadcast = spyOn(
          realtime,
          "broadcastWorkspaceResourceUpdated",
        ).mockImplementation(() => undefined);
        const extract = spyOn(
          extraction,
          "processExtraction",
        ).mockResolvedValue(undefined);
        try {
          state.setConfig(
            "document",
            converted.byteLength + { below: 1, exact: 0, over: -1 }[boundary],
          );
          converterState.setConfig("GOTENBERG_URL", converter.url.toString());
          deploymentState.setConfig("FEATURE_FILE_USAGE_LIMITS", false);
          await fixture.seed();
          const document = await fixture.addDocument({
            fileName: "source.doc",
            mimeType: "application/msword",
          });
          store.put(
            envBase.S3_BUCKET,
            document.key,
            legacyWordFile(["ordinary text"]),
            "application/msword",
          );
          const clock = createTestClock();
          const delayed: number[] = [];
          const paused: unknown[] = [];
          const processor = createFileDerivativeProcessor({
            memory: createMemoryPressureGate({
              holdMs: 1000,
              now: clock.now,
              readRssBytes: () => 1,
              rssHighBytes: LIMITS.fileDerivativeSourceMaxBytes + 2,
            }),
            pausing: {
              closed: (reading) => {
                paused.push(reading);
              },
            },
            processThumbnail: async () => {
              expect.unreachable("PDF job must use the PDF processor");
            },
          });
          await processor({
            name: "generate-pdf",
            data: {
              derivativeFileId: allocateFileObject(),
              entityId: document.entityId,
              fieldId: document.fieldId,
              organizationId: fixture.organizationId,
              workspaceId: fixture.workspaceId,
              userId: fixture.userId,
            },
            moveToDelayed: async (timestamp) => {
              delayed.push(timestamp);
            },
          });
          expect(paused).toEqual([]);
          expect(delayed).toEqual([]);
          expect(
            store.requests
              .filter(({ method }) => method === "GET")
              .map(({ key }) => key),
          ).toEqual([document.key]);
          expect(conversions).toEqual(["/forms/libreoffice/convert"]);
          const [row] = await rootDb
            .select({ content: fields.content })
            .from(fields)
            .where(eq(fields.id, document.fieldId));
          expect(row?.content?.type).toBe("file");
          const refused = boundary === "over";
          expect(row?.content).toHaveProperty(
            "pdfDerivative",
            refused
              ? {
                  status: "failed",
                  reason: DERIVATIVE_FAILURE_REASON.TOO_LARGE,
                }
              : { status: "ready" },
          );
          if (refused) {
            expect(row?.content).toHaveProperty("pdfFileId", null);
          } else {
            expect(row?.content).toHaveProperty(
              "pdfFileId",
              expect.any(String),
            );
          }
          expect(reserve).toHaveBeenCalledTimes(refused ? 0 : 1);
          expect(
            store.requests.filter(({ method }) => method === "PUT"),
          ).toHaveLength(refused ? 0 : 1);
          expect(extract).toHaveBeenCalledTimes(refused ? 0 : 1);
          expect(
            await rootDb
              .select({ id: bufferObjectCleanupIntents.id })
              .from(bufferObjectCleanupIntents)
              .where(
                eq(
                  bufferObjectCleanupIntents.organizationId,
                  fixture.organizationId,
                ),
              ),
          ).toEqual([]);
        } finally {
          state.setConfig("document", originalLimit);
          expect(
            Object.getOwnPropertyDescriptor(FILE_SIZE_LIMIT_BYTES, "document"),
          ).toEqual(originalDescriptor);
          reserve.mockRestore();
          broadcast.mockRestore();
          extract.mockRestore();
          converter.stop(true);
          store.stop();
          await fixture.dispose();
        }
      },
    );
  },
);
