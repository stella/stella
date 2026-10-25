import { panic } from "better-result";
import { eq, inArray, sql } from "drizzle-orm";

import { member, organization, user } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import {
  entities,
  entityVersions,
  fields,
  properties,
  workspaceMembers,
  workspaces,
} from "@/api/db/schema";
import { createScopedDb, markRlsDatabase } from "@/api/db/scoped";
import type { RlsDatabase } from "@/api/db/scoped";
import { env } from "@/api/env";
import { readFileContentEndpoint } from "@/api/handlers/files/read-content";
import type { createReadFileContentEndpoint } from "@/api/handlers/files/read-content";
import { HttpStatusResponse } from "@/api/http/status";
import { createSafeId } from "@/api/lib/branded-types";
import { runWithMeasuredQueryCounter } from "@/api/lib/db-query-counter";
import { createFileKey } from "@/api/lib/file-key";
import {
  checkFileContentGrant,
  createFileContentGrant,
} from "@/api/lib/files/file-content-grant";
import { DOCX_MIME_TYPE } from "@/api/mime-types";
import type { GatedTestDb } from "@/api/tests/gated-test-database";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import type { startFakeS3 } from "@/api/tests/helpers/fake-s3";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

type FileContentMeasurementOptions = {
  size: number;
  db: GatedTestDb;
  storage: ReturnType<typeof startFakeS3>;
  createEndpoint: typeof createReadFileContentEndpoint;
};

const BUCKET = process.env["S3_BUCKET"] ?? "stella";
const NOW = Date.UTC(2026, 9, 25, 12);

export const fileContentScalingScenario = {
  name: "granted file content",
  definition: readFileContentEndpoint,
  measure: async ({
    size,
    db,
    storage,
    createEndpoint,
  }: FileContentMeasurementOptions) => {
    const organizationId = mintAuthProviderId<"organization">();
    const userId = mintAuthProviderId<"user">();
    const workspaceId = createSafeId<"workspace">();
    const propertyId = createSafeId<"property">();
    await db.insert(organization).values({
      id: organizationId,
      name: "File content scaling",
      slug: organizationId,
      createdAt: new Date(),
    });
    await db.insert(user).values({
      id: userId,
      name: "File content reader",
      email: `${userId}@example.test`,
    });
    try {
      await db.insert(member).values({
        id: Bun.randomUUIDv7(),
        organizationId,
        userId,
        role: "owner",
        createdAt: new Date(),
      });
      await db.insert(workspaces).values({
        id: workspaceId,
        organizationId,
        name: "File content matter",
        reference: workspaceId,
      });
      await db.insert(workspaceMembers).values({ workspaceId, userId });
      await db.insert(properties).values({
        id: propertyId,
        workspaceId,
        name: "File",
        content: { type: "file", version: 1 },
        tool: { type: "manual-input", version: 1 },
        status: "fresh",
      });
      // The matter's other files grow with `size`; the grant names one.
      const files = Array.from({ length: size }, () => ({
        entityId: createSafeId<"entity">(),
        entityVersionId: createSafeId<"entityVersion">(),
        fieldId: createSafeId<"field">(),
        fileId: Bun.randomUUIDv7(),
      }));
      await db.insert(entities).values(
        files.map(({ entityId }) => ({
          id: entityId,
          workspaceId,
          name: "Agreement",
          kind: "document" as const,
        })),
      );
      await db.insert(entityVersions).values(
        files.map(({ entityId, entityVersionId }) => ({
          id: entityVersionId,
          entityId,
          workspaceId,
        })),
      );
      await db
        .update(entities)
        .set({
          currentVersionId: sql`(SELECT v.id FROM public.entity_versions v WHERE v.entity_id = ${entities.id} LIMIT 1)`,
        })
        .where(
          inArray(
            entities.id,
            files.map(({ entityId }) => entityId),
          ),
        );
      const bytes = new TextEncoder().encode("granted file content");
      await db.insert(fields).values(
        files.map(({ entityVersionId, fieldId, fileId }) => ({
          id: fieldId,
          workspaceId,
          entityVersionId,
          propertyId,
          content: {
            version: 1 as const,
            type: "file" as const,
            id: fileId,
            fileName: "agreement.docx",
            mimeType: DOCX_MIME_TYPE,
            sizeBytes: bytes.byteLength,
            encrypted: false,
            sha256Hex: "a".repeat(64),
            pdfFileId: null,
          },
        })),
      );
      const granted = files.at(0) ?? panic("File content needs one file");
      storage.put(
        BUCKET,
        createFileKey({
          organizationId,
          workspaceId,
          fileId: granted.fileId,
          mimeType: DOCX_MIME_TYPE,
        }),
        bytes,
        DOCX_MIME_TYPE,
      );
      const database = asTestRaw<RlsDatabase<Transaction>>(markRlsDatabase(db));
      const endpoint = createEndpoint({
        database: {
          scoped: (scope) =>
            createScopedDb(
              database,
              scope.workspaceIds,
              scope.organizationId,
              scope.userId,
            ),
          tenantless: async (fn) =>
            await db.transaction(
              async (tx) => await fn(asTestRaw<Transaction>(tx)),
            ),
        },
        now: () => NOW,
      });
      const grant = createFileContentGrant({
        fieldId: granted.fieldId,
        now: NOW,
        organizationId,
        purpose: "download",
        secret: env.BETTER_AUTH_SECRET,
        userId,
        workspaceId,
      });
      // The route's caller check reads only the grant, never the database.
      const checked = checkFileContentGrant({
        grant,
        now: NOW,
        secret: env.BETTER_AUTH_SECRET,
      });
      if (checked.status !== "valid") {
        return panic("File content scaling requires a valid grant");
      }
      return await runWithMeasuredQueryCounter(async (counter) => {
        const response = await endpoint.handler(
          asTestRaw<Parameters<typeof endpoint.handler>[0]>({
            caller: checked.grant,
            params: { grant },
            request: new Request(
              `https://example.test/v1/file-content/${grant}`,
            ),
          }),
        );
        if (
          response instanceof HttpStatusResponse ||
          !(response instanceof Response) ||
          response.status !== 200
        ) {
          return panic("File content scaling requires the granted file");
        }
        const body = await response.arrayBuffer();
        return {
          statements: counter.count,
          transactionRoundTrips: counter.transactions,
          responseBytes: body.byteLength,
          rows: 1,
        };
      });
    } finally {
      await db.delete(organization).where(eq(organization.id, organizationId));
      await db.delete(user).where(eq(user.id, userId));
    }
  },
};
