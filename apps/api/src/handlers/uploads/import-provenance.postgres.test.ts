import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { sha256Hex } from "@stll/sha256/node";

import { member, organization, user } from "@/api/db/auth-schema";
import {
  pendingUploads,
  properties,
  workspaceMembers,
  workspaces,
} from "@/api/db/schema";
import { createSafeDb, markRlsDatabase } from "@/api/db/scoped";
import readVersions from "@/api/handlers/entities/versions/list";
import { createSafeId } from "@/api/lib/branded-types";
import { UPLOAD_DOCUMENT_SOURCE } from "@/api/lib/document-source";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import { auditRecorderDouble } from "@/api/tests/helpers/audit-recorder-double";
import {
  mintAuthProviderId,
  mintAuthProviderIdValue,
} from "@/api/tests/helpers/auth-provider-id";
import { startFakeS3 } from "@/api/tests/helpers/fake-s3";
import {
  createTestHandlerContext,
  NO_DB,
} from "@/api/tests/helpers/handler-context";

import presignUpload from "./create";
import finalizeUpload from "./update";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

if (!databaseUrl || !runPostgresTests) {
  describe.skip("document upload import provenance (postgres)", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {
      expect(runPostgresTests && Boolean(databaseUrl)).toBe(false);
    });
  });
} else {
  test("preserves import provenance from presign through finalize and version history", async () => {
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const { db } = openClient();
      const fake = startFakeS3();
      const organizationId = mintAuthProviderId<"organization">();
      const userId = mintAuthProviderId<"user">();
      const workspaceId = createSafeId<"workspace">();
      const propertyId = createSafeId<"property">();
      const bytes = new TextEncoder().encode("Imported document content");
      const importOrigin = {
        source: "archive",
        id: "document-42",
        createdAt: "2001-02-03T04:05:06+02:00",
        modifiedAt: "2002-03-04T05:06:07-03:00",
        authorName: "Original Author",
      };
      const normalizedOrigin = {
        source: importOrigin.source,
        id: importOrigin.id,
        createdAt: "2001-02-03T02:05:06Z",
        modifiedAt: "2002-03-04T08:06:07Z",
        authorName: importOrigin.authorName,
      };
      expect(importOrigin.createdAt).not.toBe(normalizedOrigin.createdAt);
      expect(importOrigin.modifiedAt).not.toBe(normalizedOrigin.modifiedAt);

      try {
        await db.insert(organization).values({
          id: organizationId,
          name: "Import provenance test",
          slug: organizationId,
          createdAt: new Date(),
        });
        await db.insert(user).values({
          id: userId,
          name: "Uploading User",
          email: `${userId}@example.test`,
        });
        await db.insert(member).values({
          id: mintAuthProviderIdValue(),
          organizationId,
          userId,
          role: "owner",
          createdAt: new Date(),
        });
        await db.insert(workspaces).values({
          id: workspaceId,
          organizationId,
          name: "Import provenance matter",
          reference: "IMPORT",
        });
        await db.insert(workspaceMembers).values({
          id: createSafeId<"workspaceMember">(),
          workspaceId,
          userId,
        });
        await db.insert(properties).values({
          id: propertyId,
          workspaceId,
          name: "File",
          content: { type: "file", version: 1 },
          tool: { type: "manual-input", version: 1 },
          status: "fresh",
          system: true,
          kinds: ["document"],
        });

        const context = {
          safeDb: createSafeDb(
            markRlsDatabase(db),
            [workspaceId],
            organizationId,
            userId,
          ),
          scopedDb: NO_DB,
          audit: auditRecorderDouble(),
          workspaceId,
          session: { activeOrganizationId: organizationId },
          user: { id: userId },
        };
        const presigned = await presignUpload.handler(
          createTestHandlerContext<Parameters<typeof presignUpload.handler>[0]>(
            {
              ...context,
              body: {
                purpose: "entity_create",
                propertyId,
                name: "imported.txt",
                mimeType: "text/plain",
                size: bytes.byteLength,
                sha256Hex: sha256Hex(bytes),
                importOrigin,
              },
            },
          ),
        );
        if (!("uploadId" in presigned)) {
          throw new TypeError("Expected a presigned upload grant");
        }
        expect(
          await db.query.pendingUploads.findFirst({
            where: { id: { eq: presigned.uploadId } },
            columns: { purposeData: true },
          }),
        ).toMatchObject({
          purposeData: {
            type: "entity_create",
            propertyId,
            importSource: {
              kind: "import",
              externalSource: normalizedOrigin.source,
              externalId: normalizedOrigin.id,
              originalCreatedAt: normalizedOrigin.createdAt,
              originalModifiedAt: normalizedOrigin.modifiedAt,
              originalAuthorName: normalizedOrigin.authorName,
            },
          },
        });
        const staged = await fetch(presigned.url, {
          method: "PUT",
          body: bytes,
          headers: presigned.headers,
        });
        expect(staged.status).toBe(200);

        const finalized = await finalizeUpload.handler(
          createTestHandlerContext<
            Parameters<typeof finalizeUpload.handler>[0]
          >({
            ...context,
            params: { workspaceId, uploadId: presigned.uploadId },
          }),
        );
        if (!("finalizedResult" in finalized)) {
          throw new TypeError("Expected upload finalization to succeed");
        }
        expect(finalized.finalizedResult.type).toBe("entity_create");
        if (finalized.finalizedResult.type !== "entity_create") {
          throw new TypeError("Expected a newly created document");
        }
        const versions = await readVersions.handler(
          createTestHandlerContext<Parameters<typeof readVersions.handler>[0]>({
            ...context,
            params: {
              workspaceId,
              entityId: finalized.finalizedResult.entityId,
            },
            query: {},
          }),
        );
        if (!("versions" in versions)) {
          throw new TypeError("Expected document version history");
        }
        expect(versions.versions).toHaveLength(1);
        const version = versions.versions.at(0);
        expect(version?.sourceKind).toBe("import");
        expect(version?.sourceKind).not.toBe(UPLOAD_DOCUMENT_SOURCE.kind);
        expect(version?.importOrigin).toEqual(normalizedOrigin);
      } finally {
        try {
          await db
            .delete(pendingUploads)
            .where(eq(pendingUploads.workspaceId, workspaceId));
          await db
            .delete(organization)
            .where(eq(organization.id, organizationId));
          await db.delete(user).where(eq(user.id, userId));
        } finally {
          fake.stop();
        }
      }
    });
  }, 120_000);
}
