/**
 * Run explicitly before enabling FEATURE_FILE_USAGE_LIMITS. It pages through
 * stored organization objects and chat attachments, then imports the actual
 * object lengths. Replaying a page changes no count for unchanged objects.
 */
import { panic, Result } from "better-result";
import { asc, eq, gt, and } from "drizzle-orm";

import { Temporal } from "@stll/time";

import { organization } from "@/api/db/auth-schema";
import { chatThreads, userFiles } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import {
  openMaintenanceDb,
  openOrganizationFileUsageDb,
} from "@/api/lib/db/maintenance-db";
import { createUserFileKey } from "@/api/lib/file-key";
import { THUMBNAIL_MIME_TYPE } from "@/api/lib/files/image-derivative";
import { reconcileOrganizationFileObject } from "@/api/lib/files/organization-file-usage";
import { isMissingS3ObjectError, listS3ObjectPage } from "@/api/lib/s3";
import { headObject } from "@/api/lib/s3-presign";
import {
  brandPersistedOrganizationId,
  brandPersistedUserFileId,
  brandPersistedUserId,
} from "@/api/lib/safe-id-boundaries";
import {
  isTemporaryOrganizationObjectKey,
  reconcileAbsentOrganizationFileObjects,
} from "@/api/scripts/backfill-organization-file-usage.helpers";

const PAGE_SIZE = 200;
const RESERVATION_STALE_AFTER_MS = 60 * 60 * 1000;
const db = openMaintenanceDb({ readOnly: true });
const ledgerDb = openOrganizationFileUsageDb();

const readObjectSize = async (objectKey: string): Promise<number | null> => {
  const head = await headObject(objectKey);
  if (Result.isOk(head)) {
    return head.value.contentLength;
  }
  if (isMissingS3ObjectError(head.error.cause)) {
    return null;
  }
  throw head.error;
};

const importObject = async (
  organizationId: SafeId<"organization">,
  objectKey: string,
) => {
  if (isTemporaryOrganizationObjectKey(organizationId, objectKey)) {
    return false;
  }
  const sizeBytes = await readObjectSize(objectKey);
  if (sizeBytes === null) {
    return false;
  }
  const recorded = await reconcileOrganizationFileObject({
    organizationId,
    objectKey,
    sizeBytes,
  });
  if (Result.isError(recorded)) {
    if (recorded.error.reason === "reservation_busy") {
      return false;
    }
    throw recorded.error;
  }
  return true;
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
let removed = 0;
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
        if (await importObject(organizationId, key)) {
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
        if (await importObject(organizationId, file.s3Key)) {
          imported += 1;
        }
        if (
          file.thumbnailFileId &&
          (await importObject(
            organizationId,
            createUserFileKey({
              fileId: file.thumbnailFileId,
              mimeType: THUMBNAIL_MIME_TYPE,
              userId: brandPersistedUserId(file.userId),
            }),
          ))
        ) {
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
    removed += await reconcileAbsentOrganizationFileObjects({
      db: ledgerDb,
      organizationId,
      objectExists: async (key) => (await readObjectSize(key)) !== null,
      staleBefore: new Date(
        Temporal.Now.instant().epochMilliseconds - RESERVATION_STALE_AFTER_MS,
      ),
    });
  }
  const lastOrganization = organizations.at(-1);
  orgCursor =
    lastOrganization === undefined
      ? null
      : brandPersistedOrganizationId(lastOrganization.id);
}
console.log(
  `Reconciled ${imported} stored objects; removed ${removed} absent ledger rows.`,
);
