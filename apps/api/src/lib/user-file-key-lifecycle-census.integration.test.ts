import { panic, Result } from "better-result";
import { afterAll, describe, expect, test } from "bun:test";
import { and, eq, inArray, sql, TransactionRollbackError } from "drizzle-orm";
import JSZip from "jszip";

import { ACCOUNT_EXPORT_PROJECTIONS } from "@/api/account-export-projections";
import { member, organization, user } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import {
  chatThreads,
  entityDeletionCleanupRequests,
  organizationFileObjects,
  organizationFileUsage,
  userFiles,
} from "@/api/db/schema";
import { createSafeDb } from "@/api/db/scoped";
import { envBase } from "@/api/env-base";
import { envDocumentProcessingWorker } from "@/api/env-document-processing-worker";
import deleteThread from "@/api/handlers/chat/threads/delete";
import readUserFileContent from "@/api/handlers/user-files/read-content";
import readUserFileThumbnail from "@/api/handlers/user-files/read-thumbnail";
import { createReadUserFileVisual } from "@/api/handlers/user-files/read-visual";
import { deleteUserFiles } from "@/api/lib/account-deletion-steps";
import {
  type AccountExportArchiveDeps,
  buildAccountExportArchive,
} from "@/api/lib/account-export/archive";
import {
  exportAccountFiles,
  exportAccountRows,
} from "@/api/lib/account-export/pages";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { createUserFileThumbnailKey } from "@/api/lib/file-key";
import {
  recordContentDeliveryReceipt,
  runWithContentDeliveryScope,
} from "@/api/lib/files/content-delivery";
import {
  reconcileOrganizationFileObjects,
  reserveOrganizationFileBytes,
} from "@/api/lib/files/organization-file-usage";
import { reconcileAbandonedOrganizationFileReservations } from "@/api/lib/files/organization-file-usage-reconcile";
import { recordOrganizationStorageTeardown } from "@/api/lib/organization-storage-teardown";
import { userFileUsageObjects } from "@/api/scripts/backfill-organization-file-usage.helpers";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { startFakeS3 } from "@/api/tests/helpers/fake-s3";
import type { FakeS3 } from "@/api/tests/helpers/fake-s3";
import { testFileKey } from "@/api/tests/helpers/file-key";
import {
  createTestHandlerContext,
  NO_DB,
} from "@/api/tests/helpers/handler-context";
import { testScannedFile } from "@/api/tests/helpers/scanned-file";
import { createTestState } from "@/api/tests/helpers/test-state";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const PDF_MIME = "application/pdf";

type Fixture = {
  expectedKeys: string[];
  fileIds: SafeId<"userFile">[];
  fileKeys: string[];
  invalidFileIds: SafeId<"userFile">[];
  organizationId: SafeId<"organization">;
  threadId: SafeId<"chatThread">;
  userId: SafeId<"user">;
};

let database: TestDatabase;
let fake: FakeS3;
let fixture: Fixture;
let invalidRows: (typeof userFiles.$inferInsert)[];
const testState = createTestState({
  file: import.meta.path,
  config: envDocumentProcessingWorker,
});

const thumbnailKey = ({
  organizationId,
  sourceKey,
  thumbnailFileId,
  userId,
}: {
  organizationId: SafeId<"organization">;
  sourceKey: string;
  thumbnailFileId: string;
  userId: SafeId<"user">;
}) =>
  createUserFileThumbnailKey({
    sourceKey,
    thumbnailFileId,
    organizationId,
    uploaderUserId: userId,
  }) ?? panic("The fixture key must have an accepted owner");

const contextFor = <T>(
  endpoint: { handler: (context: T) => unknown },
  fields: Record<string, unknown>,
  recordAuditEvent: AuditRecorder = async () => {},
) =>
  createTestHandlerContext<Parameters<typeof endpoint.handler>[0]>({
    scopedDb: NO_DB,
    safeDb: createSafeDb(database, [], fixture.organizationId, fixture.userId),
    audit: recordAuditEvent,
    session: { activeOrganizationId: fixture.organizationId },
    user: { id: fixture.userId },
    ...fields,
  });

const expectResponse = (value: unknown) => {
  expect(value).toBeInstanceOf(Response);
  return value instanceof Response ? value : panic("Expected a response");
};

describe.skipIf(!enabled)("user file key lifecycle census", () => {
  testState.beforeAll(async () => {
    database = await getTestDb();
    fake = startFakeS3();
    testState.setConfig("FEATURE_FILE_USAGE_LIMITS", true);
    const organizationId = mintAuthProviderId<"organization">();
    const userId = mintAuthProviderId<"user">();
    const otherOrganizationId = mintAuthProviderId<"organization">();
    const otherUserId = mintAuthProviderId<"user">();
    const threadId = createSafeId<"chatThread">();
    const organizationFileId = createSafeId<"userFile">();
    const uploaderFileId = createSafeId<"userFile">();
    const otherOrganizationFileId = createSafeId<"userFile">();
    const otherUserFileId = createSafeId<"userFile">();
    const organizationThumbnailId = Bun.randomUUIDv7();
    const uploaderThumbnailId = Bun.randomUUIDv7();
    const organizationKey = testFileKey(
      `${organizationId}/${organizationFileId}.pdf`,
    );
    const uploaderKey = testFileKey(`${userId}/${uploaderFileId}.pdf`);

    await database.insert(user).values({
      id: userId,
      name: "Lifecycle census member",
      email: `${userId}@example.test`,
    });
    await database.insert(organization).values({
      id: organizationId,
      name: "Lifecycle census organization",
      slug: organizationId,
      createdAt: new Date(),
    });
    await database.insert(member).values({
      id: Bun.randomUUIDv7(),
      organizationId,
      userId,
      role: "member",
      createdAt: new Date(),
    });
    await database.insert(chatThreads).values({
      id: threadId,
      organizationId,
      userId,
      title: "Lifecycle census thread",
      workspaceId: null,
    });
    await database.transaction(async (tx) => {
      await tx.execute(
        sql`ALTER TABLE public.user_files DISABLE TRIGGER user_files_organization_key_guard`,
      );
      await tx.insert(userFiles).values([
        {
          id: organizationFileId,
          userId,
          fileName: "organization.pdf",
          mimeType: PDF_MIME,
          sizeBytes: 19,
          sha256Hex: "a".repeat(64),
          s3Key: organizationKey,
          threadId,
          thumbnailFileId: organizationThumbnailId,
        },
        {
          id: uploaderFileId,
          userId,
          fileName: "uploader.pdf",
          mimeType: PDF_MIME,
          sizeBytes: 23,
          sha256Hex: "b".repeat(64),
          s3Key: uploaderKey,
          threadId,
          thumbnailFileId: uploaderThumbnailId,
        },
      ]);
      await tx.execute(
        sql`ALTER TABLE public.user_files ENABLE TRIGGER user_files_organization_key_guard`,
      );
    });
    invalidRows = [
      {
        id: otherOrganizationFileId,
        userId,
        fileName: "other-organization.pdf",
        mimeType: PDF_MIME,
        sizeBytes: 29,
        sha256Hex: "c".repeat(64),
        s3Key: testFileKey(
          `${otherOrganizationId}/${otherOrganizationFileId}.pdf`,
        ),
        threadId,
        thumbnailFileId: Bun.randomUUIDv7(),
      },
      {
        id: otherUserFileId,
        userId,
        fileName: "other-user.pdf",
        mimeType: PDF_MIME,
        sizeBytes: 31,
        sha256Hex: "d".repeat(64),
        s3Key: testFileKey(`${otherUserId}/${otherUserFileId}.pdf`),
        threadId,
        thumbnailFileId: Bun.randomUUIDv7(),
      },
    ];

    fixture = {
      organizationId,
      userId,
      threadId,
      fileIds: [organizationFileId, uploaderFileId],
      invalidFileIds: [otherOrganizationFileId, otherUserFileId],
      fileKeys: [organizationKey, uploaderKey],
      expectedKeys: [
        organizationKey,
        thumbnailKey({
          organizationId,
          sourceKey: organizationKey,
          thumbnailFileId: organizationThumbnailId,
          userId,
        }),
        uploaderKey,
        thumbnailKey({
          organizationId,
          sourceKey: uploaderKey,
          thumbnailFileId: uploaderThumbnailId,
          userId,
        }),
      ].toSorted(),
    };
    for (const key of fixture.expectedKeys) {
      fake.put(
        envBase.S3_BUCKET,
        key,
        new Uint8Array(7),
        undefined,
        new Date(),
      );
    }
  });

  afterAll(async () => {
    fake.stop();
    await database
      .delete(organizationFileObjects)
      .where(
        eq(organizationFileObjects.organizationId, fixture.organizationId),
      );
    await database
      .delete(organizationFileUsage)
      .where(eq(organizationFileUsage.organizationId, fixture.organizationId));
    await database
      .delete(entityDeletionCleanupRequests)
      .where(
        eq(
          entityDeletionCleanupRequests.organizationId,
          fixture.organizationId,
        ),
      );
    await database
      .delete(organization)
      .where(eq(organization.id, fixture.organizationId));
    await database.delete(user).where(eq(user.id, fixture.userId));
    await releaseTestDb();
  });

  test("teardown and account erasure find both stored key forms and thumbnails", async () => {
    await database.transaction(async (tx) => {
      await recordOrganizationStorageTeardown({
        organizationId: fixture.organizationId,
        tx: asTestRaw<Transaction>(tx),
      });
    });
    const requests = await database
      .select({ s3Keys: entityDeletionCleanupRequests.s3Keys })
      .from(entityDeletionCleanupRequests)
      .where(
        eq(
          entityDeletionCleanupRequests.organizationId,
          fixture.organizationId,
        ),
      );
    expect(requests.flatMap(({ s3Keys }) => s3Keys).toSorted()).toEqual(
      fixture.expectedKeys,
    );

    const accountDeletionKeys: string[] = [];
    await database
      .transaction(async (tx) => {
        await deleteUserFiles({
          tx: asTestRaw<Transaction>(tx),
          currentUserId: fixture.userId,
          s3KeysToDelete: accountDeletionKeys,
        });
        tx.rollback();
      })
      .catch((error: unknown) => {
        if (!(error instanceof TransactionRollbackError)) {
          throw error;
        }
      });
    expect(accountDeletionKeys.toSorted()).toEqual(fixture.expectedKeys);
  });

  test("the personal archive reads both persisted object keys", async () => {
    const opened: string[] = [];
    const published: Uint8Array[] = [];
    const scopedDatabase =
      asTestRaw<
        NonNullable<Parameters<typeof exportAccountRows>[0]["scopedDatabase"]>
      >(database);
    const deps = {
      rows: ({ scopedDatabase: _scopedDatabase, ...options }) =>
        exportAccountRows({ ...options, scopedDatabase }),
      files: ({ scopedDatabase: _scopedDatabase, ...options }) =>
        exportAccountFiles({ ...options, scopedDatabase }),
      openObject: async (key: string) => {
        opened.push(key);
        const size = key === fixture.fileKeys.at(0) ? 19 : 23;
        return {
          body: new Blob([new Uint8Array(size)]).stream(),
          contentLength: size,
        };
      },
      publish: async (_key, bytes) => {
        if (!(bytes instanceof Blob)) {
          panic("Expected the archive spool");
        }
        published.push(new Uint8Array(await bytes.arrayBuffer()));
      },
    } satisfies AccountExportArchiveDeps;

    await buildAccountExportArchive({
      projections: ACCOUNT_EXPORT_PROJECTIONS,
      db: database,
      userId: fixture.userId,
      objectKey: "lifecycle-census.zip",
      signal: new AbortController().signal,
      deps,
    });
    expect(opened.toSorted()).toEqual(fixture.fileKeys.toSorted());
    const bytes = published.at(0) ?? panic("Archive publication required");
    const archive = await JSZip.loadAsync(bytes);
    const exportedFiles = Object.keys(archive.files).filter((name) =>
      name.startsWith("files/"),
    );
    expect(exportedFiles).toHaveLength(2);
  });

  test("usage reconciliation and backfill census both stored key forms and thumbnails", async () => {
    const files = await database
      .select({
        id: userFiles.id,
        organizationId: chatThreads.organizationId,
        s3Key: userFiles.s3Key,
        thumbnailFileId: userFiles.thumbnailFileId,
        userId: userFiles.userId,
      })
      .from(userFiles)
      .innerJoin(chatThreads, eq(userFiles.threadId, chatThreads.id));
    const objects = userFileUsageObjects(files);
    const keys = objects
      .filter(({ organizationId }) => organizationId === fixture.organizationId)
      .map(({ objectKey }) => objectKey)
      .toSorted();
    expect(keys).toEqual(fixture.expectedKeys);

    for (const objectKey of fixture.expectedKeys) {
      expect(
        Result.isOk(
          await reserveOrganizationFileBytes(
            { organizationId: fixture.organizationId, objectKey, sizeBytes: 7 },
            asTestRaw(database),
          ),
        ),
      ).toBe(true);
    }
    const old = new Date(Date.now() - 2 * 60 * 60_000);
    await database
      .update(organizationFileObjects)
      .set({ reservationStartedAt: old, updatedAt: old })
      .where(
        eq(organizationFileObjects.organizationId, fixture.organizationId),
      );
    const reconciled = (
      await reconcileAbandonedOrganizationFileReservations({
        db: asTestRaw(database),
        organizationId: fixture.organizationId,
      })
    ).unwrap();
    expect(reconciled).toMatchObject({ scanned: 4, committed: 4 });
    const usage = await database
      .select({ committedBytes: organizationFileUsage.committedBytes })
      .from(organizationFileUsage)
      .where(eq(organizationFileUsage.organizationId, fixture.organizationId))
      .then((rows) => rows.at(0));
    expect(usage?.committedBytes).toBe(28n);

    await database
      .delete(organizationFileObjects)
      .where(
        eq(organizationFileObjects.organizationId, fixture.organizationId),
      );
    await database
      .delete(organizationFileUsage)
      .where(eq(organizationFileUsage.organizationId, fixture.organizationId));
    expect(
      (
        await reconcileOrganizationFileObjects(
          objects
            .filter(
              ({ organizationId }) => organizationId === fixture.organizationId,
            )
            .map(({ organizationId, objectKey }) => ({
              organizationId,
              objectKey,
              sizeBytes: 7,
            })),
          asTestRaw(database),
        )
      ).unwrap(),
    ).toBe(4);
  });

  test("content, visual, and thumbnail readers accept owned keys and refuse other owners", async () => {
    await database.transaction(async (tx) => {
      await tx.execute(
        sql`ALTER TABLE public.user_files DISABLE TRIGGER user_files_organization_key_guard`,
      );
      await tx.insert(userFiles).values(invalidRows);
      await tx.execute(
        sql`ALTER TABLE public.user_files ENABLE TRIGGER user_files_organization_key_guard`,
      );
    });
    const auditedKeys: string[] = [];
    const audit: AuditRecorder = async (_tx, event) => {
      const events = Array.isArray(event) ? event : [event];
      for (const item of events) {
        const key = item.metadata?.["s3Key"];
        if (typeof key === "string") {
          auditedKeys.push(key);
        }
      }
    };
    const visualKeys: string[] = [];
    const visualReader = createReadUserFileVisual(async ({ key }) => {
      visualKeys.push(key);
      recordContentDeliveryReceipt();
      return testScannedFile({
        bytes: new TextEncoder().encode(
          JSON.stringify({
            title: "Census",
            html: "<p>Census</p>",
            data: {},
            links: [],
          }),
        ).buffer,
        mimeType: "text/plain",
      });
    });

    for (const fileId of fixture.fileIds) {
      expectResponse(
        await runWithContentDeliveryScope(
          { type: "audited" },
          async () =>
            await readUserFileContent.handler(
              contextFor(readUserFileContent, { params: { fileId } }, audit),
            ),
        ),
      );
      expectResponse(
        await runWithContentDeliveryScope(
          { type: "audited" },
          async () =>
            await readUserFileThumbnail.handler(
              contextFor(readUserFileThumbnail, { params: { fileId } }, audit),
            ),
        ),
      );
      expectResponse(
        await visualReader.handler(
          contextFor(visualReader, {
            params: { fileId },
            request: new Request("https://example.test/visual"),
          }),
        ),
      );
    }
    expect(auditedKeys.toSorted()).toEqual(fixture.expectedKeys);
    expect(visualKeys.toSorted()).toEqual(fixture.fileKeys.toSorted());

    for (const fileId of fixture.invalidFileIds) {
      for (const endpoint of [readUserFileContent, readUserFileThumbnail]) {
        expect(
          await runWithContentDeliveryScope(
            { type: "audited" },
            async () =>
              await endpoint.handler(
                contextFor(endpoint, { params: { fileId } }, audit),
              ),
          ),
        ).toMatchObject({ code: 404 });
      }
      expect(
        await visualReader.handler(
          contextFor(visualReader, {
            params: { fileId },
            request: new Request("https://example.test/visual"),
          }),
        ),
      ).toMatchObject({ code: 404 });
    }
    expect(visualKeys).toHaveLength(2);
    await database
      .delete(userFiles)
      .where(inArray(userFiles.id, fixture.invalidFileIds));
  });

  test("thread deletion removes both stored key forms and thumbnails", async () => {
    testState.setConfig("FEATURE_FILE_USAGE_LIMITS", false);
    const result = await deleteThread.handler(
      contextFor(deleteThread, {
        params: { threadId: fixture.threadId },
        query: {},
        getWorkspaceAccess: async () => null,
      }),
    );
    expect(result).toEqual({});
    for (const key of fixture.expectedKeys) {
      expect(fake.objects.has(`${envBase.S3_BUCKET}/${key}`)).toBe(false);
    }
    const rows = await database
      .select({ id: userFiles.id })
      .from(userFiles)
      .where(
        and(
          eq(userFiles.threadId, fixture.threadId),
          eq(userFiles.userId, fixture.userId),
        ),
      );
    expect(rows).toEqual([]);
  });
});
