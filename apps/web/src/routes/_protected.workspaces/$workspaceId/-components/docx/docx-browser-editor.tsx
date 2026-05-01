/**
 * DocxBrowserEditor — wrapper that manages the edit session lifecycle
 * and renders the Folio DocxEditor.
 */

import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { ReactNode, RefObject } from "react";

import type { DocxCompatibility, DocxEditorRef, EditorMode } from "@stll/folio";
import { Button } from "@stll/ui/components/button";
import { toast, toastManager } from "@stll/ui/components/toast";
import { useQuery } from "@tanstack/react-query";
import { CheckIcon } from "lucide-react";
import { useTranslations } from "use-intl";
import "@stll/folio/editor.css";
import { FileViewerWithAI } from "@/components/ai-suggestions/file-viewer-with-ai";
import { QuerySuspenseBoundary } from "@/components/query-suspense-boundary";
import {
  DefaultPendingComponent,
  StatusMessage,
} from "@/components/route-components";
import {
  useDocxFitZoom,
  useDocxWheelZoom,
} from "@/routes/_protected.workspaces/$workspaceId/-components/docx/docx-preview-zoom";
import { fileOptions } from "@/routes/_protected.workspaces/$workspaceId/-components/files/queries";
import "@/routes/_protected.workspaces/$workspaceId/-components/peek/peek-docx.css";
import {
  getDocxEditBlockReason,
  selectEditorBuffer,
  selectPreviewFile,
  shouldFinalizeEditSession,
} from "./docx-browser-editor.logic";
import type { OptimisticPreviewFile } from "./docx-browser-editor.logic";
import type { EditSessionErrorReason } from "./use-edit-session";
import { useEditSession } from "./use-edit-session";

const DocxEditor = lazy(async () => {
  const m = await import("@stll/folio");
  return { default: m.DocxEditor };
});

const CHANGE_CHECKPOINT_DELAY = 5000;

type DocxBrowserEditorBaseProps = {
  workspaceId: string;
  entityId: string;
  fieldId: string;
  propertyId: string;
  initialScrollTop?: number | undefined;
  isEditing?: boolean | undefined;
  onClose: () => void;
  onCompatibilityChange?:
    | ((compatibility: DocxCompatibility) => void)
    | undefined;
  onSaved?: ((fieldId: string) => void) | undefined;
  onPreviewDoubleClick?: (() => void) | undefined;
  onReadonlyEditAttempt?: (() => void) | undefined;
  onScrollTopChange?: ((scrollTop: number) => void) | undefined;
  scaleOffset?: number | undefined;
  actionsKey?: string | undefined;
  actionsMapRef?: RefObject<Map<string, DocxBrowserEditorActions>> | undefined;
  actionsRef?: RefObject<DocxBrowserEditorActions | null> | undefined;
  actionBarControls?: ReactNode | undefined;
  showActionBar?: boolean | undefined;
  errorFallback?: ((props: { reset: () => void }) => ReactNode) | undefined;
  onError?: ((error: Error) => void) | undefined;
};

type DocxBrowserEditorProps = DocxBrowserEditorBaseProps;

export type DocxBrowserEditorActions = {
  cancel: () => Promise<void>;
  finalize: () => void;
  print: () => void;
  unlock: () => void;
};

export const DocxBrowserEditor = (props: DocxBrowserEditorProps) => {
  const { errorFallback, fieldId, onError, workspaceId } = props;

  return (
    <QuerySuspenseBoundary
      area="docx-browser-editor"
      errorFallback={errorFallback ?? defaultDocxBrowserEditorErrorFallback}
      suspenseFallback={<DocxBrowserEditorPendingFallback />}
      onError={onError}
      resetKeys={[workspaceId, fieldId]}
    >
      <DocxBrowserEditorContent {...props} />
    </QuerySuspenseBoundary>
  );
};

const DocxBrowserEditorContent = ({
  workspaceId,
  entityId,
  fieldId,
  propertyId,
  actionsKey,
  actionsMapRef,
  actionsRef,
  actionBarControls,
  isEditing = true,
  initialScrollTop,
  onClose,
  onCompatibilityChange,
  onSaved,
  onPreviewDoubleClick,
  onReadonlyEditAttempt,
  onScrollTopChange,
  scaleOffset = 0,
  showActionBar = true,
}: DocxBrowserEditorProps) => {
  const editorRef = useRef<DocxEditorRef>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const didOpenRef = useRef(false);
  const errorToastShownRef = useRef(false);
  const optimisticPreviewRef = useRef<OptimisticPreviewFile | null>(null);
  const finalizedBufferRef = useRef<ArrayBuffer | null>(null);
  const lastEditingBufferRef = useRef<ArrayBuffer | null>(null);
  const hasSessionChangesRef = useRef(false);
  const preservedLoadedBufferRef = useRef<{
    buffer: ArrayBuffer;
    fieldId: string;
  } | null>(null);
  const changeCheckpointTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const changeCheckpointIdleCallbackRef = useRef<number | null>(null);
  const [editorMode, setEditorMode] = useState<EditorMode>("editing");
  const [compatibility, setCompatibility] = useState<DocxCompatibility | null>(
    null,
  );
  const targetZoom = useDocxFitZoom(containerRef, scaleOffset, 0.85);
  const t = useTranslations();
  const previewPlaceholder =
    optimisticPreviewRef.current?.fieldId === fieldId
      ? optimisticPreviewRef.current.file
      : undefined;
  const previewFileQuery = useQuery({
    ...fileOptions({ workspaceId, fieldId, purpose: "native-display" }),
    ...(previewPlaceholder !== undefined
      ? { placeholderData: previewPlaceholder }
      : {}),
  });

  if (previewFileQuery.error) {
    throw previewFileQuery.error;
  }

  const previewFile = previewFileQuery.data
    ? selectPreviewFile({
        file: previewFileQuery.data,
        optimisticPreview: optimisticPreviewRef.current,
        fieldId,
      })
    : null;

  const {
    state,
    isDirty,
    open,
    markDirty,
    saveCheckpoint,
    finalize,
    cancel,
    resetError,
  } = useEditSession({
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

  useEffect(() => {
    if (optimisticPreviewRef.current?.fieldId === fieldId) {
      return;
    }
    optimisticPreviewRef.current = null;
    finalizedBufferRef.current = null;
    lastEditingBufferRef.current = null;
    hasSessionChangesRef.current = false;
    preservedLoadedBufferRef.current = null;
    setCompatibility(null);
  }, [fieldId]);

  const reportUnsupportedEditAttempt = useCallback(() => {
    toast.warning(t("folio.unsupportedDocxEditTitle"), {
      description: t("folio.unsupportedDocxEditDescription"),
    });
    onClose();
  }, [onClose, t]);

  const reportPendingCompatibility = useCallback(() => {
    toast.info(t("folio.checkingDocxEditTitle"), {
      description: t("folio.checkingDocxEditDescription"),
    });
  }, [t]);

  // Auto-open when this component is used as a direct editor, or when the
  // preview is explicitly unlocked from the shell toolbar.
  useEffect(() => {
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
      reportUnsupportedEditAttempt();
      return;
    }
    didOpenRef.current = true;
    errorToastShownRef.current = false;
    void open();
  }, [
    compatibility,
    isEditing,
    open,
    previewFile,
    reportUnsupportedEditAttempt,
    state.status,
  ]);

  useEffect(() => {
    if (!isEditing) {
      didOpenRef.current = false;
    }
  }, [isEditing]);

  useLayoutEffect(() => {
    editorRef.current?.setZoom(targetZoom);
  }, [targetZoom]);
  useDocxWheelZoom(containerRef, editorRef);

  useEffect(() => {
    if (
      state.status !== "error" ||
      (state.source !== "open" && state.source !== "download") ||
      errorToastShownRef.current
    ) {
      return;
    }

    errorToastShownRef.current = true;
    toastManager.add({
      description: t(editSessionErrorDescriptionKey(state.reason)),
      title: t("folio.editOpenFailedTitle"),
      type: "error",
    });
    onClose();
    resetError();
  }, [onClose, resetError, state, t]);

  const isUnlocked = state.status === "editing";
  const wasUnlockedRef = useRef(false);

  useEffect(() => {
    if (!isUnlocked) {
      wasUnlockedRef.current = false;
      return undefined;
    }

    if (wasUnlockedRef.current) {
      return undefined;
    }

    wasUnlockedRef.current = true;
    const frame = requestAnimationFrame(() => {
      editorRef.current?.focus();
    });

    return () => cancelAnimationFrame(frame);
  }, [isUnlocked]);

  const clearQueuedChangeCheckpoint = useCallback(() => {
    if (changeCheckpointTimerRef.current !== null) {
      clearTimeout(changeCheckpointTimerRef.current);
      changeCheckpointTimerRef.current = null;
    }
    if (changeCheckpointIdleCallbackRef.current !== null) {
      window.cancelIdleCallback(changeCheckpointIdleCallbackRef.current);
      changeCheckpointIdleCallbackRef.current = null;
    }
  }, []);

  const saveChangeCheckpoint = useCallback(() => {
    const ref = editorRef.current;
    if (!ref) {
      return;
    }

    void ref.save({ selective: true }).then((buffer) => {
      if (buffer) {
        void saveCheckpoint(buffer);
      }
    });
  }, [saveCheckpoint]);

  // Cmd+S / Ctrl+S checkpoints only while the document is actively editable.
  useEffect(() => {
    if (!isUnlocked) {
      return undefined;
    }

    const handler = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key !== "s") {
        return;
      }

      e.preventDefault();
      clearQueuedChangeCheckpoint();
      const ref = editorRef.current;
      if (!ref) {
        return;
      }

      void ref.save({ selective: true }).then((buffer) => {
        if (buffer) {
          void saveCheckpoint(buffer);
        }
      });
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [clearQueuedChangeCheckpoint, isUnlocked, saveCheckpoint]);

  useEffect(
    () => () => clearQueuedChangeCheckpoint(),
    [clearQueuedChangeCheckpoint],
  );

  const scheduleChangeCheckpointSave = useCallback(() => {
    changeCheckpointTimerRef.current = setTimeout(() => {
      changeCheckpointTimerRef.current = null;
      changeCheckpointIdleCallbackRef.current = window.requestIdleCallback(
        () => {
          changeCheckpointIdleCallbackRef.current = null;
          saveChangeCheckpoint();
        },
        { timeout: 2000 },
      );
    }, CHANGE_CHECKPOINT_DELAY);
  }, [saveChangeCheckpoint]);

  const handleChange = useCallback(() => {
    if (!isUnlocked) {
      return;
    }

    hasSessionChangesRef.current = true;
    markDirty();
    clearQueuedChangeCheckpoint();
    scheduleChangeCheckpointSave();
  }, [
    clearQueuedChangeCheckpoint,
    isUnlocked,
    markDirty,
    scheduleChangeCheckpointSave,
  ]);

  const handleFinalize = useCallback(async () => {
    // Save the final version before finalizing
    clearQueuedChangeCheckpoint();

    const ref = editorRef.current;
    if (!ref) {
      toastManager.add({
        description: t("folio.saveEditorUnavailableDescription"),
        title: t("folio.saveEditorUnavailableTitle"),
        type: "error",
      });
      return;
    }

    const hasPendingEditorChanges = ref.hasPendingChanges();
    if (
      !shouldFinalizeEditSession({
        isDirty,
        hasSessionChanges: hasSessionChangesRef.current,
        hasPendingEditorChanges,
      })
    ) {
      await cancel();
      return;
    }

    const buffer = await ref.save({ selective: true });
    if (!buffer) {
      toastManager.add({
        description: t("folio.saveSerializeFailedDescription"),
        title: t("folio.saveSerializeFailedTitle"),
        type: "error",
      });
      return;
    }

    const saved = await saveCheckpoint(buffer);
    if (!saved) {
      toastManager.add({
        description: t("folio.saveCheckpointFailedDescription"),
        title: t("folio.saveCheckpointFailedTitle"),
        type: "error",
      });
      return;
    }
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
    await finalize();
  }, [
    cancel,
    clearQueuedChangeCheckpoint,
    fieldId,
    finalize,
    isDirty,
    previewFile,
    saveCheckpoint,
    t,
  ]);

  const handleCancel = useCallback(async () => {
    clearQueuedChangeCheckpoint();
    preservedLoadedBufferRef.current = null;
    hasSessionChangesRef.current = false;
    await cancel();
  }, [cancel, clearQueuedChangeCheckpoint]);

  useEffect(() => {
    const actionsMap = actionsMapRef?.current;
    const actions: DocxBrowserEditorActions = {
      cancel: handleCancel,
      finalize: () => {
        if (state.status === "editing") {
          void handleFinalize();
        }
      },
      print: () => {
        editorRef.current?.print();
      },
      unlock: () => {
        const blockReason = getDocxEditBlockReason({
          canSafelyEdit: compatibility?.canSafelyEdit,
        });
        if (blockReason === "pendingCompatibility") {
          reportPendingCompatibility();
          return;
        }

        if (blockReason === "unsafe") {
          reportUnsupportedEditAttempt();
          return;
        }
        if (
          previewFile !== null &&
          state.status === "idle" &&
          !didOpenRef.current
        ) {
          didOpenRef.current = true;
          errorToastShownRef.current = false;
          void open();
        }
      },
    };

    if (actionsRef) {
      actionsRef.current = actions;
    }
    if (actionsMap && actionsKey) {
      actionsMap.set(actionsKey, actions);
    }

    return () => {
      if (actionsRef?.current === actions) {
        actionsRef.current = null;
      }
      if (actionsMap && actionsKey && actionsMap.get(actionsKey) === actions) {
        actionsMap.delete(actionsKey);
      }
    };
  }, [
    actionsKey,
    actionsMapRef,
    actionsRef,
    compatibility?.canSafelyEdit,
    handleCancel,
    handleFinalize,
    open,
    previewFile,
    reportPendingCompatibility,
    reportUnsupportedEditAttempt,
    state.status,
  ]);

  // Hold the last editing buffer so the editor doesn't swap to the
  // preview buffer during the save transition (`state` becomes
  // "saving" with no buffer of its own). Without this we'd reload the
  // editor against `previewFile.buffer` for the few hundred ms before
  // the parent unmounts us — and the Stella fallback would flash.
  const preservedLoadedBuffer =
    preservedLoadedBufferRef.current?.fieldId === fieldId
      ? preservedLoadedBufferRef.current.buffer
      : null;
  const editorBuffer = selectEditorBuffer(
    state.status === "editing"
      ? {
          status: state.status,
          editingBuffer: state.buffer,
          lastEditingBuffer: lastEditingBufferRef.current,
          preservedLoadedBuffer,
          previewBuffer: previewFile?.buffer,
        }
      : {
          status: state.status,
          lastEditingBuffer: lastEditingBufferRef.current,
          preservedLoadedBuffer,
          previewBuffer: previewFile?.buffer,
        },
  );
  if (state.status === "editing" && editorBuffer !== undefined) {
    lastEditingBufferRef.current = editorBuffer;
    preservedLoadedBufferRef.current = null;
  }

  useEffect(() => {
    if (!isUnlocked) {
      setEditorMode("editing");
    }
  }, [isUnlocked]);

  if (
    state.status === "error" &&
    state.source !== "open" &&
    state.source !== "download"
  ) {
    return (
      <StatusMessage
        actionButton={
          <Button onClick={onClose} size="sm" variant="outline">
            {t("common.close")}
          </Button>
        }
        className="h-full w-full"
        description={t(editSessionErrorDescriptionKey(state.reason))}
        status="error"
        title={t("folio.editSaveFailedTitle")}
      />
    );
  }

  if (previewFile === null || editorBuffer === undefined) {
    return <DocxBrowserEditorPendingFallback />;
  }

  // While the finalize request is in flight we keep the editor
  // mounted so the user sees the document they just saved instead of
  // a transient "Saving…" screen. The component unmounts on
  // `onFinalized` → `onClose`, which makes the close feel instant.

  return (
    <div ref={containerRef} className="flex h-full flex-col">
      {showActionBar && isUnlocked && (
        <div className="flex min-w-0 items-center gap-2 border-b px-3 py-1.5">
          {actionBarControls !== undefined && (
            <div className="flex min-w-0 flex-1 items-center gap-1">
              {actionBarControls}
            </div>
          )}
          <div className="ms-auto flex shrink-0 items-center">
            <Button onClick={() => void handleFinalize()} size="sm">
              <CheckIcon />
              {t("common.save")}
            </Button>
          </div>
        </div>
      )}

      {/* Folio editor with AI overlay */}
      <div
        className="flex-1 overflow-hidden"
        onDoubleClickCapture={isUnlocked ? undefined : onPreviewDoubleClick}
      >
        <FileViewerWithAI
          activeFile={{ entityId, fileName: previewFile.fileName }}
          chatThreadId={entityId}
          workspaceId={workspaceId}
        >
          <Suspense
            fallback={
              <DocxEditorLoadingFallback label={t("folio.loadingEditor")} />
            }
          >
            <DocxEditor
              ref={editorRef}
              className="folio-docx-preview folio-peek h-full"
              documentBuffer={editorBuffer}
              initialZoom={targetZoom}
              mode={isUnlocked ? editorMode : "viewing"}
              onModeChange={(mode) => {
                if (mode !== "viewing") {
                  setEditorMode(mode);
                }
              }}
              onCompatibilityChange={(nextCompatibility) => {
                setCompatibility(nextCompatibility);
                onCompatibilityChange?.(nextCompatibility);
              }}
              showToolbar={isUnlocked}
              {...(isUnlocked ? { onChange: handleChange } : {})}
              {...(onReadonlyEditAttempt !== undefined
                ? { onReadonlyEditAttempt }
                : {})}
              {...(initialScrollTop !== undefined ? { initialScrollTop } : {})}
              {...(onScrollTopChange !== undefined
                ? { onScrollTopChange }
                : {})}
              loadingIndicator={
                <DocxEditorLoadingFallback label={t("folio.loadingDocument")} />
              }
            />
          </Suspense>
        </FileViewerWithAI>
      </div>
    </div>
  );
};

const defaultDocxBrowserEditorErrorFallback = ({
  reset,
}: {
  reset: () => void;
}) => <DocxBrowserEditorErrorFallback onRetry={reset} />;

const DocxBrowserEditorPendingFallback = () => (
  <div className="flex h-full w-full items-center justify-center">
    <DefaultPendingComponent className="bg-transparent" />
  </div>
);

const DocxBrowserEditorErrorFallback = ({
  onRetry,
}: {
  onRetry: () => void;
}) => {
  const t = useTranslations();

  return (
    <StatusMessage
      actionButton={
        <Button onClick={onRetry} size="sm" variant="outline">
          {t("common.tryAgain")}
        </Button>
      }
      className="h-full w-full"
      description={t("common.unexpectedError")}
      status="error"
      title={t("common.somethingWentWrong")}
    />
  );
};

const DocxEditorLoadingFallback = ({ label }: { label: string }) => (
  <div
    aria-live="polite"
    className="flex h-full w-full items-center justify-center"
    role="status"
  >
    <DefaultPendingComponent className="bg-transparent" />
    <span className="sr-only">{label}</span>
  </div>
);

type EditSessionErrorMessageKey =
  | "folio.editAuthRequired"
  | "folio.editPermissionDenied"
  | "folio.editDownloadFailed"
  | "folio.editSessionTakenOver"
  | "folio.editOpenFailed";

const editSessionErrorDescriptionKey = (
  reason: EditSessionErrorReason,
): EditSessionErrorMessageKey => {
  switch (reason) {
    case "authRequired":
      return "folio.editAuthRequired";
    case "permissionDenied":
      return "folio.editPermissionDenied";
    case "downloadFailed":
      return "folio.editDownloadFailed";
    case "takenOver":
      return "folio.editSessionTakenOver";
    case "unknown":
      return "folio.editOpenFailed";
    default: {
      const exhaustive: never = reason;
      return exhaustive;
    }
  }
};
