import { panic, Result } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";

import { member, organization, user } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import type { SafeDb } from "@/api/db/safe-db";
import {
  bufferObjectCleanupIntents,
  desktopEditSessions,
  entities,
  entityVersions,
  organizationFileObjects,
  organizationFileUsage,
  properties,
  workspaces,
} from "@/api/db/schema";
import { envDocumentProcessingWorker } from "@/api/env-document-processing-worker";
import { createSafeId } from "@/api/lib/branded-types";
import { reconcileBufferObjectCleanupIntents } from "@/api/lib/buffer-intent-reconciliation";
import { desktopEditMimeTypeForFileType } from "@/api/lib/desktop-edit-file-types";
import { hashDesktopEditSessionToken } from "@/api/lib/desktop-edit-sessions";
import {
  OrganizationFileUsageError,
  removeOrganizationFileBytes,
} from "@/api/lib/files/organization-file-usage";
import { createFileKey } from "@/api/lib/files/utils";
import { logger } from "@/api/lib/observability/logger";
import type { SchedulerTaskContext } from "@/api/lib/scheduler/types";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import {
  mintAuthProviderId,
  mintAuthProviderIdValue,
} from "@/api/tests/helpers/auth-provider-id";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { waitForBlockedPid } from "@/api/tests/helpers/wait-for-blocked-pid";

import { expireDesktopEditSessions } from "./desktop-edit-session-expiry";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const priorFileUsageFlag =
  envDocumentProcessingWorker.FEATURE_FILE_USAGE_LIMITS;

beforeAll(() => {
  envDocumentProcessingWorker.FEATURE_FILE_USAGE_LIMITS = true;
});

afterAll(() => {
  envDocumentProcessingWorker.FEATURE_FILE_USAGE_LIMITS = priorFileUsageFlag;
});

if (!databaseUrl || !runPostgresTests) {
  describe.skip("desktop edit session expiry cleanup (postgres)", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {
      expect(runPostgresTests && Boolean(databaseUrl)).toBe(false);
    });
  });
} else {
  describe("desktop edit session expiry cleanup (postgres)", () => {
    test("retries exact-key deletion and releases committed bytes", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db } = openClient();
        const userId = mintAuthProviderId<"user">();
        const organizationId = mintAuthProviderId<"organization">();
        const workspaceId = createSafeId<"workspace">();
        const entityId = createSafeId<"entity">();
        const versionId = createSafeId<"entityVersion">();
        const propertyId = createSafeId<"property">();
        const sessionId = createSafeId<"desktopEditSession">();
        const checkpointFileId = createSafeId<"userFile">();
        const checkpointSizeBytes = 29n;
        const objectKey = createFileKey({
          fileId: checkpointFileId,
          mimeType: desktopEditMimeTypeForFileType("docx"),
          organizationId,
          workspaceId,
        });
        const storedObjects = new Set<string>([objectKey]);

        await db.insert(user).values({
          email: `${userId}@example.test`,
          id: userId,
          name: "Desktop expiry cleanup",
        });
        await db.insert(organization).values({
          createdAt: new Date(),
          id: organizationId,
          name: "Desktop expiry cleanup",
          slug: organizationId,
        });
        await db.insert(member).values({
          createdAt: new Date(),
          id: mintAuthProviderIdValue(),
          organizationId,
          role: "owner",
          userId,
        });
        await db.insert(workspaces).values({
          id: workspaceId,
          name: "Desktop expiry cleanup",
          organizationId,
          reference: `expiry-${workspaceId}`,
        });
        await db.insert(entities).values({
          id: entityId,
          kind: "document",
          name: "desktop-expiry-cleanup",
          workspaceId,
        });
        await db.insert(entityVersions).values({
          entityId,
          id: versionId,
          workspaceId,
        });
        await db.insert(properties).values({
          content: { type: "file", version: 1 },
          id: propertyId,
          name: "Desktop file",
          status: "fresh",
          tool: { type: "manual-input", version: 1 },
          workspaceId,
        });
        await db.insert(desktopEditSessions).values({
          baseVersionId: versionId,
          checkpointFileId,
          checkpointSha256Hex: "a".repeat(64),
          checkpointSizeBytes: Number(checkpointSizeBytes),
          checkpointUpdatedAt: new Date(),
          createdBy: userId,
          entityId,
          fileName: "desktop.docx",
          fileType: "docx",
          id: sessionId,
          propertyId,
          sessionTokenHash: hashDesktopEditSessionToken(sessionId),
          status: "open",
          tokenExpiresAt: new Date(0),
          workspaceId,
        });
        await db.insert(organizationFileUsage).values({
          committedBytes: checkpointSizeBytes,
          organizationId,
        });
        await db.insert(organizationFileObjects).values({
          objectKey,
          organizationId,
          sizeBytes: checkpointSizeBytes,
          status: "committed",
        });

        const safeDb = asTestRaw<SafeDb>(
          async <T>(run: (tx: Transaction) => Promise<T>) =>
            await Result.tryPromise(
              async () =>
                await db.transaction(
                  async (tx) => await run(asTestRaw<Transaction>(tx)),
                ),
            ),
        );
        try {
          await expireDesktopEditSessions(
            asTestRaw<SchedulerTaskContext>({
              db,
              logger,
              signal: new AbortController().signal,
            }),
            {
              publisher: {
                publishSessionEvent: async () => await Promise.resolve(),
                publishWorkspaceEvent: async () => await Promise.resolve(),
              },
            },
          );

          expect(
            await db.query.desktopEditSessions.findFirst({
              columns: {
                checkpointSizeBytes: true,
                checkpointUpdatedAt: true,
                status: true,
              },
              where: { id: { eq: sessionId } },
            }),
          ).toMatchObject({
            checkpointSizeBytes: null,
            checkpointUpdatedAt: null,
            status: "expired",
          });
          const intent = (
            await db
              .select({
                id: bufferObjectCleanupIntents.id,
                objectKey: bufferObjectCleanupIntents.objectKey,
              })
              .from(bufferObjectCleanupIntents)
              .where(eq(bufferObjectCleanupIntents.objectKey, objectKey))
              .limit(1)
          ).at(0);
          expect(intent?.objectKey).toBe(objectKey);

          expect(
            await reconcileBufferObjectCleanupIntents({
              deleteObject: async () =>
                Result.err(
                  new OrganizationFileUsageError({
                    message: "Injected deletion failure",
                    reason: "storage_unavailable",
                  }),
                ),
              limit: 1,
              safeDb,
            }),
          ).toBe(1);
          expect(storedObjects.has(objectKey)).toBe(true);
          expect(
            await db.$count(
              bufferObjectCleanupIntents,
              eq(bufferObjectCleanupIntents.objectKey, objectKey),
            ),
          ).toBe(1);

          await db
            .update(bufferObjectCleanupIntents)
            .set({ nextAttemptAt: new Date(0) })
            .where(eq(bufferObjectCleanupIntents.objectKey, objectKey));
          expect(
            await reconcileBufferObjectCleanupIntents({
              deleteObject: async (key) => {
                storedObjects.delete(key);
                return await removeOrganizationFileBytes(key, db);
              },
              limit: 1,
              safeDb,
            }),
          ).toBe(1);
          expect(storedObjects.has(objectKey)).toBe(false);
          expect(
            await db.$count(
              organizationFileObjects,
              eq(organizationFileObjects.objectKey, objectKey),
            ),
          ).toBe(0);
          expect(
            (
              await db
                .select({
                  committedBytes: organizationFileUsage.committedBytes,
                })
                .from(organizationFileUsage)
                .where(eq(organizationFileUsage.organizationId, organizationId))
                .limit(1)
            ).at(0)?.committedBytes,
          ).toBe(0n);
          expect(
            await db.$count(
              bufferObjectCleanupIntents,
              eq(bufferObjectCleanupIntents.objectKey, objectKey),
            ),
          ).toBe(0);
          expect(
            await reconcileBufferObjectCleanupIntents({
              deleteObject: async () => Result.ok(undefined),
              limit: 1,
              safeDb,
            }),
          ).toBe(0);
        } finally {
          await db
            .delete(organization)
            .where(eq(organization.id, organizationId));
          await db.delete(user).where(eq(user.id, userId));
        }
      });
    });

    // timeout: two PostgreSQL sessions race a checkpoint through a lock barrier.
    test("a checkpoint committed after the batch read is owned by the expiry's intent", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db } = openClient();
        const sweeper = openClient({ max: 1 });
        const writer = openClient({ max: 1 });
        const observer = openClient().sql;
        const userId = mintAuthProviderId<"user">();
        const organizationId = mintAuthProviderId<"organization">();
        const workspaceId = createSafeId<"workspace">();
        const entityId = createSafeId<"entity">();
        const versionId = createSafeId<"entityVersion">();
        const propertyId = createSafeId<"property">();
        const sessionId = createSafeId<"desktopEditSession">();
        const checkpointFileId = createSafeId<"userFile">();
        const checkpointSizeBytes = 31n;
        const objectKey = createFileKey({
          fileId: checkpointFileId,
          mimeType: desktopEditMimeTypeForFileType("docx"),
          organizationId,
          workspaceId,
        });
        await db.insert(user).values({
          email: `${userId}@example.test`,
          id: userId,
          name: "Desktop expiry checkpoint race",
        });
        await db.insert(organization).values({
          createdAt: new Date(),
          id: organizationId,
          name: "Desktop expiry checkpoint race",
          slug: organizationId,
        });
        try {
          await db.insert(member).values({
            createdAt: new Date(),
            id: mintAuthProviderIdValue(),
            organizationId,
            role: "owner",
            userId,
          });
          await db.insert(workspaces).values({
            id: workspaceId,
            name: "Desktop expiry checkpoint race",
            organizationId,
            reference: `expiry-race-${workspaceId}`,
          });
          await db.insert(entities).values({
            id: entityId,
            kind: "document",
            name: "desktop-expiry-race",
            workspaceId,
          });
          await db
            .insert(entityVersions)
            .values({ entityId, id: versionId, workspaceId });
          await db.insert(properties).values({
            content: { type: "file", version: 1 },
            id: propertyId,
            name: "Desktop file",
            status: "fresh",
            tool: { type: "manual-input", version: 1 },
            workspaceId,
          });
          // Expired, and no checkpoint yet when the sweep reads its batch.
          await db.insert(desktopEditSessions).values({
            baseVersionId: versionId,
            checkpointFileId,
            createdBy: userId,
            entityId,
            fileName: "desktop.docx",
            fileType: "docx",
            id: sessionId,
            propertyId,
            sessionTokenHash: hashDesktopEditSessionToken(sessionId),
            status: "open",
            tokenExpiresAt: new Date(0),
            workspaceId,
          });
          await db.insert(organizationFileUsage).values({
            committedBytes: checkpointSizeBytes,
            organizationId,
          });
          await db.insert(organizationFileObjects).values({
            objectKey,
            organizationId,
            sizeBytes: checkpointSizeBytes,
            status: "committed",
          });

          const pidColumns = { pid: sql<number>`pg_backend_pid()` };
          const identity = sql`(SELECT 1) AS backend_identity`;
          const backendPid = (rows: { pid: number }[]) =>
            rows.at(0)?.pid ?? panic("Backend identity missing");
          const sweeperPid = backendPid(
            await sweeper.db.select(pidColumns).from(identity),
          );
          // The checkpoint's row lock is held, uncommitted, while the sweep
          // reads its batch, so the batch sees no checkpoint.
          const written = Promise.withResolvers<number>();
          const commit = Promise.withResolvers<undefined>();
          const checkpoint = writer.db.transaction(async (tx) => {
            await tx
              .update(desktopEditSessions)
              .set({
                checkpointSha256Hex: "b".repeat(64),
                checkpointSizeBytes: Number(checkpointSizeBytes),
                checkpointUpdatedAt: new Date(),
              })
              .where(eq(desktopEditSessions.id, sessionId));
            written.resolve(
              backendPid(await tx.select(pidColumns).from(identity)),
            );
            await commit.promise;
          });
          const writerPid = await written.promise;
          const sweep = expireDesktopEditSessions(
            asTestRaw<SchedulerTaskContext>({
              db: sweeper.db,
              logger,
              signal: new AbortController().signal,
            }),
            {
              publisher: {
                publishSessionEvent: async () => await Promise.resolve(),
                publishWorkspaceEvent: async () => await Promise.resolve(),
              },
            },
          );
          try {
            await waitForBlockedPid(observer, {
              waitingPid: sweeperPid,
              holdingPid: writerPid,
            });
          } finally {
            commit.resolve(undefined);
          }
          await checkpoint;
          await sweep;

          expect(
            await db.query.desktopEditSessions.findFirst({
              columns: { checkpointSizeBytes: true, status: true },
              where: { id: { eq: sessionId } },
            }),
          ).toMatchObject({ checkpointSizeBytes: null, status: "expired" });
          expect(
            await db.$count(
              bufferObjectCleanupIntents,
              eq(bufferObjectCleanupIntents.objectKey, objectKey),
            ),
          ).toBe(1);
          // The intent owns the committed bytes until its cleanup releases them.
          expect(
            await db.$count(
              organizationFileObjects,
              eq(organizationFileObjects.objectKey, objectKey),
            ),
          ).toBe(1);
        } finally {
          await db
            .delete(organization)
            .where(eq(organization.id, organizationId));
          await db.delete(user).where(eq(user.id, userId));
        }
      });
    }, 30_000);
  });
}
