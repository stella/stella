import { useCallback, useRef } from "react";
import type { MouseEvent as ReactMouseEvent, RefObject } from "react";

import { useTranslations } from "use-intl";

import type { DocxCompatibility } from "@stll/folio-react";
import { stellaToast } from "@stll/ui/toast";

import { useInspectorCommandStore } from "@/components/inspector/inspector-command-store";
import { useExternalSyncEffect } from "@/hooks/use-effect";
import { detached } from "@/lib/detached";

import {
  editSessionErrorDescriptionKey,
  getDocxEditBlockReason,
  isDocxEditorUnlocked,
  shouldRequestEditFromMouseDown,
} from "./docx-browser-editor.logic";
import type {
  DocxEditModeResult,
  DocxPreviewFile,
} from "./docx-browser-editor.logic";
import type { DocxBrowserCollaboration } from "./use-docx-browser-collaboration";
import type { EditSession } from "./use-edit-session";
import type { EditSessionState } from "./use-edit-session.logic";

type UseDocxEditOpeningOptions = {
  canUnlock: boolean;
  collaboration: DocxBrowserCollaboration;
  compatibility: DocxCompatibility | null;
  editSession: EditSession;
  fieldId: string;
  isEditing: boolean;
  onBlockedUnlock: (() => void) | undefined;
  onClose: () => void;
  /** Set while an edit request waits for the compatibility probe. */
  pendingEditRequestRef: RefObject<boolean>;
  previewFile: DocxPreviewFile | null;
};

/**
 * Decides when the editor enters edit mode: explicit requests, the unlock
 * gestures on the read-only surface, and the automatic open of a direct
 * editor. Each open is attempted once until the editor leaves edit mode.
 */
export const useDocxEditOpening = ({
  canUnlock,
  collaboration,
  compatibility,
  editSession,
  fieldId,
  isEditing,
  onBlockedUnlock,
  onClose,
  pendingEditRequestRef,
  previewFile,
}: UseDocxEditOpeningOptions) => {
  const {
    canEditCollaboratively,
    collaborationEnabled,
    isCollaborativeEditing,
    requestCollaboration,
  } = collaboration;
  const { open, resetError, state } = editSession;
  const didOpenRef = useRef(false);
  const errorToastShownRef = useRef(false);

  const abandonUnsafeEditAttempt = useCallback(() => {
    // Editing is blocked because Folio can't safely rewrite this DOCX. The
    // block is surfaced quietly on the composer's edit-mode control (a "View
    // only" chip, driven by `docxEditSafety`) instead of a disruptive toast on
    // every attempt; just abandon the attempt and stay in view mode.
    onClose();
  }, [onClose]);

  const requestEditMode = useCallback(async (): Promise<DocxEditModeResult> => {
    if (isCollaborativeEditing) {
      // A joined session can still be read-only, and `isUnlocked` is false
      // then: reporting it as editing sends the caller into an apply the
      // editor silently refuses.
      return canEditCollaboratively
        ? { type: "editing" }
        : { type: "blocked", reason: "collaborationReadOnly" };
    }

    if (state.status === "editing") {
      return { type: "editing" };
    }

    const blockReason = getDocxEditBlockReason({
      canSafelyEdit: compatibility?.canSafelyEdit,
    });
    if (blockReason === "pendingCompatibility") {
      // Don't bother the user with a "still verifying…" toast just
      // because they clicked the doc while the safety probe is in
      // flight. Queue the request via the inspector's pending-edit
      // slot; `use-docx-tab-edit-session` re-runs once
      // `canSafelyEdit` resolves and silently enters edit mode then.
      pendingEditRequestRef.current = true;
      useInspectorCommandStore.getState().requestDocxEdit(fieldId);
      return { type: "blocked", reason: "pendingCompatibility" };
    }

    if (blockReason === "unsafe") {
      abandonUnsafeEditAttempt();
      return { type: "blocked", reason: "unsafe" };
    }

    if (previewFile === null || state.status !== "idle" || didOpenRef.current) {
      return { type: "blocked", reason: "opening" };
    }

    if (collaborationEnabled) {
      requestCollaboration();
      return { type: "blocked", reason: "collaboration" };
    }

    didOpenRef.current = true;
    errorToastShownRef.current = false;
    const opened = await open();
    if (!opened) {
      didOpenRef.current = false;
      return { type: "blocked", reason: "opening" };
    }

    return { type: "editing" };
  }, [
    compatibility?.canSafelyEdit,
    canEditCollaboratively,
    collaborationEnabled,
    fieldId,
    isCollaborativeEditing,
    open,
    pendingEditRequestRef,
    previewFile,
    requestCollaboration,
    abandonUnsafeEditAttempt,
    state.status,
  ]);

  // Taking the session back from the tab that took it: the same open call,
  // which rotates the session token away from that tab in turn.
  const reopenReleasedSession = useCallback(() => {
    didOpenRef.current = true;
    errorToastShownRef.current = false;
    detached(open(), "docx-browser-editor.reopen-released-session");
  }, [open]);

  useExternalSyncEffect(() => {
    if (!pendingEditRequestRef.current) {
      return;
    }
    if (
      compatibility === null ||
      previewFile === null ||
      state.status !== "idle"
    ) {
      return;
    }

    pendingEditRequestRef.current = false;
    detached(requestEditMode(), "docx-browser-editor.request-edit-mode");
  }, [
    compatibility,
    pendingEditRequestRef,
    previewFile,
    requestEditMode,
    state.status,
  ]);

  // Auto-open when this component is used as a direct editor, or when the
  // preview is explicitly unlocked from the shell toolbar.
  useExternalSyncEffect(() => {
    if (!isEditing || previewFile === null || didOpenRef.current) {
      return;
    }
    if (compatibility === null || state.status !== "idle") {
      return;
    }
    if (
      getDocxEditBlockReason({ canSafelyEdit: compatibility.canSafelyEdit }) ===
      "unsafe"
    ) {
      abandonUnsafeEditAttempt();
      return;
    }
    if (collaborationEnabled) {
      return;
    }
    didOpenRef.current = true;
    errorToastShownRef.current = false;
    detached(open(), "docx-browser-editor.open");
  }, [
    compatibility,
    collaborationEnabled,
    isEditing,
    open,
    previewFile,
    abandonUnsafeEditAttempt,
    state.status,
  ]);

  useExternalSyncEffect(() => {
    if (!isEditing) {
      didOpenRef.current = false;
    }
  }, [isEditing]);

  useDocxOpenErrorToast({ errorToastShownRef, onClose, resetError, state });

  const isUnlocked = isDocxEditorUnlocked({ canEditCollaboratively, state });

  const handleUnlock = useCallback(() => {
    if (!canUnlock) {
      onBlockedUnlock?.();
      return;
    }

    const blockReason = getDocxEditBlockReason({
      canSafelyEdit: compatibility?.canSafelyEdit,
    });
    if (blockReason === "pendingCompatibility") {
      // Queue silently — see requestEditMode for rationale.
      pendingEditRequestRef.current = true;
      useInspectorCommandStore.getState().requestDocxEdit(fieldId);
      return;
    }

    if (blockReason === "unsafe") {
      abandonUnsafeEditAttempt();
      return;
    }
    if (collaborationEnabled) {
      requestCollaboration();
      return;
    }
    if (
      previewFile !== null &&
      state.status === "idle" &&
      !didOpenRef.current
    ) {
      didOpenRef.current = true;
      errorToastShownRef.current = false;
      detached(open(), "docx-browser-editor.open");
    }
  }, [
    canUnlock,
    compatibility?.canSafelyEdit,
    collaborationEnabled,
    fieldId,
    onBlockedUnlock,
    open,
    pendingEditRequestRef,
    previewFile,
    requestCollaboration,
    abandonUnsafeEditAttempt,
    state.status,
  ]);

  const { handleLockedEditAttempt, handleReadonlySurfaceMouseDown } =
    useDocxUnlockGestures({ canUnlock, handleUnlock, isUnlocked });

  return {
    didOpenRef,
    handleLockedEditAttempt,
    handleReadonlySurfaceMouseDown,
    isUnlocked,
    reopenReleasedSession,
    requestEditMode,
  };
};

type UseDocxUnlockGesturesOptions = {
  canUnlock: boolean;
  handleUnlock: () => void;
  isUnlocked: boolean;
};

/** Unlocks the read-only document when the reader starts editing it. */
const useDocxUnlockGestures = ({
  canUnlock,
  handleUnlock,
  isUnlocked,
}: UseDocxUnlockGesturesOptions) => {
  const handleLockedEditAttempt = useCallback(() => {
    if (isUnlocked) {
      return;
    }
    handleUnlock();
  }, [handleUnlock, isUnlocked]);

  const handleReadonlySurfaceMouseDown = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      const target = event.target;
      const isToolbarTarget =
        target instanceof Element &&
        target.closest('[role="toolbar"]') !== null;
      if (
        !shouldRequestEditFromMouseDown({
          canUnlock,
          isEditing: isUnlocked,
          isToolbarTarget,
        })
      ) {
        return;
      }

      handleLockedEditAttempt();
    },
    [canUnlock, handleLockedEditAttempt, isUnlocked],
  );

  return { handleLockedEditAttempt, handleReadonlySurfaceMouseDown };
};

type UseDocxOpenErrorToastOptions = {
  /** Set once the failure of the current open attempt was reported. */
  errorToastShownRef: RefObject<boolean>;
  onClose: () => void;
  resetError: () => void;
  state: EditSessionState;
};

/** Reports a failed open once, then closes the editor and clears the error. */
const useDocxOpenErrorToast = ({
  errorToastShownRef,
  onClose,
  resetError,
  state,
}: UseDocxOpenErrorToastOptions) => {
  const t = useTranslations();

  useExternalSyncEffect(() => {
    if (
      state.status !== "error" ||
      (state.source !== "open" && state.source !== "download") ||
      errorToastShownRef.current
    ) {
      return;
    }

    errorToastShownRef.current = true;
    stellaToast.add({
      description: t(editSessionErrorDescriptionKey(state.reason)),
      title: t("folio.editOpenFailedTitle"),
      type: "error",
    });
    onClose();
    resetError();
  }, [errorToastShownRef, onClose, resetError, state, t]);
};
