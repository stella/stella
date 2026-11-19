import { describe, expect, test } from "bun:test";

import { DOCUMENT_PROPERTIES_MAX_BYTES } from "@stll/api-contract";
import { rejectionOf } from "@stll/property-testing/rejection";

import type { ScopedDb } from "@/api/db/safe-db";
import { envBase } from "@/api/env-base";
import { toSafeId } from "@/api/lib/branded-types";
import { createFileKey } from "@/api/lib/files/utils";
import { S3ObjectBudgetError } from "@/api/lib/s3";
import { DOCX_MIME_TYPE } from "@/api/mime-types";
import { startFakeS3 } from "@/api/tests/helpers/fake-s3";
import {
  responseByteFile,
  responseByteStream,
} from "@/api/tests/helpers/response-byte-stream";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

import { readDocumentProperties } from "./document-properties";

const organizationId = toSafeId<"organization">("org_properties_budget");
const workspaceId = toSafeId<"workspace">("ws_properties_budget");
const fieldId = toSafeId<"field">("field_properties_budget");
const entityId = toSafeId<"entity">("entity_properties_budget");
const fileId = "file_properties_budget";

describe("document properties enforce the storage body limit", () => {
  test.each(["oversized", "undeclared-oversized"] as const)(
    "refuses a %s object despite small file metadata, without auditing delivery",
    async (kind) => {
      const key = createFileKey({
        organizationId,
        workspaceId,
        fileId,
        mimeType: DOCX_MIME_TYPE,
      });
      const byteLength = DOCUMENT_PROPERTIES_MAX_BYTES + 1;
      using bodyFile = responseByteFile(byteLength);
      const store = startFakeS3({
        readResponse: ({ headers }) => {
          const responseHeaders = new Headers(headers);
          if (kind === "undeclared-oversized") {
            responseHeaders.delete("content-length");
          } else {
            responseHeaders.set("content-length", String(byteLength));
          }
          return new Response(
            kind === "undeclared-oversized"
              ? responseByteStream(byteLength).body
              : bodyFile.body,
            {
              headers: responseHeaders,
            },
          );
        },
      });
      store.put(envBase.S3_BUCKET, key, new Uint8Array(1), DOCX_MIME_TYPE);
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
          },
        ];
      });
      try {
        const read = readDocumentProperties({
          canUpdateEntity: false,
          fieldId,
          organizationId,
          recordAuditEvent: async () => {
            auditCalls += 1;
          },
          scopedDb,
          workspaceId,
        });
        if (kind === "oversized") {
          expect(await rejectionOf(read)).toBeInstanceOf(S3ObjectBudgetError);
        } else {
          expect(await rejectionOf(read)).toMatchObject({
            _tag: "S3ObjectReadError",
            message: expect.stringContaining("declared no usable length"),
          });
        }
        expect(
          store.requests.filter(({ method }) => method === "GET"),
        ).toHaveLength(1);
        expect(databaseReads).toBe(1);
        expect(auditCalls).toBe(0);
      } finally {
        store.stop();
      }
    },
  );
});
