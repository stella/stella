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

import { Result } from "better-result";
import { and, asc, eq, gt, inArray, isNull, sql } from "drizzle-orm";

import { rootDb } from "@/api/db/root";
import { userFiles } from "@/api/db/schema";
import {
  generateImageThumbnail,
  THUMBNAIL_MIME_TYPE,
} from "@/api/handlers/files/image-derivative";
import { createUserFileKey } from "@/api/handlers/files/utils";
import { enqueueImageThumbnailOrMarkFailed } from "@/api/lib/file-derivative-queue";
import { getS3 } from "@/api/lib/s3";
import {
  brandPersistedEntityId,
  brandPersistedFieldId,
  brandPersistedUserId,
  brandValidatedWorkflowActorKey,
} from "@/api/lib/safe-id-boundaries";

const BATCH_SIZE = 200;

const THUMBNAILABLE_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
];

type EntityFieldRow = {
  field_id: string;
  mime_type: string;
  encrypted: boolean;
  entity_id: string;
  user_id: string;
  workspace_id: string;
  organization_id: string;
};

const backfillEntityFields = async (): Promise<number> => {
  let cursor = "";
  let enqueued = 0;

  for (;;) {
    const batch = await rootDb.execute<EntityFieldRow>(sql`
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
        AND f.id > ${cursor}
      ORDER BY f.id ASC
      LIMIT ${BATCH_SIZE}
    `);

    const rows = [...batch];
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

    cursor = rows[rows.length - 1].field_id;
    console.log(`  entities: ${enqueued} job(s) enqueued so far...`);
  }

  return enqueued;
};

const backfillChatFiles = async (): Promise<number> => {
  let cursor = "";
  let generated = 0;

  for (;;) {
    const rows = await rootDb
      .select({
        id: userFiles.id,
        userId: userFiles.userId,
        mimeType: userFiles.mimeType,
        s3Key: userFiles.s3Key,
      })
      .from(userFiles)
      .where(
        and(
          isNull(userFiles.thumbnailFileId),
          inArray(userFiles.mimeType, THUMBNAILABLE_MIME_TYPES),
          gt(userFiles.id, cursor),
        ),
      )
      .orderBy(asc(userFiles.id))
      .limit(BATCH_SIZE);

    if (rows.length === 0) {
      break;
    }

    for (const row of rows) {
      const source = await Result.tryPromise({
        try: async () => await getS3().file(row.s3Key).bytes(),
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
        userId: row.userId,
      });
      await getS3().write(thumbnailKey, thumbnail.value.webp);
      await rootDb
        .update(userFiles)
        .set({ thumbnailFileId, placeholder: thumbnail.value.placeholder })
        .where(eq(userFiles.id, row.id));
      generated += 1;
    }

    cursor = rows[rows.length - 1].id;
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
  console.error("Image thumbnail backfill failed:", error);
  process.exit(1);
});
