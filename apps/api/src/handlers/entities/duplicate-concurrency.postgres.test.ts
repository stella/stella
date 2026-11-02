/**
 * Two duplications into one matter take the matter's update lock when they
 * lock their copy publication, before entity-cap admission needs it. The
 * second waits for the first instead of both holding a share lock and then
 * deadlocking on the upgrade.
 */

import { panic } from "better-result";
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { eq, sql } from "drizzle-orm";

import { member, organization, user } from "@/api/db/auth-schema";
import {
  entities,
  entityVersions,
  fields,
  properties,
  workspaceMembers,
  workspaces,
} from "@/api/db/schema";
import { createSafeDb, markRlsDatabase } from "@/api/db/scoped";
import { envDocumentProcessingWorker } from "@/api/env-document-processing-worker";
import { createAuditRecorder } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import { createFileKey } from "@/api/lib/file-key";
import {
  lockCopyPublicationIntentsInTransaction,
  retirePublishedCopyIntentsInTransaction,
} from "@/api/lib/files/copy-organization-files";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { enqueueEntitySearchRepairs } from "@/api/lib/search/projection-repair-queue";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { startFakeS3 } from "@/api/tests/helpers/fake-s3";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { waitForBlockedPid } from "@/api/tests/helpers/wait-for-blocked-pid";

import { createDuplicateEntity } from "./duplicate";

// timeout: two PostgreSQL sessions duplicate into one matter through a lock barrier.
setDefaultTimeout(60_000);

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests =
  process.env["STELLA_RUN_POSTGRES_TESTS"] === "true" &&
  databaseUrl !== undefined;
const BUCKET = process.env["S3_BUCKET"] ?? "stella";
const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const pidColumns = { pid: sql<number>`pg_backend_pid()` };
const identity = sql`(SELECT 1) AS backend_identity`;
const backendPid = (rows: { pid: number }[]) =>
  rows.at(0)?.pid ?? panic("Backend identity missing");

describe.skipIf(!runPostgresTests)("concurrent duplication", () => {
  test("two duplications into one matter serialize and both succeed", async () => {
    await withGatedTestClients(
      databaseUrl ?? panic("DATABASE_URL required"),
      async ({ openClient }) => {
        const setup = openClient({ max: 1 });
        const observer = openClient().sql;
        const workers = [openClient({ max: 1 }), openClient({ max: 1 })];
        const storage = startFakeS3();
        const priorLimits =
          envDocumentProcessingWorker.FEATURE_FILE_USAGE_LIMITS;
        envDocumentProcessingWorker.FEATURE_FILE_USAGE_LIMITS = false;
        const organizationId = mintAuthProviderId<"organization">();
        const userId = mintAuthProviderId<"user">();
        const workspaceId = createSafeId<"workspace">();
        const entityId = createSafeId<"entity">();
        const versionId = createSafeId<"entityVersion">();
        const propertyId = createSafeId<"property">();
        const fileId = Bun.randomUUIDv7();
        try {
          await setup.db.insert(organization).values({
            id: organizationId,
            name: "Concurrent duplication",
            slug: organizationId,
            createdAt: new Date(),
          });
          await setup.db.insert(user).values({
            id: userId,
            name: "Duplicating member",
            email: `${userId}@example.test`,
          });
          await setup.db.insert(member).values({
            id: Bun.randomUUIDv7(),
            organizationId,
            userId,
            role: "owner",
            createdAt: new Date(),
          });
          await setup.db.insert(workspaces).values({
            id: workspaceId,
            organizationId,
            name: "Concurrent duplication matter",
            reference: workspaceId,
          });
          await setup.db
            .insert(workspaceMembers)
            .values({ workspaceId, userId });
          await setup.db.insert(entities).values({
            id: entityId,
            workspaceId,
            name: "Agreement",
            kind: "document",
          });
          await setup.db
            .insert(entityVersions)
            .values({ id: versionId, entityId, workspaceId, versionNumber: 1 });
          await setup.db
            .update(entities)
            .set({ currentVersionId: versionId })
            .where(eq(entities.id, entityId));
          await setup.db.insert(properties).values({
            id: propertyId,
            workspaceId,
            name: "File",
            content: { type: "file", version: 1 },
            tool: { type: "manual-input", version: 1 },
            status: "fresh",
            system: true,
            kinds: ["document"],
          });
          const bytes = new TextEncoder().encode("agreement bytes");
          await setup.db.insert(fields).values({
            id: createSafeId<"field">(),
            workspaceId,
            entityVersionId: versionId,
            propertyId,
            content: {
              type: "file",
              version: 1,
              id: fileId,
              fileName: "Agreement.docx",
              mimeType: DOCX_MIME,
              sizeBytes: bytes.byteLength,
              encrypted: false,
              sha256Hex: "a".repeat(64),
              pdfFileId: null,
            },
          });
          storage.put(
            BUCKET,
            createFileKey({
              organizationId,
              workspaceId,
              fileId,
              mimeType: DOCX_MIME,
            }),
            bytes,
            DOCX_MIME,
          );

          const pids = await Promise.all(
            workers.map(async ({ db }) =>
              backendPid(await db.select(pidColumns).from(identity)),
            ),
          );
          const locked = [
            Promise.withResolvers<undefined>(),
            Promise.withResolvers<undefined>(),
          ];
          // Each duplication locks its publication for real, then waits until
          // the other has locked too or is observed waiting on it. A share
          // lock lets both through, and both then deadlock upgrading it.
          const duplicate = async (index: 0 | 1) => {
            const other = index === 0 ? 1 : 0;
            const endpoint = createDuplicateEntity({
              enqueueDocumentProcessingRun: async () => undefined,
              enqueueEntitySearchRepairs,
              fileUsageDb: setup.db,
              flushEntitySearchRepairs: async () => ({
                failed: 0,
                repaired: 0,
              }),
              lockCopyPublicationIntentsInTransaction: async (options) => {
                const result =
                  await lockCopyPublicationIntentsInTransaction(options);
                locked[index]?.resolve(undefined);
                const otherPid = pids.at(other) ?? panic("Worker pid missing");
                const myPid = pids.at(index) ?? panic("Worker pid missing");
                await Promise.race([
                  locked[other]?.promise,
                  waitForBlockedPid(observer, {
                    waitingPid: otherPid,
                    holdingPid: myPid,
                  }).then(
                    () => undefined,
                    () => undefined,
                  ),
                ]);
                return result;
              },
              requestNativeExtractionRuns: async () => [],
              retirePublishedCopyIntentsInTransaction,
            });
            const bindings = {
              organizationId,
              workspaceId,
              userId,
              request: new Request(
                "https://example.test/v1/entities/duplicate",
              ),
              server: null,
            };
            return endpoint.handler(
              asTestRaw<Parameters<typeof endpoint.handler>[0]>({
                workspaceId,
                user: { id: userId },
                session: { activeOrganizationId: organizationId },
                memberRole: sessionMemberRole("owner"),
                body: { entityId, name: `Agreement copy ${index}` },
                request: bindings.request,
                route: "/v1/entities/:workspaceId/duplicate",
                safeDb: createSafeDb(
                  markRlsDatabase(
                    (workers[index] ?? panic("Worker missing")).db,
                  ),
                  [workspaceId],
                  organizationId,
                  userId,
                ),
                recordAuditEvent: createAuditRecorder(bindings),
                createAuditRecorder: () => createAuditRecorder(bindings),
              }),
            );
          };

          const outcomes = await Promise.all([duplicate(0), duplicate(1)]);

          // Both succeed; a deadlock victim would return a refusal here.
          for (const outcome of outcomes) {
            expect(outcome).toMatchObject({ entityId: expect.any(String) });
          }
          expect(
            await setup.db.$count(
              entities,
              eq(entities.workspaceId, workspaceId),
            ),
          ).toBe(3);
        } finally {
          envDocumentProcessingWorker.FEATURE_FILE_USAGE_LIMITS = priorLimits;
          storage.stop();
          await setup.db
            .delete(organization)
            .where(eq(organization.id, organizationId));
          await setup.db.delete(user).where(eq(user.id, userId));
        }
      },
    );
  });
});
