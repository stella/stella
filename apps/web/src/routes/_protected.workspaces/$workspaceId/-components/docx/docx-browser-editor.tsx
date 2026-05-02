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
import type { CSSProperties, ReactNode, RefObject } from "react";

import { FormattingBar } from "@stll/folio";
import type { DocxCompatibility, DocxEditorRef, EditorMode } from "@stll/folio";
import { Button } from "@stll/ui/components/button";
import {
  Select as StSelect,
  SelectItem as StSelectItem,
  SelectPopup as StSelectPopup,
  SelectTrigger as StSelectTrigger,
  SelectValue as StSelectValue,
} from "@stll/ui/components/select";
import { toast, toastManager } from "@stll/ui/components/toast";
import { cn } from "@stll/ui/lib/utils";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import {
  CheckCircle2Icon,
  EyeIcon,
  LockIcon,
  LockOpenIcon,
  PenLineIcon,
  RefreshCwIcon,
} from "lucide-react";
import { useTranslations } from "use-intl";
import "@stll/folio/editor.css";
import { FileViewerWithAI } from "@/components/ai-suggestions/file-viewer-with-ai";
import { QuerySuspenseBoundary } from "@/components/query-suspense-boundary";
import { StatusMessage } from "@/components/route-components";
import Tooltip from "@/components/tooltip";
import { DocxLoadingShell } from "@/routes/_protected.workspaces/$workspaceId/-components/docx/docx-loading-shell";
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

const CHANGE_CHECKPOINT_DELAY = 2000;
const noop = () => undefined;

type AutosaveStatus = "synced" | "pending" | "syncing";

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
  canUnlock?: boolean | undefined;
  onBlockedUnlock?: (() => void) | undefined;
  onUnlockedChange?: ((isUnlocked: boolean) => void) | undefined;
  onSaved?: ((fieldId: string) => void) | undefined;
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
      suspenseFallback={<DocxBrowserEditorPendingFallback {...props} />}
      onError={onError}
      resetKeys={[workspaceId, fieldId]}
    >
      <DocxBrowserEditorContent {...props} />
    </QuerySuspenseBoundary>
  );
};

const DocxBrowserEditorContent = (props: DocxBrowserEditorProps) => {
  const {
    workspaceId,
    entityId,
    fieldId,
    propertyId,
    actionsKey,
    actionsMapRef,
    actionsRef,
    actionBarControls,
    canUnlock = true,
    isEditing = true,
    initialScrollTop,
    onClose,
    onCompatibilityChange,
    onBlockedUnlock,
    onUnlockedChange,
    onSaved,
    onReadonlyEditAttempt,
    onScrollTopChange,
    scaleOffset = 0,
    showActionBar = true,
  } = props;
  const editorRef = useRef<DocxEditorRef>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const didOpenRef = useRef(false);
  const errorToastShownRef = useRef(false);
  const lastStyleLabelRef = useRef("Normal");
  const lastStyleLabelStyleRef = useRef<CSSProperties | undefined>(undefined);
  const lockedEditPromptTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
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
  const [isPromptingUnlock, setIsPromptingUnlock] = useState(false);
  const [autosaveStatus, setAutosaveStatus] =
    useState<AutosaveStatus>("synced");
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
      : { placeholderData: keepPreviousData }),
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
    setIsPromptingUnlock(false);
    if (lockedEditPromptTimerRef.current !== null) {
      clearTimeout(lockedEditPromptTimerRef.current);
      lockedEditPromptTimerRef.current = null;
    }
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
    onUnlockedChange?.(isUnlocked);
  }, [isUnlocked, onUnlockedChange]);

  useEffect(() => {
    if (!isUnlocked) {
      wasUnlockedRef.current = false;
      setAutosaveStatus("synced");
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

    setAutosaveStatus("syncing");
    void (async () => {
      const buffer = await ref.save({ selective: true });
      if (buffer) {
        const saved = await saveCheckpoint(buffer);
        setAutosaveStatus(saved ? "synced" : "pending");
        return;
      }
      setAutosaveStatus("pending");
    })();
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

      setAutosaveStatus("syncing");
      void (async () => {
        const buffer = await ref.save({ selective: true });
        if (buffer) {
          const saved = await saveCheckpoint(buffer);
          setAutosaveStatus(saved ? "synced" : "pending");
          return;
        }
        setAutosaveStatus("pending");
      })();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [clearQueuedChangeCheckpoint, isUnlocked, saveCheckpoint]);

  useEffect(
    () => () => {
      clearQueuedChangeCheckpoint();
      if (lockedEditPromptTimerRef.current !== null) {
        clearTimeout(lockedEditPromptTimerRef.current);
      }
    },
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

    setAutosaveStatus("pending");
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

    setAutosaveStatus("syncing");
    const saved = await saveCheckpoint(buffer);
    if (!saved) {
      setAutosaveStatus("pending");
      toastManager.add({
        description: t("folio.saveCheckpointFailedDescription"),
        title: t("folio.saveCheckpointFailedTitle"),
        type: "error",
      });
      return;
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

  const flashUnlockControl = useCallback(() => {
    setIsPromptingUnlock(true);
    if (lockedEditPromptTimerRef.current !== null) {
      clearTimeout(lockedEditPromptTimerRef.current);
    }
    lockedEditPromptTimerRef.current = setTimeout(() => {
      lockedEditPromptTimerRef.current = null;
      setIsPromptingUnlock(false);
    }, 1400);
  }, []);

  const handleUnlock = useCallback(() => {
    if (!canUnlock) {
      flashUnlockControl();
      onBlockedUnlock?.();
      return;
    }

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
  }, [
    canUnlock,
    compatibility?.canSafelyEdit,
    flashUnlockControl,
    onBlockedUnlock,
    open,
    previewFile,
    reportPendingCompatibility,
    reportUnsupportedEditAttempt,
    state.status,
  ]);

  const handleLockedEditAttempt = useCallback(() => {
    if (isUnlocked) {
      return;
    }
    flashUnlockControl();
    onReadonlyEditAttempt?.();
  }, [flashUnlockControl, isUnlocked, onReadonlyEditAttempt]);

  const handleToggleLock = useCallback(() => {
    if (!isUnlocked) {
      handleUnlock();
      return;
    }
    void handleFinalize();
  }, [handleFinalize, handleUnlock, isUnlocked]);

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
      unlock: handleUnlock,
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
    handleCancel,
    handleFinalize,
    handleUnlock,
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

  const showLockLabel = isUnlocked || isPromptingUnlock;
  const lockActionLabel = isUnlocked
    ? t("folio.finishEditing")
    : t("folio.editFile");

  const toolbarExtra =
    showActionBar || actionBarControls !== undefined ? (
      <>
        {actionBarControls}
        {showActionBar && (
          <>
            <Tooltip
              content={lockActionLabel}
              render={
                <Button
                  aria-label={lockActionLabel}
                  className={cn(
                    "transition-all",
                    showLockLabel ? "px-2" : "",
                    isPromptingUnlock &&
                      "bg-primary/10 text-primary ring-primary/60 animate-pulse ring-2",
                  )}
                  disabled={
                    state.status === "opening" || state.status === "saving"
                  }
                  onClick={handleToggleLock}
                  size={showLockLabel ? "sm" : "icon-sm"}
                  variant="ghost"
                >
                  {isUnlocked ? <LockOpenIcon /> : <LockIcon />}
                  {showLockLabel && <span>{lockActionLabel}</span>}
                </Button>
              }
            />
            {isUnlocked && <AutosaveIndicator status={autosaveStatus} />}
          </>
        )}
      </>
    ) : undefined;

  useEffect(() => {
    if (!isUnlocked) {
      setEditorMode("editing");
    }
  }, [isUnlocked]);

  useLayoutEffect(() => {
    const styleLabelElement = containerRef.current?.querySelector<HTMLElement>(
      '[data-folio-style-picker] [data-slot="select-value"]',
    );
    const stylePreviewElement =
      styleLabelElement?.querySelector<HTMLElement>("[style]") ??
      styleLabelElement;
    const styleLabel = styleLabelElement?.textContent?.trim();

    if (styleLabel !== undefined && styleLabel.length > 0) {
      lastStyleLabelRef.current = styleLabel;
    }

    if (stylePreviewElement !== undefined && stylePreviewElement !== null) {
      const computedStyle = window.getComputedStyle(stylePreviewElement);
      lastStyleLabelStyleRef.current = {
        color: computedStyle.color,
        fontSize: computedStyle.fontSize,
        fontStyle: computedStyle.fontStyle,
        fontWeight: computedStyle.fontWeight,
        lineHeight: computedStyle.lineHeight,
      };
    }
  });

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
    return (
      <DocxEditorLoadingFallback
        label={t("folio.loadingDocument")}
        scaleOffset={scaleOffset}
        showActionBar={showActionBar}
        stylePickerLabel={lastStyleLabelRef.current}
        stylePickerLabelStyle={lastStyleLabelStyleRef.current}
        toolbarExtra={toolbarExtra}
        zoom={targetZoom}
      />
    );
  }

  const previewIdentity = previewFile.fileId;

  return (
    <div ref={containerRef} className="flex h-full flex-col">
      {/* Folio editor with AI overlay */}
      <div
        className="flex-1 overflow-hidden"
        onDoubleClickCapture={isUnlocked ? undefined : handleLockedEditAttempt}
      >
        <FileViewerWithAI
          key={`ai-${previewIdentity}`}
          activeFile={{
            editable: canUnlock,
            entityId,
            fileName: previewFile.fileName,
          }}
          chatThreadId={fieldId}
          workspaceId={workspaceId}
        >
          <Suspense
            fallback={
              <DocxEditorLoadingFallback
                label={t("folio.loadingEditor")}
                scaleOffset={scaleOffset}
                showActionBar={showActionBar}
                stylePickerLabel={lastStyleLabelRef.current}
                stylePickerLabelStyle={lastStyleLabelStyleRef.current}
                toolbarExtra={toolbarExtra}
                zoom={targetZoom}
              />
            }
          >
            <DocxEditor
              key={`docx-${previewIdentity}`}
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
              showToolbar={showActionBar ? true : isUnlocked}
              toolbarExtra={toolbarExtra}
              {...(isUnlocked ? { onChange: handleChange } : {})}
              onReadonlyEditAttempt={handleLockedEditAttempt}
              {...(initialScrollTop !== undefined ? { initialScrollTop } : {})}
              {...(onScrollTopChange !== undefined
                ? { onScrollTopChange }
                : {})}
              loadingIndicator={
                <DocxEditorLoadingFallback
                  label={t("folio.loadingDocument")}
                  scaleOffset={scaleOffset}
                  showActionBar={showActionBar}
                  stylePickerLabel={lastStyleLabelRef.current}
                  stylePickerLabelStyle={lastStyleLabelStyleRef.current}
                  toolbarExtra={toolbarExtra}
                  zoom={targetZoom}
                />
              }
              preserveDocumentWhileLoading
            />
          </Suspense>
        </FileViewerWithAI>
      </div>
    </div>
  );
};

const AutosaveIndicator = ({ status }: { status: AutosaveStatus }) => {
  const t = useTranslations();
  const isSynced = status === "synced";
  const isSyncing = status === "syncing";

  return (
    <span
      aria-label={isSynced ? t("folio.synced") : t("folio.syncing")}
      className="text-muted-foreground/70 inline-flex h-8 w-8 items-center justify-center"
      role="status"
      title={isSynced ? t("folio.synced") : t("folio.syncing")}
    >
      {isSynced ? (
        <CheckCircle2Icon className="size-3.5" />
      ) : isSyncing ? (
        <RefreshCwIcon className="size-3.5 animate-spin" />
      ) : (
        <RefreshCwIcon className="size-3.5 opacity-45" />
      )}
    </span>
  );
};

const defaultDocxBrowserEditorErrorFallback = ({
  reset,
}: {
  reset: () => void;
}) => <DocxBrowserEditorErrorFallback onRetry={reset} />;

const DocxBrowserEditorPendingFallback = ({
  actionBarControls,
  scaleOffset = 0,
  showActionBar = true,
}: DocxBrowserEditorProps) => {
  const t = useTranslations();
  const lockActionLabel = t("folio.editFile");
  const toolbarExtra =
    showActionBar || actionBarControls !== undefined ? (
      <>
        {actionBarControls}
        {showActionBar && (
          <Tooltip
            content={lockActionLabel}
            render={
              <Button
                aria-label={lockActionLabel}
                disabled
                size="icon-sm"
                variant="ghost"
              >
                <LockIcon />
              </Button>
            }
          />
        )}
      </>
    ) : undefined;

  return (
    <DocxEditorLoadingFallback
      label={t("folio.loadingDocument")}
      scaleOffset={scaleOffset}
      showActionBar={showActionBar}
      toolbarExtra={toolbarExtra}
    />
  );
};

type DocxEditorLoadingFallbackProps = {
  label: string;
  scaleOffset: number;
  showActionBar: boolean;
  stylePickerLabel?: string | undefined;
  stylePickerLabelStyle?: CSSProperties | undefined;
  toolbarExtra?: ReactNode | undefined;
  zoom?: number | undefined;
};

const DocxEditorLoadingFallback = ({
  label,
  scaleOffset,
  showActionBar,
  stylePickerLabel,
  stylePickerLabelStyle,
  toolbarExtra,
  zoom,
}: DocxEditorLoadingFallbackProps) => (
  <div aria-live="polite" className="flex h-full w-full flex-col" role="status">
    <DocxLoadingToolbar
      showActionBar={showActionBar}
      stylePickerLabel={stylePickerLabel}
      stylePickerLabelStyle={stylePickerLabelStyle}
      toolbarExtra={toolbarExtra}
    />
    <DocxLoadingShell scaleOffset={scaleOffset} zoom={zoom} />
    <span className="sr-only">{label}</span>
  </div>
);

type DocxLoadingToolbarProps = {
  showActionBar: boolean;
  stylePickerLabel?: string | undefined;
  stylePickerLabelStyle?: CSSProperties | undefined;
  toolbarExtra?: ReactNode | undefined;
};

const DocxLoadingToolbar = ({
  showActionBar,
  stylePickerLabel,
  stylePickerLabelStyle,
  toolbarExtra,
}: DocxLoadingToolbarProps) => {
  if (!showActionBar) {
    return null;
  }

  return (
    <div className="pointer-events-none z-50 flex shrink-0 flex-col gap-0 bg-[var(--doc-page)] [&_[data-slot=select-trigger]:focus-visible]:ring-0 [&_[data-slot=select-trigger]:hover]:!bg-transparent [&_[data-slot=select-trigger][data-pressed]]:!bg-transparent [&_button:active]:!bg-transparent [&_button:focus-visible]:ring-0 [&_button:hover]:!bg-transparent [&_button[data-pressed]]:!bg-transparent [&_button[data-pressed]]:shadow-none">
      <FormattingBar
        canRedo={false}
        canUndo={false}
        currentFormatting={{}}
        onFormat={noop}
        onRedo={noop}
        onUndo={noop}
        priorityExtra={<DocxLoadingPriorityExtra />}
        stylePickerLabel={stylePickerLabel}
        stylePickerLabelStyle={stylePickerLabelStyle}
      >
        {toolbarExtra}
      </FormattingBar>
    </div>
  );
};

const DocxLoadingPriorityExtra = () => {
  const t = useTranslations("folio");

  return (
    <div className="flex shrink-0 items-center gap-1">
      <Button
        onClick={noop}
        onMouseDown={(e) => e.preventDefault()}
        aria-pressed={false}
        aria-label={t("toggleTrackChanges")}
        className="h-8 min-w-[140px] justify-start gap-1.5 rounded-md border-transparent px-2 text-xs text-[var(--doc-text-muted)] shadow-none hover:border-[var(--doc-border)] hover:bg-[var(--doc-primary-light)] hover:text-[var(--doc-text)]"
        size="xs"
        title={t("toggleTrackChanges")}
        variant="ghost"
      >
        <PenLineIcon className="size-3.5" />
        <span className="truncate whitespace-nowrap">{t("trackingOff")}</span>
      </Button>
      <StSelect value="all-markup" onValueChange={noop}>
        <StSelectTrigger
          size="sm"
          className="h-8 min-h-0 w-[132px] min-w-0 shrink-0 border-transparent bg-transparent text-xs text-[var(--doc-text-muted)] shadow-none hover:bg-[var(--doc-primary-light)] hover:text-[var(--doc-text)] data-[pressed]:bg-[var(--doc-primary-light)]"
        >
          <EyeIcon size={14} className="shrink-0" />
          <StSelectValue />
        </StSelectTrigger>
        <StSelectPopup>
          <StSelectItem value="all-markup">All Markup</StSelectItem>
          <StSelectItem value="simple-markup">Simple</StSelectItem>
          <StSelectItem value="no-markup">No Markup</StSelectItem>
          <StSelectItem value="original">Original</StSelectItem>
        </StSelectPopup>
      </StSelect>
    </div>
  );
};

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
