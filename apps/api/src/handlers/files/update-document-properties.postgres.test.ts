import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { DOCUMENT_PROPERTIES_MAX_BYTES } from "@stll/api-contract";
import { ZipArchive } from "@stll/docx-core/zip";
import { rejectionOf } from "@stll/property-testing/rejection";
import { withFakeTimers } from "@stll/test-kit";

import { rootDb } from "@/api/db/root";
import { auditLogs, entities, entityVersions, fields } from "@/api/db/schema";
import { envBase } from "@/api/env-base";
import { HttpStatusResponse } from "@/api/http/status";
import { createFileKey } from "@/api/lib/files/utils";
import { S3ObjectBudgetError } from "@/api/lib/s3";
import { DOCX_MIME_TYPE } from "@/api/mime-types";
import { startFakeS3 } from "@/api/tests/helpers/fake-s3";
import {
  responseByteFile,
  responseByteStream,
} from "@/api/tests/helpers/response-byte-stream";
import { storedDocumentConsumerFixture } from "@/api/tests/helpers/stored-document-consumer";

import { updateDocumentProperties } from "./update-document-properties";

const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

describe.skipIf(!enabled)("document property writes bound source reads", () => {
  let fixture: ReturnType<typeof storedDocumentConsumerFixture>;
  beforeEach(async () => {
    fixture = storedDocumentConsumerFixture();
    await fixture.seed();
  });
  afterEach(async () => await fixture.dispose());

  test.each([
    "oversized",
    "undeclared",
    "invalid-archive",
    "deadline",
  ] as const)(
    "%s source leaves the current version and audit trail unchanged",
    async (fault) => {
      const source = await fixture.addDocument({
        fileName: "document.docx",
        mimeType: DOCX_MIME_TYPE,
      });
      using bodyFile = responseByteFile(DOCUMENT_PROPERTIES_MAX_BYTES + 1);
      const store = startFakeS3({
        readResponse: ({ object, headers }) => {
          if (fault === "oversized") {
            return new Response(bodyFile.body, {
              headers: {
                ...headers,
                "content-length": String(DOCUMENT_PROPERTIES_MAX_BYTES + 1),
              },
            });
          }
          if (fault === "undeclared") {
            const undeclared = new Headers(headers);
            undeclared.delete("content-length");
            return new Response(
              responseByteStream(DOCUMENT_PROPERTIES_MAX_BYTES + 1).body,
              { headers: undeclared },
            );
          }
          return new Response(object.bytes, { headers });
        },
      });
      store.put(
        envBase.S3_BUCKET,
        source.key,
        "not an archive",
        DOCX_MIME_TYPE,
      );
      const hold =
        fault === "deadline"
          ? store.holdNext({ method: "GET", keyIncludes: source.key })
          : null;
      const input = {
        fieldId: source.fieldId,
        organizationId: fixture.organizationId,
        workspaceId: fixture.workspaceId,
        userId: fixture.userId,
        safeDb: fixture.safeDb,
        scopedDb: fixture.scopedDb,
        recordAuditEvent: fixture.recordAuditEvent,
        values: { title: "Revised title" },
      };
      try {
        if (fault === "invalid-archive") {
          const response = await updateDocumentProperties(input);
          expect(response).toBeInstanceOf(HttpStatusResponse);
          if (response instanceof HttpStatusResponse) {
            expect(response.code).toBe(422);
          }
        } else if (hold !== null) {
          await withFakeTimers(async (timers) => {
            const failure = rejectionOf(updateDocumentProperties(input));
            await hold.reached;
            await timers.advance(30_000);
            expect(await failure).toMatchObject({
              _tag: "TimeoutError",
              timeoutMs: 30_000,
            });
          });
        } else {
          const error = await rejectionOf(updateDocumentProperties(input));
          if (fault === "oversized") {
            expect(error).toBeInstanceOf(S3ObjectBudgetError);
          } else {
            expect(error).toMatchObject({
              _tag: "S3ObjectReadError",
              message: expect.stringContaining("declared no usable length"),
            });
          }
        }
        expect(
          await rootDb
            .select({ currentVersionId: entities.currentVersionId })
            .from(entities)
            .where(eq(entities.id, source.entityId)),
        ).toEqual([{ currentVersionId: source.entityVersionId }]);
        expect(
          await rootDb
            .select({ id: entityVersions.id })
            .from(entityVersions)
            .where(eq(entityVersions.entityId, source.entityId)),
        ).toEqual([{ id: source.entityVersionId }]);
        expect(store.requests.filter(({ method }) => method === "PUT")).toEqual(
          [],
        );
        expect(
          await rootDb
            .select()
            .from(auditLogs)
            .where(eq(auditLogs.organizationId, fixture.organizationId)),
        ).toEqual([]);
      } finally {
        hold?.release();
        store.stop();
      }
    },
  );

  test("a bounded OOXML source still publishes the authored properties as a new audited version", async () => {
    const source = await fixture.addDocument({
      fileName: "document.docx",
      mimeType: DOCX_MIME_TYPE,
    });
    const zip = new ZipArchive();
    zip.set(
      "[Content_Types].xml",
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    );
    zip.set(
      "word/document.xml",
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Agreement</w:t></w:r></w:p></w:body></w:document>',
    );
    zip.set(
      "docProps/core.xml",
      '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Original title</dc:title></cp:coreProperties>',
    );
    const original = new Uint8Array(await zip.generate());
    const store = startFakeS3();
    store.put(envBase.S3_BUCKET, source.key, original, DOCX_MIME_TYPE);
    try {
      const result = await updateDocumentProperties({
        fieldId: source.fieldId,
        organizationId: fixture.organizationId,
        workspaceId: fixture.workspaceId,
        userId: fixture.userId,
        safeDb: fixture.safeDb,
        scopedDb: fixture.scopedDb,
        recordAuditEvent: fixture.recordAuditEvent,
        values: { title: "Revised title" },
      });
      expect(result).not.toBeInstanceOf(HttpStatusResponse);
      if (result instanceof HttpStatusResponse) {
        throw new TypeError(`Unexpected status ${result.code}`);
      }
      expect(result.entityVersionId).not.toBe(source.entityVersionId);
      expect(
        await rootDb
          .select({ currentVersionId: entities.currentVersionId })
          .from(entities)
          .where(eq(entities.id, source.entityId)),
      ).toEqual([{ currentVersionId: result.entityVersionId }]);
      const [stored] = await rootDb
        .select({ content: fields.content })
        .from(fields)
        .where(eq(fields.id, result.fieldId));
      if (stored?.content.type !== "file") {
        throw new Error("Missing published file");
      }
      const key = createFileKey({
        organizationId: fixture.organizationId,
        workspaceId: fixture.workspaceId,
        fileId: stored.content.id,
        mimeType: DOCX_MIME_TYPE,
      });
      const published = store.objects.get(`${envBase.S3_BUCKET}/${key}`);
      if (published === undefined) {
        throw new Error("Missing stored version");
      }
      const revised = await ZipArchive.read(published.bytes);
      expect(await revised.entry("docProps/core.xml")?.text()).toContain(
        "Revised title",
      );
      expect(
        store.objects.get(`${envBase.S3_BUCKET}/${source.key}`)?.bytes,
      ).toEqual(original);
      expect(
        (
          await rootDb
            .select()
            .from(auditLogs)
            .where(eq(auditLogs.organizationId, fixture.organizationId))
        ).length,
      ).toBeGreaterThan(0);
    } finally {
      store.stop();
    }
  });
});
