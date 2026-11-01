import { PDF } from "@libpdf/core";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { member, organization, user } from "@/api/db/auth-schema";
import {
  auditLogs,
  entities,
  entityVersions,
  fields,
  legalReaderAnnotations,
  properties,
  workspaces,
} from "@/api/db/schema";
import { createSafeDb, createScopedDb, markRlsDatabase } from "@/api/db/scoped";
import { envBase } from "@/api/env-base";
import { markedDownloadEndpoint } from "@/api/handlers/files/routes";
import { AUDIT_ACTION, createAuditRecorder } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import { createFileKey } from "@/api/lib/files/utils";
import { FILE_SIZE_LIMIT_BYTES } from "@/api/lib/limits";
import { PDF_MIME_TYPE } from "@/api/mime-types";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { startFakeS3 } from "@/api/tests/helpers/fake-s3";
import { createTestHandlerContext } from "@/api/tests/helpers/handler-context";
import {
  getTestDb,
  releaseTestDb,
  type TestDatabase,
} from "@/api/tests/security/test-utils";

let db: TestDatabase;
beforeAll(async () => {
  db = await getTestDb();
});
afterAll(releaseTestDb);

test.each(["above the marking limit", "encrypted", "unreadable"] as const)(
  "the default PDF download streams the stored original when %s",
  async (unavailable) => {
    const fake = startFakeS3();
    try {
      const organizationId = mintAuthProviderId<"organization">();
      const userId = mintAuthProviderId<"user">();
      const workspaceId = createSafeId<"workspace">();
      const entityId = createSafeId<"entity">();
      const versionId = createSafeId<"entityVersion">();
      const propertyId = createSafeId<"property">();
      const fieldId = createSafeId<"field">();
      const fileId = Bun.randomUUIDv7();
      const pdf = PDF.create();
      pdf
        .addPage({ size: "letter" })
        .drawText("The agreement", { x: 72, y: 700, size: 12 });
      // PDF whitespace preserves a valid file while crossing the real ceiling.
      const valid = await pdf.save();
      let stored = valid;
      switch (unavailable) {
        case "above the marking limit":
          stored = new Uint8Array(FILE_SIZE_LIMIT_BYTES.document + 1).fill(
            0x20,
          );
          stored.set(valid);
          expect(stored.byteLength).toBeGreaterThan(
            FILE_SIZE_LIMIT_BYTES.document,
          );
          break;
        case "unreadable":
          stored = new TextEncoder().encode("Stored document bytes");
          break;
        case "encrypted":
          break;
        default:
          unavailable satisfies never;
      }
      fake.put(
        envBase.S3_BUCKET,
        createFileKey({
          organizationId,
          workspaceId,
          fileId,
          mimeType: PDF_MIME_TYPE,
        }),
        stored,
        PDF_MIME_TYPE,
      );
      await db.insert(organization).values({
        id: organizationId,
        name: "Download firm",
        slug: organizationId,
        createdAt: new Date(),
      });
      await db.insert(user).values({
        id: userId,
        name: "Reader",
        email: `${userId}@example.test`,
      });
      await db.insert(member).values({
        id: Bun.randomUUIDv7(),
        userId,
        organizationId,
        role: "owner",
        createdAt: new Date(),
      });
      await db.insert(workspaces).values({
        id: workspaceId,
        organizationId,
        name: "Document matter",
        reference: workspaceId,
      });
      await db
        .insert(entities)
        .values({ id: entityId, workspaceId, name: "Agreement" });
      await db
        .insert(entityVersions)
        .values({ id: versionId, entityId, workspaceId });
      await db.insert(properties).values({
        id: propertyId,
        workspaceId,
        name: "File",
        status: "fresh",
        content: { version: 1, type: "file" },
        tool: { version: 1, type: "manual-input" },
      });
      await db.insert(fields).values({
        id: fieldId,
        workspaceId,
        entityVersionId: versionId,
        propertyId,
        content: {
          version: 1,
          type: "file",
          id: fileId,
          fileName: "Agreement.pdf",
          mimeType: PDF_MIME_TYPE,
          sizeBytes: stored.byteLength,
          encrypted: unavailable === "encrypted",
          sha256Hex: "b".repeat(64),
          pdfFileId: null,
        },
      });
      await db.insert(legalReaderAnnotations).values({
        id: createSafeId<"legalReaderAnnotation">(),
        organizationId,
        userId,
        targetType: "matter-document",
        targetId: fieldId,
        workspaceId,
        entityId,
        pageTextSha256: "b".repeat(64),
        kind: "highlight",
        color: "yellow",
        style: "highlight",
        blockAnchorId: "page-1",
        startOffset: 4,
        endOffset: 13,
        quote: "agreement",
      });
      const request = new Request(
        "https://example.test/files/marked?mode=highlights",
      );
      const response = await markedDownloadEndpoint.handler(
        createTestHandlerContext<
          Parameters<typeof markedDownloadEndpoint.handler>[0]
        >({
          workspaceId,
          session: { activeOrganizationId: organizationId },
          user: { id: userId, email: `${userId}@example.test` },
          safeDb: createSafeDb(db, [workspaceId], organizationId, userId),
          scopedDb: createScopedDb(
            markRlsDatabase(db),
            [workspaceId],
            organizationId,
            userId,
          ),
          audit: createAuditRecorder({
            organizationId,
            workspaceId,
            userId,
            request,
            server: null,
          }),
          request,
          params: { workspaceId, fieldId },
          query: { mode: "highlights" },
        }),
      );
      expect(response).toBeInstanceOf(Response);
      if (!(response instanceof Response)) {
        throw new Error("Expected the PDF response");
      }
      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe(PDF_MIME_TYPE);
      expect(response.headers.get("Content-Length")).toBe(
        String(stored.byteLength),
      );
      expect(response.headers.get("Content-Disposition")).toContain(
        "attachment",
      );
      const downloaded = new Uint8Array(await response.arrayBuffer());
      expect(downloaded.byteLength).toBe(stored.byteLength);
      expect(Buffer.compare(downloaded, stored)).toBe(0);
      expect(
        fake.requests.filter(({ method }) => method === "GET"),
      ).toHaveLength(unavailable === "unreadable" ? 2 : 1);
      const events = await db
        .select()
        .from(auditLogs)
        .where(eq(auditLogs.resourceId, entityId));
      expect(events).toHaveLength(1);
      expect(events.at(0)).toMatchObject({
        action: AUDIT_ACTION.DOWNLOAD,
        metadata: { fieldId, annotations: 0, markExport: "highlights" },
      });
    } finally {
      fake.stop();
    }
  },
);
