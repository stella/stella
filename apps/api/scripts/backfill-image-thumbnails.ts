import { panic, Result, TaggedError } from "better-result";
/**
 * Backfill image thumbnails + blur placeholders for uploads that predate the
 * thumbnail feature. Two independent passes:
 *
 *  - Entity file fields: enqueue async `generate-thumbnail` jobs; the
 *    file-derivative worker produces the WebP + placeholder. The BullMQ
 *    jobId dedupes, so a re-run never double-processes.
 *  - Chat user files: generate inline (read source from S3, resize, write the
 *    WebP, patch the row) since chat thumbnails are not queue-driven.
 *
 * Both passes are idempotent and resumable: only rows still missing a
 * thumbnail are touched, and each pass walks the primary key with keyset
 * pagination so concurrent completion never causes a skip.
 *
 * Usage:
 *   bun apps/api/scripts/backfill-image-thumbnails.ts          # both passes
 *   bun apps/api/scripts/backfill-image-thumbnails.ts entities # entity fields only
 *   bun apps/api/scripts/backfill-image-thumbnails.ts chat     # chat files only
 */
import { and, inArray, isNull, sql } from "drizzle-orm";

import { printError } from "@stll/errors";

import { userFiles } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { openMaintenanceDb } from "@/api/lib/db/maintenance-db";
import { isDeploymentFeatureEnabled } from "@/api/lib/deployment-feature";
import { enqueueImageThumbnailOrMarkFailed } from "@/api/lib/file-derivative-queue";
import {
  generateImageThumbnail,
  THUMBNAIL_MIME_TYPE,
} from "@/api/lib/files/image-derivative";
import {
  type CheckedFileWrite,
  removeOrganizationFilesBytes,
  writeOrganizationFiles,
} from "@/api/lib/files/organization-file-usage";
import { createUserFileKey } from "@/api/lib/files/utils";
import {
  deleteS3ObjectWithSignal,
  readS3ArrayBuffer,
  writeS3ObjectWithRetry,
} from "@/api/lib/s3";
import {
  brandPersistedEntityId,
  brandPersistedFieldId,
  brandPersistedOrganizationId,
  brandPersistedUserId,
  brandValidatedWorkflowActorKey,
} from "@/api/lib/safe-id-boundaries";
import { sqlCaseFragment } from "@/api/lib/sql-case-expression";

import { buildChatThumbnailQuery } from "./backfill-image-thumbnails.helpers";

class ThumbnailBackfillWriteError extends TaggedError(
  "ThumbnailBackfillWriteError",
)<{ message: string; cause: unknown }> {}

const BATCH_SIZE = 200;

const db = openMaintenanceDb({ readOnly: false });

type EntityFieldRow = {
  field_id: string;
  mime_type: string;
  encrypted: boolean;
  entity_id: string;
  user_id: string;
  workspace_id: string;
  organization_id: string;
};

/** Bounds the cleanup delete; a stuck socket must not stall the backfill. */
const THUMBNAIL_CLEANUP_TIMEOUT_MS = 15_000;

const deleteThumbnailsBestEffort = async (thumbnailKeys: string[]) => {
  const deletedKeys: string[] = [];
  for (const thumbnailKey of thumbnailKeys) {
    const cleanup = await Result.tryPromise({
      try: async () =>
        await deleteS3ObjectWithSignal(
          thumbnailKey,
          AbortSignal.timeout(THUMBNAIL_CLEANUP_TIMEOUT_MS),
        ),
      catch: (cause) => cause,
    });
    if (Result.isError(cleanup)) {
      console.warn(`  chat: thumbnail cleanup failed for ${thumbnailKey}`);
      continue;
    }
    deletedKeys.push(thumbnailKey);
  }
  const removed = await removeOrganizationFilesBytes(deletedKeys);
  if (Result.isError(removed)) {
    throw removed.error;
  }
};

const backfillEntityFields = async (): Promise<number> => {
  let cursor: string | null = null;
  let enqueued = 0;

  for (;;) {
    // Sequential keyset pagination: the next page cursor depends on this batch.
    const batch: Iterable<EntityFieldRow> =
      // db-await-in-loop: keyset page per iteration; the page is the batch
      await db.execute<EntityFieldRow>(sql`
      SELECT
        f.id AS field_id,
        f.content->>'mimeType' AS mime_type,
        coalesce((f.content->>'encrypted')::boolean, false) AS encrypted,
        e.id AS entity_id,
        e.created_by AS user_id,
        e.workspace_id AS workspace_id,
        w.organization_id AS organization_id
      FROM fields f
      JOIN entity_versions ev ON ev.id = f.entity_version_id
      JOIN entities e ON e.id = ev.entity_id AND e.current_version_id = f.entity_version_id
      JOIN workspaces w ON w.id = e.workspace_id
      WHERE f.content->>'type' = 'file'
        AND f.content->>'thumbnailFileId' IS NULL
        AND coalesce(f.content->'thumbnailDerivative'->>'status', 'pending') = 'pending'
        AND f.content->>'mimeType' IN ('image/jpeg', 'image/png', 'image/gif', 'image/webp')
        AND coalesce((f.content->>'encrypted')::boolean, false) = false
        ${cursor ? sql`AND f.id > ${cursor}` : sql``}
      ORDER BY f.id ASC
      LIMIT ${BATCH_SIZE}
      `);

    const rows: EntityFieldRow[] = [...batch];
    if (rows.length === 0) {
      break;
    }

    for (const row of rows) {
      const actor = brandValidatedWorkflowActorKey({
        organizationId: row.organization_id,
        workspaceId: row.workspace_id,
      });
      await enqueueImageThumbnailOrMarkFailed({
        encrypted: row.encrypted,
        entityId: brandPersistedEntityId(row.entity_id),
        fieldId: brandPersistedFieldId(row.field_id),
        mimeType: row.mime_type,
        organizationId: actor.organizationId,
        userId: brandPersistedUserId(row.user_id),
        workspaceId: actor.workspaceId,
      });
      enqueued += 1;
    }

    const lastRow: EntityFieldRow | undefined = rows.at(-1);
    if (!lastRow) {
      break;
    }
    cursor = lastRow.field_id;
    console.log(`  entities: ${enqueued} job(s) enqueued so far...`);
  }

  return enqueued;
};

const readChatFilePage = async (cursor: SafeId<"userFile"> | null) =>
  await db.transaction(
    async (tx) =>
      await buildChatThumbnailQuery(
        tx,
        cursor,
        isDeploymentFeatureEnabled("FEATURE_FILE_USAGE_LIMITS"),
      ),
  );

type PreparedThumbnail = {
  rowId: SafeId<"userFile">;
  thumbnailFileId: string;
  thumbnailKey: string;
  webp: Uint8Array;
  placeholder: string;
  organizationId: SafeId<"organization"> | null;
};

const backfillChatFilePage = async (
  rows: Awaited<ReturnType<typeof readChatFilePage>>,
): Promise<number> => {
  const prepared: PreparedThumbnail[] = [];
  for (const row of rows) {
    const source = await Result.tryPromise({
      try: async () => new Uint8Array(await readS3ArrayBuffer(row.s3Key)),
      catch: (cause) => cause,
    });
    if (Result.isError(source)) {
      console.warn(`  chat: skip ${row.id} (source read failed)`);
      continue;
    }
    const thumbnail = await generateImageThumbnail(source.value);
    if (Result.isError(thumbnail)) {
      console.warn(`  chat: skip ${row.id} (generate failed)`);
      continue;
    }
    const thumbnailFileId = Bun.randomUUIDv7();
    const thumbnailKey = createUserFileKey({
      fileId: thumbnailFileId,
      mimeType: THUMBNAIL_MIME_TYPE,
      userId: brandPersistedUserId(row.userId),
    });
    let organizationId: SafeId<"organization"> | null = null;
    if (isDeploymentFeatureEnabled("FEATURE_FILE_USAGE_LIMITS")) {
      if (
        !("organizationId" in row) ||
        typeof row.organizationId !== "string"
      ) {
        return panic("Tracked chat thumbnail query omitted organization id");
      }
      organizationId = brandPersistedOrganizationId(row.organizationId);
    }
    prepared.push({
      rowId: row.id,
      thumbnailFileId,
      thumbnailKey,
      webp: thumbnail.value.webp,
      placeholder: thumbnail.value.placeholder,
      organizationId,
    });
  }
  if (prepared.length === 0) {
    return 0;
  }
  const write = async (thumbnail: PreparedThumbnail) =>
    await writeS3ObjectWithRetry(
      {
        contentType: THUMBNAIL_MIME_TYPE,
        data: thumbnail.webp,
        key: thumbnail.thumbnailKey,
      },
      { type: "derivative", source: thumbnail.rowId },
    );
  const written = await (async () => {
    if (isDeploymentFeatureEnabled("FEATURE_FILE_USAGE_LIMITS")) {
      return await writeOrganizationFiles(
        prepared.map((thumbnail) => ({
          organizationId:
            thumbnail.organizationId ??
            panic("Tracked thumbnail has no organization"),
          objectKey: thumbnail.thumbnailKey,
          sizeBytes: thumbnail.webp.byteLength,
          content: thumbnail,
          write: async ({ content }: CheckedFileWrite<PreparedThumbnail>) =>
            await write(content),
        })),
      );
    }
    const results = [];
    for (const thumbnail of prepared) {
      results.push(
        await Result.tryPromise({
          try: async () => await write(thumbnail),
          catch: (cause) =>
            new ThumbnailBackfillWriteError({
              message: "Thumbnail backfill write failed",
              cause,
            }),
        }),
      );
    }
    return Result.ok(results);
  })();
  if (written.status === "error") {
    await deleteThumbnailsBestEffort(
      prepared.map((thumbnail) => thumbnail.thumbnailKey),
    );
    throw written.error;
  }
  const successful: PreparedThumbnail[] = [];
  const failedKeys: string[] = [];
  let failure: Error | undefined;
  for (const [index, outcome] of written.value.entries()) {
    const thumbnail = prepared.at(index);
    if (!thumbnail) {
      return panic("Thumbnail outcome must match its input");
    }
    if (outcome.status === "error") {
      failedKeys.push(thumbnail.thumbnailKey);
      failure ??= outcome.error;
    } else {
      successful.push(thumbnail);
    }
  }
  await deleteThumbnailsBestEffort(failedKeys);
  if (successful.length === 0) {
    throw failure ?? panic("Thumbnail batch has no outcomes");
  }
  const updated = await Result.tryPromise({
    try: async () =>
      await db.transaction(
        async (tx) =>
          await tx
            .update(userFiles)
            .set({
              thumbnailFileId: sqlCaseFragment({
                operand: sql`${userFiles.id}`,
                branches: successful.map(
                  (thumbnail) =>
                    sql`WHEN ${thumbnail.rowId}::uuid THEN ${thumbnail.thumbnailFileId}::text`,
                ),
                fallback: sql`${userFiles.thumbnailFileId}`,
              }),
              placeholder: sqlCaseFragment({
                operand: sql`${userFiles.id}`,
                branches: successful.map(
                  (thumbnail) =>
                    sql`WHEN ${thumbnail.rowId}::uuid THEN ${thumbnail.placeholder}::text`,
                ),
                fallback: sql`${userFiles.placeholder}`,
              }),
            })
            .where(
              and(
                inArray(
                  userFiles.id,
                  successful.map((thumbnail) => thumbnail.rowId),
                ),
                isNull(userFiles.thumbnailFileId),
              ),
            )
            .returning({ id: userFiles.id }),
      ),
    catch: (cause) => cause,
  });
  if (Result.isError(updated)) {
    await deleteThumbnailsBestEffort(
      successful.map((thumbnail) => thumbnail.thumbnailKey),
    );
    throw updated.error;
  }
  const updatedIds = new Set(updated.value.map((row) => row.id));
  await deleteThumbnailsBestEffort(
    successful
      .filter((thumbnail) => !updatedIds.has(thumbnail.rowId))
      .map((thumbnail) => thumbnail.thumbnailKey),
  );
  if (failure) {
    throw failure;
  }
  return updated.value.length;
};

const backfillChatFiles = async (): Promise<number> => {
  let cursor: SafeId<"userFile"> | null = null;
  let generated = 0;
  for (;;) {
    // db-await-in-loop: keyset page per iteration; the page is the batch
    const rows = await readChatFilePage(cursor);
    if (rows.length === 0) {
      break;
    }
    // db-await-in-loop: one bounded thumbnail page; reserve, settle, and publish progress in batches
    generated += await backfillChatFilePage(rows);
    const lastRow = rows.at(-1);
    if (!lastRow) {
      break;
    }
    cursor = lastRow.id;
    console.log(`  chat: ${generated} thumbnail(s) generated so far...`);
  }
  return generated;
};

const main = async () => {
  const mode = process.argv[2] ?? "both";

  if (mode === "entities" || mode === "both") {
    console.log("Enqueuing entity-field thumbnail jobs...");
    const enqueued = await backfillEntityFields();
    console.log(`Entity backfill complete: ${enqueued} job(s) enqueued.`);
  }

  if (mode === "chat" || mode === "both") {
    console.log("Generating chat user-file thumbnails...");
    const generated = await backfillChatFiles();
    console.log(`Chat backfill complete: ${generated} thumbnail(s) generated.`);
  }

  process.exit(0);
};

main().catch((error: unknown) => {
  printError("Image thumbnail backfill failed:", error);
  process.exit(1);
});
