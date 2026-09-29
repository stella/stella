import { and, asc, eq, gt, inArray, isNull } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import { chatThreads, userFiles } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";

const THUMBNAILABLE_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
];

export const buildChatThumbnailQuery = (
  tx: Transaction,
  cursor: SafeId<"userFile"> | null,
  includeOrganization: boolean,
) => {
  const afterCursor = cursor ? gt(userFiles.id, cursor) : undefined;
  const where = and(
    isNull(userFiles.thumbnailFileId),
    inArray(userFiles.mimeType, THUMBNAILABLE_MIME_TYPES),
    afterCursor,
  );

  if (!includeOrganization) {
    return tx
      .select({
        id: userFiles.id,
        userId: userFiles.userId,
        mimeType: userFiles.mimeType,
        s3Key: userFiles.s3Key,
      })
      .from(userFiles)
      .where(where)
      .orderBy(asc(userFiles.id))
      .limit(200);
  }

  return tx
    .select({
      id: userFiles.id,
      userId: userFiles.userId,
      mimeType: userFiles.mimeType,
      s3Key: userFiles.s3Key,
      organizationId: chatThreads.organizationId,
    })
    .from(userFiles)
    .innerJoin(chatThreads, eq(userFiles.threadId, chatThreads.id))
    .where(where)
    .orderBy(asc(userFiles.id))
    .limit(200);
};
