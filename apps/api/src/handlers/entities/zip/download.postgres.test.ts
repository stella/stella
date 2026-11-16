import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { ZipArchive } from "@stll/docx-core/zip";
import { deferred, withFakeTimers } from "@stll/test-kit";

import { rootDb } from "@/api/db/root";
import { auditLogs } from "@/api/db/schema";
import { FILE_SIZE_LIMIT_BYTES } from "@/api/lib/limits";
import { PDF_MIME_TYPE } from "@/api/mime-types";
import { startFakeS3 } from "@/api/tests/helpers/fake-s3";
import { createTestHandlerContext } from "@/api/tests/helpers/handler-context";
import { installRecordingAnalytics } from "@/api/tests/helpers/recording-telemetry";
import { responseByteStream } from "@/api/tests/helpers/response-byte-stream";
import { storedDocumentConsumerFixture } from "@/api/tests/helpers/stored-document-consumer";
import { createTestFetch } from "@/api/tests/helpers/test-fetch";

import downloadZip from "./download";

const testFetch = createTestFetch();
const originalFetch = globalThis.fetch;
const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

describe.skipIf(!enabled)("folder downloads bound each stored body", () => {
  let fixture: ReturnType<typeof storedDocumentConsumerFixture>;
  beforeEach(async () => {
    fixture = storedDocumentConsumerFixture();
    await fixture.seed();
  });
  afterEach(async () => await fixture.dispose());

  test.each([
    "overflow",
    "broken-stream",
    "http-error",
    "http-error-cancel-rejected",
    "trickling-deadline",
    "caller-abort",
  ] as const)(
    "%s keeps successful neighbors, archive order, and the audited error manifest",
    async (fault) => {
      const documents = await Promise.all(
        ["a-valid.pdf", "b-failed.pdf", "c-valid.pdf"].map(
          async (fileName) => ({
            fileName,
            ...(await fixture.addDocument({
              fileName: `${fault}-${fileName}`,
              mimeType: PDF_MIME_TYPE,
            })),
          }),
        ),
      );
      const store = startFakeS3();
      const analytics = installRecordingAnalytics();
      const bodyStarted =
        deferred<ReadableStreamDefaultController<Uint8Array>>();
      const overflow = responseByteStream(
        FILE_SIZE_LIMIT_BYTES.document + 1024 * 1024,
      );
      const requestAbort = new AbortController();
      let bodyCancelled = false;
      let refusalBodyPulls = 0;
      const refusalBytes = new TextEncoder().encode("storage refused");
      const requested: string[] = [];
      testFetch.set(
        Object.assign(
          async (input: string | URL | Request) => {
            const url = new URL(
              input instanceof Request ? input.url : String(input),
            );
            expect(url.origin).toBe(store.endpoint);
            const document = documents.find(({ key }) =>
              decodeURIComponent(url.pathname).endsWith(key),
            );
            if (document === undefined) {
              return new Response("missing", { status: 404 });
            }
            requested.push(document.fileName);
            if (document.fileName !== "b-failed.pdf") {
              return new Response(document.fileName);
            }
            switch (fault) {
              case "overflow":
                return new Response(overflow.body);
              case "http-error":
              case "http-error-cancel-rejected":
                expect(refusalBytes.byteLength).toBeGreaterThan(0);
                return new Response(
                  new ReadableStream<Uint8Array>(
                    {
                      start(controller) {
                        controller.enqueue(refusalBytes);
                      },
                      pull() {
                        refusalBodyPulls += 1;
                      },
                      async cancel() {
                        bodyCancelled = true;
                        if (fault === "http-error-cancel-rejected") {
                          await Promise.reject(
                            new Error("Cancellation rejected"),
                          );
                        }
                      },
                    },
                    { highWaterMark: 0 },
                  ),
                  { status: 403 },
                );
              case "broken-stream":
                return new Response(
                  new ReadableStream({
                    start(controller) {
                      controller.error(new Error("Stored transfer broke"));
                    },
                  }),
                );
              case "trickling-deadline":
              case "caller-abort":
                return new Response(
                  new ReadableStream<Uint8Array>({
                    start(controller) {
                      controller.enqueue(new Uint8Array([1]));
                    },
                    pull(controller) {
                      bodyStarted.resolve(controller);
                    },
                    cancel() {
                      bodyCancelled = true;
                    },
                  }),
                );
              default:
                fault satisfies never;
                return new Response(null, { status: 500 });
            }
          },
          { preconnect: originalFetch.preconnect },
        ),
      );
      try {
        const archiveBytes = await withFakeTimers(async (timers) => {
          const response = await downloadZip.handler(
            createTestHandlerContext<Parameters<typeof downloadZip.handler>[0]>(
              {
                safeDb: fixture.safeDb,
                scopedDb: fixture.scopedDb,
                audit: fixture.recordAuditEvent,
                workspaceId: fixture.workspaceId,
                session: { activeOrganizationId: fixture.organizationId },
                params: { entityId: fixture.folderId },
                request: new Request("https://example.test/folder.zip", {
                  signal: requestAbort.signal,
                }),
              },
            ),
          );
          expect(response).toBeInstanceOf(Response);
          if (!(response instanceof Response)) {
            throw new TypeError("Expected archive response");
          }
          expect(response.status).toBe(200);
          const consumed = response.arrayBuffer();
          if (fault === "trickling-deadline" || fault === "caller-abort") {
            const controller = await bodyStarted.promise;
            if (fault === "caller-abort") {
              await timers.advance(1);
              requestAbort.abort(new Error("Download caller left"));
              await timers.advance(1);
            } else {
              await timers.advance(20_000);
              controller.enqueue(new Uint8Array([2]));
              await timers.advance(10_000);
            }
            // End a mutant that ignored cancellation; its entry and missing
            // cancellation then fail the owner assertions rather than hanging.
            if (!bodyCancelled) {
              controller.close();
            }
          }
          return await consumed;
        });
        // Only the small valid neighbors and the error manifest belong here.
        expect(archiveBytes.byteLength).toBeLessThan(
          FILE_SIZE_LIMIT_BYTES.document,
        );
        const zip = await ZipArchive.read(archiveBytes);
        const prefix = `Documents/${fault}-`;
        expect(zip.paths()).toEqual([
          `${prefix}a-valid.pdf`,
          `${prefix}c-valid.pdf`,
          "Documents/_DOWNLOAD ERRORS.txt",
        ]);
        expect(await zip.entry(`${prefix}a-valid.pdf`)?.text()).toBe(
          "a-valid.pdf",
        );
        expect(await zip.entry(`${prefix}c-valid.pdf`)?.text()).toBe(
          "c-valid.pdf",
        );
        expect(
          await zip.entry("Documents/_DOWNLOAD ERRORS.txt")?.text(),
        ).toContain(`${prefix}b-failed.pdf`);
        expect(requested.toSorted()).toEqual([
          "a-valid.pdf",
          "b-failed.pdf",
          "c-valid.pdf",
        ]);
        const events = await rootDb
          .select()
          .from(auditLogs)
          .where(eq(auditLogs.organizationId, fixture.organizationId));
        expect(events).toHaveLength(1);
        expect(events.at(0)).toMatchObject({
          resourceId: fixture.folderId,
          metadata: { archiveType: "zip" },
        });
        expect(analytics.exceptions()).toHaveLength(1);
        if (fault === "overflow") {
          expect(overflow.wasCancelled()).toBe(true);
        }
        if (fault === "trickling-deadline" || fault === "caller-abort") {
          expect(bodyCancelled).toBe(true);
        }
        if (fault === "http-error" || fault === "http-error-cancel-rejected") {
          expect(bodyCancelled).toBe(true);
          expect(refusalBodyPulls).toBe(0);
        }
      } finally {
        analytics.restore();
        store.stop();
      }
    },
  );
});
