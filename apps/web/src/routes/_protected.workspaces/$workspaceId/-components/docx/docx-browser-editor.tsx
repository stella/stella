/**
 * DocxBrowserEditor — wrapper that manages the edit session lifecycle
 * and renders the Folio DocxEditor.
 */

import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import type { ReactNode, RefObject } from "react";

import type { DocxEditorRef, EditorMode } from "@stll/folio";
import { Button } from "@stll/ui/components/button";
import { toastManager } from "@stll/ui/components/toast";
import { useSuspenseQuery } from "@tanstack/react-query";
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
import type { EditSessionErrorReason } from "./use-edit-session";
import { useEditSession } from "./use-edit-session";

const DocxEditor = lazy(async () => {
  const m = await import("@stll/folio");
  return { default: m.DocxEditor };
});

const isDocxEditDebugEnabled = () => {
  try {
    return localStorage.getItem("folio:docx-edit-debug") === "1";
  } catch {
    return false;
  }
};

const debugDocxEdit = (event: string, data: Record<string, unknown> = {}) => {
  if (!isDocxEditDebugEnabled()) {
    return;
  }
  // eslint-disable-next-line no-console -- gated opt-in DOCX edit diagnostics.
  console.debug("[folio:docx-edit]", event, data);
};

type DocxBrowserEditorBaseProps = {
  workspaceId: string;
  entityId: string;
  fieldId: string;
  propertyId: string;
  initialScrollTop?: number | undefined;
  isEditing?: boolean | undefined;
  onClose: () => void;
  onSaved?: ((fieldId: string) => void) | undefined;
  onPreviewDoubleClick?: (() => void) | undefined;
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
  onSaved,
  onPreviewDoubleClick,
  onScrollTopChange,
  scaleOffset = 0,
  showActionBar = true,
}: DocxBrowserEditorProps) => {
  const editorRef = useRef<DocxEditorRef>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const didOpenRef = useRef(false);
  const errorToastShownRef = useRef(false);
  const [editorMode, setEditorMode] = useState<EditorMode>("editing");
  const targetZoom = useDocxFitZoom(containerRef, scaleOffset, 0.85);
  const t = useTranslations();
  const { data: previewFile } = useSuspenseQuery(
    fileOptions({ workspaceId, fieldId, purpose: "native-display" }),
  );

  const {
    state,
    open,
    checkpoint,
    saveCheckpoint,
    finalize,
    cancel,
    resetError,
  } = useEditSession({
    workspaceId,
    entityId,
    fieldId,
    propertyId,
    onFinalized: (result) => {
      if (result.outcome === "finalized") {
        onSaved?.(result.fieldId);
      }
      onClose();
    },
    onCancelled: onClose,
  });

  // Auto-open when this component is used as a direct editor, or when the
  // preview is explicitly unlocked from the shell toolbar.
  useEffect(() => {
    if (!isEditing || didOpenRef.current || state.status !== "idle") {
      return;
    }
    didOpenRef.current = true;
    errorToastShownRef.current = false;
    void open();
  }, [isEditing, open, state.status]);

  useEffect(() => {
    if (!isEditing) {
      didOpenRef.current = false;
    }
  }, [isEditing]);

  useEffect(() => {
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
      title: t("errors.actionFailed"),
      type: "error",
    });
    onClose();
    resetError();
  }, [onClose, resetError, state, t]);

  const isUnlocked = state.status === "editing";

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
      const ref = editorRef.current;
      if (!ref) {
        return;
      }

      void ref.save({ selective: false }).then((buffer) => {
        if (buffer) {
          void saveCheckpoint(buffer);
        }
      });
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [isUnlocked, saveCheckpoint]);

  const handleChange = () => {
    // On each document change, serialize and queue a checkpoint
    const ref = editorRef.current;
    if (!ref) {
      debugDocxEdit("change-skipped-missing-editor");
      return;
    }
    void ref.save({ selective: true }).then((buffer) => {
      if (buffer) {
        debugDocxEdit("change-checkpoint-queued", {
          byteLength: buffer.byteLength,
        });
        checkpoint(buffer);
        return;
      }
      debugDocxEdit("change-save-returned-null");
    });
  };

  const handleFinalize = useCallback(async () => {
    // Save the final version before finalizing
    const ref = editorRef.current;
    if (!ref) {
      debugDocxEdit("finalize-aborted-missing-editor");
      toastManager.add({
        description: t("common.somethingWentWrong"),
        title: t("errors.actionFailed"),
        type: "error",
      });
      return;
    }

    const buffer = await ref.save({ selective: false });
    if (!buffer) {
      debugDocxEdit("finalize-aborted-null-buffer");
      toastManager.add({
        description: t("common.somethingWentWrong"),
        title: t("errors.actionFailed"),
        type: "error",
      });
      return;
    }

    debugDocxEdit("finalize-checkpoint-start", {
      byteLength: buffer.byteLength,
    });
    const saved = await saveCheckpoint(buffer);
    if (!saved) {
      debugDocxEdit("finalize-aborted-checkpoint-failed");
      toastManager.add({
        description: t("common.somethingWentWrong"),
        title: t("errors.actionFailed"),
        type: "error",
      });
      return;
    }
    debugDocxEdit("finalize-start");
    await finalize();
  }, [finalize, saveCheckpoint, t]);

  const handleCancel = useCallback(async () => {
    await cancel();
  }, [cancel]);

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
        if (state.status === "idle" && !didOpenRef.current) {
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
    handleCancel,
    handleFinalize,
    open,
    state.status,
  ]);

  // Hold the last editing buffer so the editor doesn't swap to the
  // preview buffer during the save transition (`state` becomes
  // "saving" with no buffer of its own). Without this we'd reload the
  // editor against `previewFile.buffer` for the few hundred ms before
  // the parent unmounts us — and the Stella fallback would flash.
  const lastEditingBufferRef = useRef<ArrayBuffer | null>(null);
  if (state.status === "editing") {
    lastEditingBufferRef.current = state.buffer;
  }
  const editorBuffer =
    state.status === "editing"
      ? state.buffer
      : state.status === "saving" && lastEditingBufferRef.current !== null
        ? lastEditingBufferRef.current
        : previewFile.buffer;

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
        title={t("errors.actionFailed")}
      />
    );
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
              showToolbar={isUnlocked}
              {...(isUnlocked ? { onChange: handleChange } : {})}
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
