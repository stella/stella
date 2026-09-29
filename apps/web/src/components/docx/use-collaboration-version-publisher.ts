import { useCallback, useRef, useState } from "react";
import type { RefObject } from "react";

import { useQueryClient } from "@tanstack/react-query";
import { Result } from "better-result";
import { useFormatter, useTranslations } from "use-intl";

import { stellaToast } from "@stll/ui/toast";

import { getAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { toAPIError } from "@/lib/errors/api";
import { openIsolatedWindow } from "@/lib/open-isolated-window";
import { toSafeId } from "@/lib/safe-id";
import { entitiesKeys } from "@/lib/workspaces/queries/entities";

import { shouldReuseCollaborationPublication } from "./docx-browser-editor.logic";
import type {
  FolioCollaborationRoom,
  FolioCollaborationRoomState,
} from "./use-folio-collaboration-room";

type PendingCollaborationPublication = {
  documentMutationRevision: number;
  downloadUrl: string;
  generation: number;
  idempotencyKey: string;
  roomId: string;
  sha256Hex: string;
};

type PrepareCollaborationPublicationOptions = {
  room: FolioCollaborationRoom;
  workspaceId: string;
};

/**
 * Flushes the room and checkpoints the flushed snapshot. Resolves to `null`
 * once a failure has been captured.
 */
const prepareCollaborationPublication = async ({
  room,
  workspaceId,
}: PrepareCollaborationPublicationOptions) => {
  const flushResult = await Result.tryPromise(
    async () => await room.flushSnapshot(),
  );
  if (Result.isError(flushResult)) {
    getAnalytics().captureError(flushResult.error);
    return null;
  }
  const checkpointResult = await Result.tryPromise(async () =>
    api
      .entities({ workspaceId: toSafeId<"workspace">(workspaceId) })
      ["folio-collab-rooms"].checkpoint.post({
        expectedGeneration: room.generation,
        expectedSnapshotRevision: flushResult.value.snapshotRevision,
        roomId: toSafeId<"folioCollabRoom">(room.roomId),
      }),
  );
  if (Result.isError(checkpointResult)) {
    getAnalytics().captureError(checkpointResult.error);
    return null;
  }
  if (checkpointResult.value.error) {
    getAnalytics().captureError(toAPIError(checkpointResult.value.error));
    return null;
  }

  const checkpoint = checkpointResult.value.data;
  return {
    documentMutationRevision: flushResult.value.documentMutationRevision,
    downloadUrl: checkpoint.downloadUrl,
    generation: checkpoint.generation,
    idempotencyKey: crypto.randomUUID(),
    roomId: room.roomId,
    sha256Hex: checkpoint.sha256Hex,
  };
};

type UseCollaborationVersionPublisherOptions = {
  collaborationSession: FolioCollaborationRoom | null;
  collaborationStatus: FolioCollaborationRoomState["status"];
  hasSessionChangesRef: RefObject<boolean>;
  workspaceId: string;
};

/**
 * Publishes the collaboration room as a new document version. A checkpoint
 * whose publish failed is kept and retried while the room has not moved on,
 * so a retry does not mint a second checkpoint of the same state.
 */
export const useCollaborationVersionPublisher = ({
  collaborationSession,
  collaborationStatus,
  hasSessionChangesRef,
  workspaceId,
}: UseCollaborationVersionPublisherOptions) => {
  const queryClient = useQueryClient();
  const t = useTranslations();
  const format = useFormatter();
  const pendingCollaborationPublicationRef =
    useRef<PendingCollaborationPublication | null>(null);
  const isPublishingCollaborationVersionRef = useRef(false);
  const [
    isPublishingCollaborationVersion,
    setIsPublishingCollaborationVersion,
  ] = useState(false);

  const publishCollaborationVersion = useCallback(async () => {
    if (
      collaborationSession === null ||
      collaborationStatus !== "synced" ||
      isPublishingCollaborationVersion ||
      isPublishingCollaborationVersionRef.current
    ) {
      return false;
    }

    isPublishingCollaborationVersionRef.current = true;
    setIsPublishingCollaborationVersion(true);
    const finishPublishing = () => {
      isPublishingCollaborationVersionRef.current = false;
      setIsPublishingCollaborationVersion(false);
    };
    let pendingPublication = pendingCollaborationPublicationRef.current;
    if (
      pendingPublication !== null &&
      !shouldReuseCollaborationPublication({
        current: {
          documentMutationRevision:
            collaborationSession.getDocumentMutationRevision(),
          generation: collaborationSession.generation,
          roomId: collaborationSession.roomId,
        },
        pending: pendingPublication,
      })
    ) {
      pendingCollaborationPublicationRef.current = null;
      pendingPublication = null;
    }
    if (pendingPublication === null) {
      pendingPublication = await prepareCollaborationPublication({
        room: collaborationSession,
        workspaceId,
      });
      if (pendingPublication === null) {
        finishPublishing();
        stellaToast.add({
          description: t("folio.createVersionFailedDescription"),
          title: t("folio.createVersionFailedTitle"),
          type: "error",
        });
        return false;
      }
      pendingCollaborationPublicationRef.current = pendingPublication;
    }
    const publishResult = await Result.tryPromise(async () =>
      api
        .entities({ workspaceId: toSafeId<"workspace">(workspaceId) })
        ["folio-collab-rooms"]["publish-version"].post({
          expectedGeneration: pendingPublication.generation,
          expectedSha256Hex: pendingPublication.sha256Hex,
          idempotencyKey: pendingPublication.idempotencyKey,
          roomId: toSafeId<"folioCollabRoom">(pendingPublication.roomId),
        }),
    );
    finishPublishing();
    if (Result.isError(publishResult)) {
      getAnalytics().captureError(publishResult.error);
      stellaToast.add({
        description: t("folio.createVersionFailedDescription"),
        title: t("folio.createVersionFailedTitle"),
        type: "error",
      });
      return false;
    }
    if (publishResult.value.error) {
      const apiError = toAPIError(publishResult.value.error);
      getAnalytics().captureError(apiError);
      if (apiError.code === "folio_collab_base_version_changed") {
        pendingCollaborationPublicationRef.current = null;
        stellaToast.add({
          action: {
            label: t("folio.downloadCheckpoint"),
            onClick: () => {
              openIsolatedWindow(pendingPublication.downloadUrl);
            },
          },
          description: t("folio.versionConflictDescription"),
          title: t("folio.versionConflictTitle"),
          type: "warning",
        });
        return false;
      }
      if (
        apiError.code === "folio_collab_checkpoint_changed" ||
        apiError.code === "folio_collab_idempotency_key_reused"
      ) {
        pendingCollaborationPublicationRef.current = null;
      }
      stellaToast.add({
        description: t("folio.createVersionFailedDescription"),
        title: t("folio.createVersionFailedTitle"),
        type: "error",
      });
      return false;
    }

    pendingCollaborationPublicationRef.current = null;
    hasSessionChangesRef.current = false;
    await queryClient.invalidateQueries({
      queryKey: entitiesKeys.all(workspaceId),
    });
    stellaToast.add({
      description: t("folio.versionCreatedDescription", {
        versionNumber: format.number(publishResult.value.data.versionNumber),
      }),
      title: t("folio.versionCreatedTitle"),
      type: "success",
    });
    return true;
  }, [
    collaborationSession,
    collaborationStatus,
    format,
    hasSessionChangesRef,
    isPublishingCollaborationVersion,
    queryClient,
    t,
    workspaceId,
  ]);

  const discardPendingPublication = useCallback(() => {
    pendingCollaborationPublicationRef.current = null;
  }, []);

  return {
    canPublishCollaborationVersion:
      collaborationStatus === "synced" && !isPublishingCollaborationVersion,
    discardPendingPublication,
    publishCollaborationVersion,
  };
};
