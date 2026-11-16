import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { waitForExternalState } from "@stll/property-testing/external-state";

import { organization } from "@/api/db/auth-schema";
import type { ScopedDb } from "@/api/db/safe-db";
import {
  entities,
  entityVersions,
  fields,
  properties,
  workspaces,
} from "@/api/db/schema";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import { readFileHandler } from "@/api/lib/files/read-file";
import { DOCX_MIME_TYPE, PDF_MIME_TYPE } from "@/api/mime-types";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { deleteOrganizationsForTest } from "@/api/tests/helpers/organization-deletion";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const databaseUrl = process.env["DATABASE_URL"];
const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const createdAt = new Date("2026-01-01T00:00:00.000Z");
const tombstonedAt = new Date("2026-02-01T00:00:00.000Z");

if (!databaseUrl || !enabled) {
  describe.skip("file link grant under the version lock (postgres)", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {});
  });
} else {
  test.each([
    { purpose: "download", mimeType: DOCX_MIME_TYPE },
    { purpose: "native-display", mimeType: DOCX_MIME_TYPE },
    { purpose: "display", mimeType: PDF_MIME_TYPE },
  ] as const)(
    "a version tombstone started while a $purpose link is signed waits for the signature",
    async ({ purpose, mimeType }) => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const observer = openClient();
        const { db } = observer;
        const reader = openClient().db;
        const writer = openClient({
          connection: { lock_timeout: 15_000, statement_timeout: 20_000 },
        });
        const organizationId = mintAuthProviderId<"organization">();
        const userId = mintAuthProviderId<"user">();
        const workspaceId = createSafeId<"workspace">();
        const entityId = createSafeId<"entity">();
        const versionId = createSafeId<"entityVersion">();
        const fieldId = createSafeId<"field">();
        const propertyId = createSafeId<"property">();
        try {
          await db.insert(organization).values({
            id: organizationId,
            name: "File link lock",
            slug: organizationId,
            createdAt,
          });
          await db.insert(workspaces).values({
            id: workspaceId,
            organizationId,
            name: "File link lock",
            reference: workspaceId,
          });
          await db.insert(entities).values({
            id: entityId,
            workspaceId,
            kind: "document",
            name: "File link lock",
          });
          await db
            .insert(entityVersions)
            .values({ id: versionId, entityId, workspaceId });
          await db.insert(properties).values({
            id: propertyId,
            workspaceId,
            name: "File",
            content: { type: "file", version: 1 },
            tool: { type: "manual-input", version: 1 },
            status: "fresh",
            kinds: ["document"],
          });
          await db.insert(fields).values({
            id: fieldId,
            propertyId,
            workspaceId,
            entityVersionId: versionId,
            content: {
              version: 1,
              type: "file",
              id: Bun.randomUUIDv7(),
              fileName: "rozsudek",
              mimeType,
              sizeBytes: 2048,
              encrypted: false,
              sha256Hex: "e".repeat(64),
              pdfFileId: null,
            },
          });
          const [writerSession] = await writer.sql<
            { pid: unknown }[]
          >`SELECT pg_backend_pid() AS pid`;
          const writerPid: unknown = writerSession?.pid;
          if (typeof writerPid !== "number") {
            throw new TypeError("Expected a PostgreSQL backend pid");
          }

          // The audit row is written where the link is signed. A tombstone
          // started there, in the version-delete order (entity row for update,
          // then the tombstone write), must wait for the signature: one that
          // commits first means the link outlives the withdrawal.
          let tombstone: Promise<void> | undefined;
          let tombstoneCommitted = false;
          // Whether the tombstone had committed when each audit row was written.
          const committedBeforeSignature: boolean[] = [];
          const recordAuditEvent: AuditRecorder = async () => {
            tombstone = writer.db.transaction(async (tx) => {
              await tx
                .select({ id: entities.id })
                .from(entities)
                .where(eq(entities.id, entityId))
                .for("update");
              await tx
                .update(entityVersions)
                .set({ deletedAt: tombstonedAt })
                .where(eq(entityVersions.id, versionId));
            });
            tombstone = tombstone.then(() => {
              tombstoneCommitted = true;
              return undefined;
            });
            await waitForExternalState({
              description: "the tombstone commits or waits on a lock",
              timeoutMs: 10_000,
              read: async () => {
                if (tombstoneCommitted) {
                  return true;
                }
                const [row] = await observer.sql<{ blocked: unknown }[]>`
                  SELECT cardinality(pg_blocking_pids(${writerPid}::int)) > 0 AS blocked`;
                return row?.blocked === true;
              },
            });
            committedBeforeSignature.push(tombstoneCommitted);
          };

          const answer = await readFileHandler({
            fieldId,
            organizationId,
            purpose,
            readSessionAuthority: async () => null,
            recordAuditEvent,
            scopedDb: asTestRaw<ScopedDb>(
              async (fn: Parameters<ScopedDb>[0]) =>
                await reader.transaction(fn),
            ),
            source: { kind: "request", sessionId: "fixture-session" },
            userId,
            workspaceId,
          });
          await tombstone;

          expect(answer).toHaveProperty("presignedUrl");
          expect(committedBeforeSignature).toEqual([false]);
          const [version] = await db
            .select({ deletedAt: entityVersions.deletedAt })
            .from(entityVersions)
            .where(eq(entityVersions.id, versionId));
          expect(version?.deletedAt).toBeInstanceOf(Date);
        } finally {
          await deleteOrganizationsForTest(db, [organizationId]);
        }
      });
    },
  );
}
