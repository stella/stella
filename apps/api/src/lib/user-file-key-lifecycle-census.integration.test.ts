import { panic } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import JSZip from "jszip";

import { ACCOUNT_EXPORT_PROJECTIONS } from "@/api/account-export-projections";
import { member, organization, user } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import {
  chatThreads,
  entityDeletionCleanupRequests,
  userFiles,
} from "@/api/db/schema";
import { markRlsDatabase } from "@/api/db/scoped";
import { deleteUserFiles } from "@/api/lib/account-deletion-steps";
import {
  buildAccountExportArchive,
  type AccountExportArchiveDeps,
} from "@/api/lib/account-export/archive";
import {
  exportAccountFiles,
  exportAccountRows,
} from "@/api/lib/account-export/pages";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { createUserFileThumbnailKey } from "@/api/lib/file-key";
import { recordOrganizationStorageTeardown } from "@/api/lib/organization-storage-teardown";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const PDF_MIME = "application/pdf";

type Fixture = {
  expectedKeys: string[];
  fileKeys: string[];
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
};

let database: TestDatabase;
let fixture: Fixture;

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

describe.skipIf(!enabled)("user file key lifecycle census", () => {
  beforeAll(async () => {
    database = await getTestDb();
    const organizationId = createSafeId<"organization">();
    const userId = createSafeId<"user">();
    const threadId = createSafeId<"chatThread">();
    const organizationFileId = createSafeId<"userFile">();
    const uploaderFileId = createSafeId<"userFile">();
    const organizationThumbnailId = Bun.randomUUIDv7();
    const uploaderThumbnailId = Bun.randomUUIDv7();
    const organizationKey = `${organizationId}/${organizationFileId}.pdf`;
    const uploaderKey = `${userId}/${uploaderFileId}.pdf`;

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
    await database.insert(userFiles).values([
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

    fixture = {
      organizationId,
      userId,
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
  }, 30_000);

  afterAll(async () => {
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
    await database.transaction(async (tx) => {
      await deleteUserFiles({
        tx: asTestRaw<Transaction>(tx),
        currentUserId: fixture.userId,
        s3KeysToDelete: accountDeletionKeys,
      });
      tx.rollback();
    });
    expect(accountDeletionKeys.toSorted()).toEqual(fixture.expectedKeys);
  });

  test("the personal archive reads both persisted object keys", async () => {
    const opened: string[] = [];
    const published: Uint8Array[] = [];
    const scopedDatabase = markRlsDatabase(database);
    const deps = {
      rows: (options) => exportAccountRows({ ...options, scopedDatabase }),
      files: (options) => exportAccountFiles({ ...options, scopedDatabase }),
      openObject: async (key: string) => {
        opened.push(key);
        return new Blob([key]);
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
});
