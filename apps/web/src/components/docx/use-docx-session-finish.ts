import { useCallback } from "react";
import type { RefObject } from "react";

import { Result, TaggedError } from "better-result";
import { useTranslations } from "use-intl";

import type { DocxEditorRef } from "@stll/folio-react";
import { stellaToast } from "@stll/ui/toast";

import { useReviewStore } from "@/components/ai-suggestions/review-store";
import { getAnalytics } from "@/lib/analytics/provider";

import { shouldFinalizeEditSession } from "./docx-browser-editor.logic";
import type {
  DocxPreviewFile,
  OptimisticPreviewFile,
  PreservedLoadedBuffer,
} from "./docx-browser-editor.logic";
import type { AutosaveStatus } from "./docx-edit-mode.logic";
import type { DocxBrowserCollaboration } from "./use-docx-browser-collaboration";
import { useEditSession } from "./use-edit-session";
import type { EditSession } from "./use-edit-session";

class CollaborationCloseCutError extends TaggedError(
  "CollaborationCloseCutError",
)<{
  message: string;
}> {}

type UseDocxEditSessionOptions = {
  entityId: string;
  fieldId: string;
  finalizedBufferRef: RefObject<ArrayBuffer | null>;
  onClose: () => void;
  onSaved: ((fieldId: string) => void) | undefined;
  optimisticPreviewRef: RefObject<OptimisticPreviewFile | null>;
  preservedLoadedBufferRef: RefObject<PreservedLoadedBuffer | null>;
  previewFile: DocxPreviewFile | null;
  propertyId: string;
  workspaceId: string;
};

/**
 * The local edit session. A finalize hands the bytes it saved to the
 * optimistic preview, keyed by the new version's field, so the editor keeps
 * showing them while the preview refetches.
 */
export const useDocxEditSession = ({
  entityId,
  fieldId,
  finalizedBufferRef,
  onClose,
  onSaved,
  optimisticPreviewRef,
  preservedLoadedBufferRef,
  previewFile,
  propertyId,
  workspaceId,
}: UseDocxEditSessionOptions) =>
  useEditSession({
    workspaceId,
    entityId,
    fieldId,
    propertyId,
    initialBuffer: previewFile?.buffer,
    onFinalized: (result) => {
      if (result.outcome === "finalized") {
        const finalizedBuffer = finalizedBufferRef.current;
        if (finalizedBuffer !== null && previewFile !== null) {
          optimisticPreviewRef.current = {
            fieldId: result.fieldId,
            file: {
              ...previewFile,
              buffer: finalizedBuffer,
            },
          };
        }
        const preservedLoadedBuffer = preservedLoadedBufferRef.current;
        if (preservedLoadedBuffer !== null) {
          preservedLoadedBufferRef.current = {
            ...preservedLoadedBuffer,
            fieldId: result.fieldId,
          };
        }
        onSaved?.(result.fieldId);
      }
      finalizedBufferRef.current = null;
      onClose();
    },
    onCancelled: onClose,
  });

type UseDocxSessionFinishOptions = {
  clearQueuedChangeCheckpoint: () => void;
  collaboration: DocxBrowserCollaboration;
  editSession: EditSession;
  editorRef: RefObject<DocxEditorRef | null>;
  entityId: string;
  fieldId: string;
  /** Receives the saved bytes until the finalize callback takes them. */
  finalizedBufferRef: RefObject<ArrayBuffer | null>;
  hasSessionChangesRef: RefObject<boolean>;
  lastEditingBufferRef: RefObject<ArrayBuffer | null>;
  onClose: () => void;
  optimisticPreviewRef: RefObject<OptimisticPreviewFile | null>;
  preservedLoadedBufferRef: RefObject<PreservedLoadedBuffer | null>;
  previewFile: DocxPreviewFile | null;
  setAutosaveStatus: (status: AutosaveStatus) => void;
};

/**
 * Ends the active session: finalize saves the document and creates a version
 * (a published version for a collaboration room), cancel leaves without one.
 */
export const useDocxSessionFinish = ({
  clearQueuedChangeCheckpoint,
  collaboration,
  editSession,
  editorRef,
  entityId,
  fieldId,
  finalizedBufferRef,
  hasSessionChangesRef,
  lastEditingBufferRef,
  onClose,
  optimisticPreviewRef,
  preservedLoadedBufferRef,
  previewFile,
  setAutosaveStatus,
}: UseDocxSessionFinishOptions) => {
  const {
    cancelCollaboration,
    collaborationSession,
    collaborationState,
    isCollaborativeEditing,
    publishCollaborationVersion,
  } = collaboration;
  const {
    cancel: cancelDesktopSession,
    finalize: finalizeActiveSession,
    isDirty,
    saveCheckpoint: saveActiveCheckpoint,
  } = editSession;
  const t = useTranslations();

  const cancelActiveSession = useCallback(async () => {
    if (collaborationSession !== null) {
      if (collaborationState.status === "readOnly") {
        cancelCollaboration();
        onClose();
        return;
      }
      const flushResult = await Result.tryPromise(
        async () => await collaborationSession.flushSnapshot(),
      );
      if (Result.isError(flushResult)) {
        getAnalytics().captureError(flushResult.error);
        stellaToast.error(t("folio.networkError"));
        throw flushResult.error;
      }
      if (
        flushResult.value.localMutationRevision !==
        collaborationSession.getLocalMutationRevision()
      ) {
        const error = new CollaborationCloseCutError({
          message: "The local collaboration state changed during close.",
        });
        getAnalytics().captureError(error);
        stellaToast.error(t("folio.networkError"));
        throw error;
      }
      cancelCollaboration();
      onClose();
      return;
    }

    const cancelResult = await Result.tryPromise(
      async () => await cancelDesktopSession(),
    );
    if (Result.isError(cancelResult)) {
      stellaToast.error(t("folio.networkError"));
      throw cancelResult.error;
    }
  }, [
    cancelCollaboration,
    cancelDesktopSession,
    collaborationSession,
    collaborationState.status,
    onClose,
    t,
  ]);

  const handleFinalize = useCallback(async () => {
    // Soft, non-blocking reminder: if AI suggestions are still pending
    // for this entity, note it once before finalizing. Purely
    // informational — finalize proceeds either way (the suggestions
    // persist and can be reviewed after).
    const pendingSuggestionCount =
      useReviewStore
        .getState()
        .sessions[entityId]?.filter((s) => s.status === "pending").length ?? 0;
    if (pendingSuggestionCount > 0) {
      stellaToast.info(
        t("docxReview.finalizePendingNote", {
          count: pendingSuggestionCount,
        }),
      );
    }

    if (isCollaborativeEditing) {
      clearQueuedChangeCheckpoint();
      return await publishCollaborationVersion();
    }

    // Save the final version before finalizing
    clearQueuedChangeCheckpoint();

    const ref = editorRef.current;
    if (!ref) {
      stellaToast.add({
        description: t("folio.saveEditorUnavailableDescription"),
        title: t("folio.saveEditorUnavailableTitle"),
        type: "error",
      });
      return false;
    }

    const hasPendingEditorChanges = ref.hasPendingChanges();
    if (
      !shouldFinalizeEditSession({
        isDirty,
        hasSessionChanges: hasSessionChangesRef.current,
        hasPendingEditorChanges,
      })
    ) {
      await cancelActiveSession();
      return true;
    }

    const buffer = await ref.save({ selective: true });
    if (!buffer) {
      stellaToast.add({
        description: t("folio.saveSerializeFailedDescription"),
        title: t("folio.saveSerializeFailedTitle"),
        type: "error",
      });
      return false;
    }

    setAutosaveStatus("syncing");
    const checkpoint = await saveActiveCheckpoint(buffer);
    if (checkpoint !== "saved") {
      setAutosaveStatus("pending");
      // A session taken over mid-save has nowhere to retry to; its banner
      // already says the document is read-only here.
      if (checkpoint === "failed") {
        stellaToast.add({
          description: t("folio.saveCheckpointFailedDescription"),
          title: t("folio.saveCheckpointFailedTitle"),
          type: "error",
        });
      }
      return false;
    }
    setAutosaveStatus("synced");
    if (previewFile !== null) {
      optimisticPreviewRef.current = {
        fieldId,
        file: {
          ...previewFile,
          buffer,
        },
      };
    }
    if (lastEditingBufferRef.current !== null) {
      preservedLoadedBufferRef.current = {
        fieldId,
        buffer: lastEditingBufferRef.current,
      };
    }
    finalizedBufferRef.current = buffer;
    hasSessionChangesRef.current = false;
    return await finalizeActiveSession();
  }, [
    cancelActiveSession,
    clearQueuedChangeCheckpoint,
    editorRef,
    entityId,
    fieldId,
    finalizeActiveSession,
    finalizedBufferRef,
    hasSessionChangesRef,
    isCollaborativeEditing,
    publishCollaborationVersion,
    isDirty,
    lastEditingBufferRef,
    optimisticPreviewRef,
    preservedLoadedBufferRef,
    previewFile,
    saveActiveCheckpoint,
    setAutosaveStatus,
    t,
  ]);

  const handleCancel = useCallback(async () => {
    clearQueuedChangeCheckpoint();
    await cancelActiveSession();
    preservedLoadedBufferRef.current = null;
    hasSessionChangesRef.current = false;
  }, [
    cancelActiveSession,
    clearQueuedChangeCheckpoint,
    hasSessionChangesRef,
    preservedLoadedBufferRef,
  ]);

  return { handleCancel, handleFinalize };
};
