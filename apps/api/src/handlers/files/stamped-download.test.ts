import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { DOCUMENT_PROPERTIES_MAX_BYTES } from "@stll/api-contract";
import { BodyByteLimitError } from "@stll/fetch/body-reader";
import { rejectionOf } from "@stll/property-testing/rejection";

import type { ScopedDb } from "@/api/db/safe-db";
import { envBase } from "@/api/env-base";
import { HttpStatusResponse } from "@/api/http/status";
import type { AuditEvent, AuditRecorder } from "@/api/lib/audit-log";
import { toSafeId } from "@/api/lib/branded-types";
import { createFileKey } from "@/api/lib/files/utils";
import { FILE_SIZE_LIMIT_BYTES } from "@/api/lib/limits";
import { DOCX_MIME_TYPE } from "@/api/mime-types";
import { startFakeS3 } from "@/api/tests/helpers/fake-s3";
import type { FakeS3 } from "@/api/tests/helpers/fake-s3";
import {
  installRecordingAnalytics,
  installRecordingLogger,
} from "@/api/tests/helpers/recording-telemetry";
import type {
  RecordingAnalytics,
  RecordingLogger,
} from "@/api/tests/helpers/recording-telemetry";
import { responseByteStream } from "@/api/tests/helpers/response-byte-stream";
import { createTestFetch } from "@/api/tests/helpers/test-fetch";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

import { stampedDownloadHandler } from "./get";

const organizationId = toSafeId<"organization">("org_stamped_download");
const workspaceId = toSafeId<"workspace">("ws_stamped_download");
const fieldId = toSafeId<"field">("field_stamped_download");
const entityId = toSafeId<"entity">("entity_stamped_download");
const fileId = "file_stamped_download";

const testFetch = createTestFetch();
const originalFetch = globalThis.fetch;

let fake: FakeS3;

beforeEach(() => {
  fake = startFakeS3();
});

let analytics: RecordingAnalytics | null = null;
let logs: RecordingLogger | null = null;

afterEach(() => {
  fake.stop();
  analytics?.restore();
  logs?.restore();
  analytics = null;
  logs = null;
});

describe("stamped DOCX download", () => {
  test("returns 422 without auditing a download when the stored document is not a readable archive", async () => {
    const stored = new TextEncoder().encode("not a zip archive");
    fake.put(
      envBase.S3_BUCKET,
      createFileKey({
        organizationId,
        workspaceId,
        fileId,
        mimeType: DOCX_MIME_TYPE,
      }),
      stored,
      DOCX_MIME_TYPE,
    );

    let scopedDbCall = 0;
    const scopedDb = asTestRaw<ScopedDb>(
      async (callback: (tx: object) => Promise<unknown>) => {
        scopedDbCall += 1;
        if (scopedDbCall === 1) {
          return [
            {
              content: {
                type: "file",
                id: fileId,
                fileName: "smlouva.docx",
                mimeType: DOCX_MIME_TYPE,
                sizeBytes: stored.byteLength,
                encrypted: false,
              },
              entityId,
              versionStamp: "DOC-1",
              verificationCode: "ABCD-EFGH",
            },
          ];
        }
        return await callback({});
      },
    );
    const events: AuditEvent[] = [];
    const recordAuditEvent: AuditRecorder = async (_tx, event) => {
      if (Array.isArray(event)) {
        events.push(...event);
      } else {
        events.push(event);
      }
    };

    analytics = installRecordingAnalytics();
    logs = installRecordingLogger();
    const response = await stampedDownloadHandler({
      fieldId,
      metadata: "keep",
      organizationId,
      recordAuditEvent,
      scopedDb,
      workspaceId,
    });

    // The stored bytes were read: the request reached the stamp step.
    expect(fake.requests.some(({ method }) => method === "GET")).toBe(true);
    expect(response).toBeInstanceOf(HttpStatusResponse);
    if (response instanceof HttpStatusResponse) {
      expect(response.code).toBe(422);
    }
    expect(events).toEqual([]);
    // The unreadable archive is the stored upload's own condition: a warning
    // without an exception capture.
    expect(logs.at("WARN").map(({ message }) => message)).toContain(
      "files.stamped_download_unreadable",
    );
    expect(logs.at("ERROR")).toEqual([]);
    expect(analytics.exceptions()).toEqual([]);
  });
});

describe("stamped downloads bound the received body", () => {
  test.each([
    ["keep", "overflow"],
    ["strip", "overflow"],
    ["keep", "broken-stream"],
  ] as const)(
    "refuses %s metadata body on %s without stamping or auditing delivery",
    async (metadata, fault) => {
      const maxBytes =
        metadata === "strip"
          ? DOCUMENT_PROPERTIES_MAX_BYTES
          : FILE_SIZE_LIMIT_BYTES.document;
      const streamFailure = new Error("Stored object transfer broke");
      // Keep unread bytes after the overflow so cancellation has a live source.
      const stream = responseByteStream(maxBytes * 2);
      let requested = 0;
      testFetch.set(
        Object.assign(
          async (input: string | URL | Request) => {
            const url = input instanceof Request ? input.url : String(input);
            expect(url.startsWith(fake.endpoint)).toBe(true);
            requested += 1;
            return new Response(
              fault === "overflow"
                ? stream.body
                : new ReadableStream({
                    start(controller) {
                      controller.error(streamFailure);
                    },
                  }),
            );
          },
          { preconnect: originalFetch.preconnect },
        ),
      );
      let databaseReads = 0;
      let auditCalls = 0;
      const scopedDb = asTestRaw<ScopedDb>(async () => {
        databaseReads += 1;
        return [
          {
            content: {
              type: "file",
              id: fileId,
              fileName: "document.docx",
              mimeType: DOCX_MIME_TYPE,
              sizeBytes: 1,
              encrypted: false,
            },
            entityId,
            versionStamp: "DOC-1",
            verificationCode: "ABCD-EFGH",
          },
        ];
      });
      const download = stampedDownloadHandler({
        fieldId,
        metadata,
        organizationId,
        recordAuditEvent: async () => {
          auditCalls += 1;
        },
        scopedDb,
        workspaceId,
      });
      if (fault === "overflow") {
        expect(await rejectionOf(download)).toBeInstanceOf(BodyByteLimitError);
        expect(stream.wasCancelled()).toBe(true);
      } else {
        expect(await rejectionOf(download)).toBe(streamFailure);
      }
      expect(requested).toBe(1);
      expect(databaseReads).toBe(1);
      expect(auditCalls).toBe(0);
    },
  );
});
