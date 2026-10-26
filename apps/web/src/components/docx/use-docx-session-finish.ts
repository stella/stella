import { useCallback } from "react";
import type { RefObject } from "react";

import { panic, Result, TaggedError } from "better-result";
import { useTranslations } from "use-intl";

import type { DocxEditorRef } from "@stll/folio-react";
import { stellaToast } from "@stll/ui/toast";

import { useReviewStore } from "@/components/ai-suggestions/review-store";
import { getTranslator } from "@/i18n/translator";
import type { TranslationKey } from "@/i18n/types";
import { getAnalytics } from "@/lib/analytics/provider";
import { notifyUserError } from "@/lib/errors/user-toast";

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
import { checkpointLeaveAction } from "./use-edit-session.logic";

class CollaborationCloseCutError extends TaggedError(
  "CollaborationCloseCutError",
)<{
  message: string;
}> {}

/** Why the editor could not hand over a document to save. */
class DocxSaveUnavailableError extends TaggedError("DocxSaveUnavailableError")<{
  reason: "editorUnmounted" | "serializeFailed";
  message: string;
}> {}

const SAVE_UNAVAILABLE = {
  editorUnmounted: {
    message: "The editor closed before its changes were saved.",
    title: "folio.saveEditorUnavailableTitle",
    description: "folio.saveEditorUnavailableDescription",
  },
  serializeFailed: {
    message: "The editor could not serialize the document.",
    title: "folio.saveSerializeFailedTitle",
    description: "folio.saveSerializeFailedDescription",
  },
} as const satisfies Record<
  DocxSaveUnavailableError["reason"],
  { message: string; title: TranslationKey; description: TranslationKey }
>;

const notifySaveUnavailable = (reason: DocxSaveUnavailableError["reason"]) => {
  const { message, title, description } = SAVE_UNAVAILABLE[reason];
  const t = getTranslator();
  notifyUserError(new DocxSaveUnavailableError({ reason, message }), t(title), {
    description: t(description),
  });
};

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
        getAnalytics().captureError(flushResult.error, {
          fingerprintKey: "useDocxSessionFinish:failure",
          scope: { type: "handler", handlerId: "useDocxSessionFinish:failure" },
        });
        notifyUserError(flushResult.error, t("folio.networkError"));
        throw flushResult.error;
      }
      if (
        flushResult.value.localMutationRevision !==
        collaborationSession.getLocalMutationRevision()
      ) {
        const error = new CollaborationCloseCutError({
          message: "The local collaboration state changed during close.",
        });
        getAnalytics().captureError(error, {
          fingerprintKey: "useDocxSessionFinish:failure-2",
          scope: {
            type: "handler",
            handlerId: "useDocxSessionFinish:failure-2",
          },
        });
        notifyUserError(error, t("folio.networkError"));
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
      notifyUserError(cancelResult.error, t("folio.networkError"));
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
    if (
      !shouldFinalizeEditSession({
        isDirty,
        hasSessionChanges: hasSessionChangesRef.current,
        hasPendingEditorChanges: ref?.hasPendingChanges() ?? false,
      })
    ) {
      await cancelActiveSession();
      return true;
    }
    // Changes were made, but the editor holding them is gone.
    if (!ref) {
      notifySaveUnavailable("editorUnmounted");
      return false;
    }

    const buffer = await ref.save({ selective: true });
    if (!buffer) {
      notifySaveUnavailable("serializeFailed");
      return false;
    }

    setAutosaveStatus("syncing");
    const leave = checkpointLeaveAction(await saveActiveCheckpoint(buffer), {
      userEdited: hasSessionChangesRef.current,
    });
    switch (leave.type) {
      case "finalize":
        break;
      case "close":
        setAutosaveStatus("synced");
        await cancelActiveSession();
        return true;
      case "stay":
        setAutosaveStatus("pending");
        return false;
      case "report":
        setAutosaveStatus("pending");
        notifyUserError(leave.error, t("folio.saveCheckpointFailedTitle"), {
          description: t("folio.saveCheckpointFailedDescription"),
        });
        return false;
      default:
        leave satisfies never;
        return panic("Unhandled leave action");
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
