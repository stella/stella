/**
 * Run explicitly before enabling FEATURE_FILE_USAGE_LIMITS. It pages through
 * stored organization objects and chat attachments, then imports the actual
 * object lengths. Replaying a page changes no count for unchanged objects.
 */
import { panic, Result } from "better-result";
import { asc, eq, gt, and } from "drizzle-orm";

import { organization } from "@/api/db/auth-schema";
import { chatThreads, userFiles } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { openMaintenanceDb } from "@/api/lib/db/maintenance-db";
import { createUserFileKey } from "@/api/lib/file-key";
import { THUMBNAIL_MIME_TYPE } from "@/api/lib/files/image-derivative";
import { reconcileOrganizationFileObject } from "@/api/lib/files/organization-file-usage";
import { listS3ObjectPage } from "@/api/lib/s3";
import { headObject } from "@/api/lib/s3-presign";
import {
  brandPersistedOrganizationId,
  brandPersistedUserFileId,
  brandPersistedUserId,
} from "@/api/lib/safe-id-boundaries";

const PAGE_SIZE = 200;
const db = openMaintenanceDb({ readOnly: true });

const importObject = async (
  organizationId: SafeId<"organization">,
  objectKey: string,
) => {
  const head = await headObject(objectKey);
  if (Result.isError(head)) {
    throw head.error;
  }
  const recorded = await reconcileOrganizationFileObject({
    organizationId,
    objectKey,
    sizeBytes: head.value.contentLength,
  });
  if (Result.isError(recorded)) {
    throw recorded.error;
  }
};

const readOrganizationPage = async (cursor: SafeId<"organization"> | null) =>
  await db.transaction(
    async (tx) =>
      await tx
        .select({ id: organization.id })
        .from(organization)
        .where(cursor === null ? undefined : gt(organization.id, cursor))
        .orderBy(asc(organization.id))
        .limit(PAGE_SIZE),
  );

const readUserFilePage = async ({
  cursor,
  organizationId,
}: {
  cursor: SafeId<"userFile"> | null;
  organizationId: SafeId<"organization">;
}) =>
  await db.transaction(
    async (tx) =>
      await tx
        .select({
          id: userFiles.id,
          s3Key: userFiles.s3Key,
          thumbnailFileId: userFiles.thumbnailFileId,
          userId: userFiles.userId,
        })
        .from(userFiles)
        .innerJoin(chatThreads, eq(userFiles.threadId, chatThreads.id))
        .where(
          and(
            eq(chatThreads.organizationId, organizationId),
            cursor === null ? undefined : gt(userFiles.id, cursor),
          ),
        )
        .orderBy(asc(userFiles.id))
        .limit(PAGE_SIZE),
  );

let orgCursor: SafeId<"organization"> | null = null;
let imported = 0;
while (true) {
  const organizations = await readOrganizationPage(orgCursor);
  if (organizations.length === 0) {
    break;
  }
  for (const organizationRow of organizations) {
    const organizationId = brandPersistedOrganizationId(organizationRow.id);
    let keyCursor: string | null = null;
    while (true) {
      const page = await listS3ObjectPage({
        prefix: `${organizationId}/`,
        startAfter: keyCursor,
        maxKeys: PAGE_SIZE,
        signal: AbortSignal.timeout(30_000),
      });
      for (const { key } of page.objects) {
        // Temporary upload and comparison objects expire by bucket lifecycle;
        // only durable storage consumes the organization byte counter.
        if (!key.startsWith(`${organizationId}/tmp/`)) {
          await importObject(organizationId, key);
          imported += 1;
        }
      }
      keyCursor = page.objects.at(-1)?.key ?? null;
      if (!page.truncated) {
        break;
      }
      if (keyCursor === null) {
        panic("Object listing ended without a cursor");
      }
    }

    let fileCursor: SafeId<"userFile"> | null = null;
    while (true) {
      const files = await readUserFilePage({
        cursor: fileCursor,
        organizationId,
      });
      if (files.length === 0) {
        break;
      }
      for (const file of files) {
        await importObject(organizationId, file.s3Key);
        imported += 1;
        if (file.thumbnailFileId) {
          await importObject(
            organizationId,
            createUserFileKey({
              fileId: file.thumbnailFileId,
              mimeType: THUMBNAIL_MIME_TYPE,
              userId: brandPersistedUserId(file.userId),
            }),
          );
          imported += 1;
        }
      }
      const lastFile = files.at(-1);
      fileCursor =
        lastFile === undefined ? null : brandPersistedUserFileId(lastFile.id);
      if (files.length < PAGE_SIZE) {
        break;
      }
    }
  }
  const lastOrganization = organizations.at(-1);
  orgCursor =
    lastOrganization === undefined
      ? null
      : brandPersistedOrganizationId(lastOrganization.id);
}
console.log(`Reconciled ${imported} stored objects.`);
