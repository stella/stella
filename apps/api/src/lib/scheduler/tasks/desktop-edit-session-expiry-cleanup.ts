import { BUFFER_OBJECT_CLEANUP_INTENT_STATUS } from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import {
  type DesktopEditFileType,
  desktopEditMimeTypeForFileType,
} from "@/api/lib/desktop-edit-file-types";
import { createFileKey } from "@/api/lib/files/utils";

type ExpiredDesktopEditCheckpoint = {
  checkpointFileId: SafeId<"userFile">;
  checkpointSizeBytes: number | null;
  fileType: DesktopEditFileType;
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
};

type BuildDesktopEditCheckpointCleanupIntentsOptions = {
  now: Date;
  sessions: readonly ExpiredDesktopEditCheckpoint[];
};

export const buildDesktopEditCheckpointCleanupIntents = ({
  now,
  sessions,
}: BuildDesktopEditCheckpointCleanupIntentsOptions) =>
  sessions
    .filter(({ checkpointSizeBytes }) => checkpointSizeBytes !== null)
    .map((session) => ({
      id: createSafeId<"pendingUpload">(),
      nextAttemptAt: now,
      objectKey: createFileKey({
        fileId: session.checkpointFileId,
        mimeType: desktopEditMimeTypeForFileType(session.fileType),
        organizationId: session.organizationId,
        workspaceId: session.workspaceId,
      }),
      organizationId: session.organizationId,
      status: BUFFER_OBJECT_CLEANUP_INTENT_STATUS.ORPHANED,
      workspaceId: session.workspaceId,
    }));
