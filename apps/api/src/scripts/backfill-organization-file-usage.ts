/**
 * Stop every API, worker, and other storage writer before running this script.
 * Keep them stopped until FEATURE_FILE_USAGE_LIMITS is enabled and the writers
 * restart with that setting. Pass --writers-quiesced-through-enable only after
 * confirming that window. The flag-off path does not record new writes, so a
 * live backfill can miss objects written after their organization was scanned.
 * The script pages through stored organization objects and chat attachments;
 * replaying a page changes no count for unchanged objects.
 */
import { panic, Result } from "better-result";
import { asc, eq, gt } from "drizzle-orm";

import { runScriptWithErrorOutput } from "@stll/errors";
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
import type { FileUsageInput } from "@/api/lib/files/organization-file-usage";
import { reconcileOrganizationFileObjects } from "@/api/lib/files/organization-file-usage";
import {
  ORGANIZATION_FILE_RESERVATION_RECONCILE_BATCH_LIMIT,
  reconcileAbandonedOrganizationFileReservations,
} from "@/api/lib/files/organization-file-usage-reconcile";
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
  reportOrganizationFileUsageBackfill,
} from "@/api/scripts/backfill-organization-file-usage.helpers";

const PAGE_SIZE = 200;
const RESERVATION_STALE_AFTER_MS = 60 * 60 * 1000;
await runScriptWithErrorOutput(async () => {
  if (!process.argv.includes("--writers-quiesced-through-enable")) {
    panic(
      "Stop all storage writers through FEATURE_FILE_USAGE_LIMITS enablement, then pass --writers-quiesced-through-enable",
    );
  }
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

  const importObjectPage = async (
    objects: readonly Pick<FileUsageInput, "organizationId" | "objectKey">[],
  ) => {
    const inputs: FileUsageInput[] = [];
    const organizationsByKey = new Map<string, SafeId<"organization">>();
    for (const { organizationId, objectKey } of objects) {
      const previousOrganization = organizationsByKey.get(objectKey);
      if (previousOrganization !== undefined) {
        if (previousOrganization !== organizationId) {
          panic("Object key belongs to multiple organizations during backfill");
        }
        continue;
      }
      if (isTemporaryOrganizationObjectKey(organizationId, objectKey)) {
        continue;
      }
      organizationsByKey.set(objectKey, organizationId);
      const sizeBytes = await readObjectSize(objectKey);
      if (sizeBytes !== null) {
        inputs.push({ organizationId, objectKey, sizeBytes });
      }
    }
    const recorded = await reconcileOrganizationFileObjects(inputs, ledgerDb);
    return recorded.unwrap(
      "Organization file reconciliation must succeed during backfill",
    );
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

  const importUserFilePage = async (cursor: SafeId<"userFile"> | null) => {
    const files = await db.transaction(
      async (tx) =>
        await tx
          .select({
            id: userFiles.id,
            organizationId: chatThreads.organizationId,
            s3Key: userFiles.s3Key,
            thumbnailFileId: userFiles.thumbnailFileId,
            userId: userFiles.userId,
          })
          .from(userFiles)
          .innerJoin(chatThreads, eq(userFiles.threadId, chatThreads.id))
          .where(cursor === null ? undefined : gt(userFiles.id, cursor))
          .orderBy(asc(userFiles.id))
          .limit(PAGE_SIZE),
    );
    const objects: Pick<FileUsageInput, "organizationId" | "objectKey">[] = [];
    for (const file of files) {
      const organizationId = brandPersistedOrganizationId(file.organizationId);
      objects.push({ organizationId, objectKey: file.s3Key });
      if (file.thumbnailFileId) {
        objects.push({
          organizationId,
          objectKey: createUserFileKey({
            fileId: file.thumbnailFileId,
            mimeType: THUMBNAIL_MIME_TYPE,
            userId: brandPersistedUserId(file.userId),
          }),
        });
      }
    }
    return { files, imported: await importObjectPage(objects) };
  };

  let orgCursor: SafeId<"organization"> | null = null;
  let imported = 0;
  let settledReservations = 0;
  let mismatchedReservations = 0;
  while (true) {
    // db-await-in-loop: the previous organization page's last ID supplies the next page cursor
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
        // db-await-in-loop: each bounded S3 object page is imported in one accounting statement before advancing its key cursor
        imported += await importObjectPage(
          page.objects.map(({ key }) => ({ organizationId, objectKey: key })),
        );
        keyCursor = page.objects.at(-1)?.key ?? null;
        if (!page.truncated) {
          break;
        }
        if (keyCursor === null) {
          panic("Object listing ended without a cursor");
        }
      }
    }
    const lastOrganization = organizations.at(-1);
    orgCursor =
      lastOrganization === undefined
        ? null
        : brandPersistedOrganizationId(lastOrganization.id);
  }
  // User-scoped object keys have no organization prefix. Scan their rows once
  // through the global primary key; joining a tenant filter would force each
  // organization to rescan other organizations' files on every page.
  let fileCursor: SafeId<"userFile"> | null = null;
  while (true) {
    // db-await-in-loop: each global file page is read and imported once before its last id supplies the next cursor
    const page = await importUserFilePage(fileCursor);
    imported += page.imported;
    const { files } = page;
    if (files.length === 0) {
      break;
    }
    const lastFile = files.at(-1);
    fileCursor =
      lastFile === undefined ? null : brandPersistedUserFileId(lastFile.id);
    if (files.length < PAGE_SIZE) {
      break;
    }
  }

  const removed = await reconcileAbsentOrganizationFileObjects({
    db: ledgerDb,
    objectExists: async (key) => (await readObjectSize(key)) !== null,
    staleBefore: new Date(
      Temporal.Now.instant().epochMilliseconds - RESERVATION_STALE_AFTER_MS,
    ),
  });
  let settledBatch;
  do {
    // db-await-in-loop: each global pending-reservation page settles before the next page is claimed
    const batch = await reconcileAbandonedOrganizationFileReservations({
      db: ledgerDb,
    });
    settledBatch = batch.unwrap(
      "Reservation reconciliation must succeed during backfill",
    );
    settledReservations +=
      settledBatch.committed + settledBatch.deleted + settledBatch.released;
    mismatchedReservations += settledBatch.mismatched;
  } while (
    settledBatch.scanned === ORGANIZATION_FILE_RESERVATION_RECONCILE_BATCH_LIMIT
  );

  const unexpectedUnsettled = await reportOrganizationFileUsageBackfill({
    counts: {
      imported,
      removed,
      settledReservations,
      mismatchedReservations,
    },
    db: ledgerDb,
    log: (line) => console.log(line),
  });
  if (unexpectedUnsettled > 0) {
    panic(
      `File usage backfill left ${unexpectedUnsettled} unsettled writes beyond ${mismatchedReservations} mismatched reservations; reconcile before enabling`,
    );
  }
});
