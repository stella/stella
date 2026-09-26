import { useLayoutEffect, useRef, useState } from "react";
/**
 * DocxBrowserEditor — wrapper that manages the edit session lifecycle
 * and renders the Folio DocxEditor.
 */
import type { CSSProperties, ReactNode, RefObject } from "react";

import { panic } from "better-result";
import {
  CheckCircle2Icon,
  EyeIcon,
  GitCommitHorizontalIcon,
  PenLineIcon,
  RefreshCwIcon,
  XIcon,
} from "lucide-react";
import { useTranslations } from "use-intl";

import { FolioUIProvider, FormattingBar } from "@stll/folio-react";
import type {
  DocxCompatibility,
  DocxEditorCollaboration,
  DocxEditorRef,
} from "@stll/folio-react";
import { Button } from "@stll/ui/button";
import { ReviewOutOfDateNotice } from "@stll/ui/review-out-of-date-notice";
import type { ReviewOutOfDateReason } from "@stll/ui/review-out-of-date-notice";
import {
  Select as StSelect,
  SelectItem as StSelectItem,
  SelectPopup as StSelectPopup,
  SelectTrigger as StSelectTrigger,
  SelectValue as StSelectValue,
} from "@stll/ui/select";
import "@stll/folio-react/editor.css";

import { useDocxWheelZoom } from "@/components/docx-preview-zoom";
import { DocxEditor } from "@/components/docx/app-docx-editor";
import { DocxEditorAiOverlay } from "@/components/docx/docx-editor-ai-overlay";
import { DocxFindBar } from "@/components/docx/docx-find-bar";
import { DocxLoadingShell } from "@/components/docx/docx-loading-shell";
import {
  EvidenceReferencesButton,
  EvidenceReferencesDialog,
} from "@/components/docx/evidence-references";
import { useDocxBlockScroll } from "@/components/docx/use-docx-block-scroll";
import { useSyncDocxSuggestions } from "@/components/docx/use-sync-docx-suggestions";
import { QuerySuspenseBoundary } from "@/components/query-suspense-boundary";
import { RenderStormRegion } from "@/components/render-storm-canary";
import { StatusMessage } from "@/components/route-components";
import { UserIdentityAvatar } from "@/components/user-avatar";
import { useExternalSyncEffect } from "@/hooks/use-effect";
import { detached } from "@/lib/detached";
import { folioUIComponents } from "@/lib/folio-ui-components";
import "@/components/pdf/peek/peek-docx.css";

import {
  editSessionErrorDescriptionKey,
  getDocxEditorBlockingError,
  selectDocxBrowserEditorBuffer,
} from "./docx-browser-editor.logic";
import type {
  DocxEditorBlockingError,
  OptimisticPreviewFile,
  PreservedLoadedBuffer,
} from "./docx-browser-editor.logic";
import type { AutosaveStatus } from "./docx-edit-mode.logic";
import { useActiveDocxRegistration } from "./use-active-docx-registration";
import { useDocxBrowserCollaboration } from "./use-docx-browser-collaboration";
import { useDocxBrowserEditorActions } from "./use-docx-browser-editor-actions";
import type { DocxBrowserEditorActions } from "./use-docx-browser-editor-actions";
import { useDocxCheckpointAutosave } from "./use-docx-checkpoint-autosave";
import { useDocxComments } from "./use-docx-comments";
import { useDocxCompatibility } from "./use-docx-compatibility";
import { useDocxEditOpening } from "./use-docx-edit-opening";
import { useDocxEditorMode } from "./use-docx-editor-mode";
import { useDocxEditorView } from "./use-docx-editor-view";
import { useDocxEditorViewport } from "./use-docx-editor-viewport";
import type { DocxEditorSurface } from "./use-docx-editor-viewport";
import { useDocxPreviewFile } from "./use-docx-preview-file";
import {
  useDocxEditSession,
  useDocxSessionFinish,
} from "./use-docx-session-finish";
import { useDocxUnlockTransition } from "./use-docx-unlock-transition";
import type { EditSessionState } from "./use-edit-session.logic";
import { useEvidenceReferenceInsertion } from "./use-evidence-reference-insertion";
import type {
  EvidenceReferenceInsertion,
  EvidenceReferencesDialogState,
} from "./use-evidence-reference-insertion";
import type {
  FolioCollaborationRoom,
  FolioCollaborationRoomState,
} from "./use-folio-collaboration-room";
import { useRetainedStylePickerLabel } from "./use-retained-style-picker-label";

const noop = () => undefined;

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
  onCollaborationPublishableChange?:
    | ((publishable: boolean) => void)
    | undefined;
  canUnlock: boolean;
  onBlockedUnlock?: (() => void) | undefined;
  onUnlockedChange?: ((isUnlocked: boolean) => void) | undefined;
  onSaved?: ((fieldId: string) => void) | undefined;
  onScrollTopChange?: ((scrollTop: number) => void) | undefined;
  collaboration?: DocxEditorCollaboration | undefined;
  scaleOffset?: number | undefined;
  actionsKey?: string | undefined;
  actionsMapRef?: RefObject<Map<string, DocxBrowserEditorActions>> | undefined;
  actionsRef?: RefObject<DocxBrowserEditorActions | null> | undefined;
  actionBarControls?: ReactNode | undefined;
  showActionBar?: boolean | undefined;
  /** Which chrome hosts the editor; selects the find-bar behavior. */
  surface: DocxEditorSurface;
  errorFallback?: ((props: { reset: () => void }) => ReactNode) | undefined;
  onError?: ((error: Error) => void) | undefined;
};

type DocxBrowserEditorProps = DocxBrowserEditorBaseProps;

type DocxBrowserEditorContentProps = DocxBrowserEditorProps & {
  evidenceReferencesDialogState: EvidenceReferencesDialogState;
  onEvidenceReferencesDialogStateChange: (
    state: EvidenceReferencesDialogState,
  ) => void;
};

export const DocxBrowserEditor = (props: DocxBrowserEditorProps) => {
  const { errorFallback, fieldId, onError, workspaceId } = props;
  const [evidenceReferencesDialogState, setEvidenceReferencesDialogState] =
    useState<EvidenceReferencesDialogState>("closed");

  return (
    <QuerySuspenseBoundary
      area="docx-browser-editor"
      errorFallback={errorFallback ?? defaultDocxBrowserEditorErrorFallback}
      suspenseFallback={<DocxBrowserEditorPendingFallback {...props} />}
      onError={onError}
      resetKeys={[workspaceId, fieldId]}
    >
      <RenderStormRegion name="docx-browser-editor">
        <DocxBrowserEditorContent
          {...props}
          evidenceReferencesDialogState={evidenceReferencesDialogState}
          onEvidenceReferencesDialogStateChange={
            setEvidenceReferencesDialogState
          }
        />
      </RenderStormRegion>
    </QuerySuspenseBoundary>
  );
};

const DocxBrowserEditorContent = (props: DocxBrowserEditorContentProps) => {
  const {
    workspaceId,
    entityId,
    evidenceReferencesDialogState,
    fieldId,
    propertyId,
    actionsKey,
    actionsMapRef,
    actionsRef,
    actionBarControls,
    canUnlock,
    collaboration,
    isEditing = true,
    initialScrollTop,
    onClose,
    onCollaborationPublishableChange,
    onCompatibilityChange,
    onBlockedUnlock,
    onEvidenceReferencesDialogStateChange,
    onUnlockedChange,
    onSaved,
    onScrollTopChange,
    scaleOffset = 0,
    showActionBar = true,
    surface,
  } = props;
  const editorRef = useRef<DocxEditorRef>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const { editorView, editorProps: editorViewProps } = useDocxEditorView({
    entityId,
    fieldId,
    workspaceId,
  });
  const pendingEditRequestRef = useRef(false);
  const optimisticPreviewRef = useRef<OptimisticPreviewFile | null>(null);
  const finalizedBufferRef = useRef<ArrayBuffer | null>(null);
  const lastEditingBufferRef = useRef<ArrayBuffer | null>(null);
  const hasSessionChangesRef = useRef(false);
  const preservedLoadedBufferRef = useRef<PreservedLoadedBuffer | null>(null);
  const editTargetKey = `${workspaceId}:${entityId}:${propertyId}:${fieldId}`;
  const [, setAutosaveStatus] = useState<AutosaveStatus>("synced");
  const { composedContainerRef, find, targetZoom } = useDocxEditorViewport({
    containerRef,
    editorRef,
    scaleOffset,
    surface,
  });
  const { isPlaceholderData: isPreviewPlaceholderData, previewFile } =
    useDocxPreviewFile({ fieldId, optimisticPreviewRef, workspaceId });
  const { compatibility, handleCompatibilityChange, resetCompatibility } =
    useDocxCompatibility({
      editTargetKey,
      isPreviewPlaceholderData,
      onCompatibilityChange,
    });
  const collaborationRuntime = useDocxBrowserCollaboration({
    canUnlock,
    externalCollaboration: collaboration,
    entityId,
    hasSessionChangesRef,
    initiallyRequested:
      isEditing &&
      !isPreviewPlaceholderData &&
      compatibility?.canSafelyEdit === true,
    onPublishableChange: onCollaborationPublishableChange,
    propertyId,
    workspaceId,
  });
  const {
    activeCollaboration,
    collaborationSession,
    collaborationState,
    discardPendingPublication,
  } = collaborationRuntime;

  const editSession = useDocxEditSession({
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
  });
  const { state } = editSession;

  useExternalSyncEffect(() => {
    if (optimisticPreviewRef.current?.fieldId === fieldId) {
      return;
    }
    optimisticPreviewRef.current = null;
    finalizedBufferRef.current = null;
    lastEditingBufferRef.current = null;
    hasSessionChangesRef.current = false;
    discardPendingPublication();
    preservedLoadedBufferRef.current = null;
    pendingEditRequestRef.current = false;
    resetCompatibility();
  }, [discardPendingPublication, editTargetKey, fieldId, resetCompatibility]);

  const opening = useDocxEditOpening({
    canUnlock,
    collaboration: collaborationRuntime,
    compatibility,
    editSession,
    fieldId,
    isEditing,
    onBlockedUnlock,
    onClose,
    pendingEditRequestRef,
    previewFile,
  });
  const { isUnlocked, requestEditMode } = opening;
  const { editorMode, handleEditorModeChange } = useDocxEditorMode(isUnlocked);

  useLayoutEffect(() => {
    editorRef.current?.setZoom(targetZoom);
  }, [targetZoom]);
  useDocxWheelZoom(containerRef, editorRef);
  useDocxBlockScroll({ editorRef, fieldId });
  // Hydrate persisted AI suggestions into the review store on reload.
  // Lives here (not on the route) because rebuilding each suggestion's
  // preview needs this editor's live snapshot; the review panel/bar
  // then render exactly as they did before the reload.
  useSyncDocxSuggestions({ workspaceId, entityId, editorRef });

  const evidence = useEvidenceReferenceInsertion({
    canUnlock,
    compatibility,
    didOpenRef: opening.didOpenRef,
    dialogState: evidenceReferencesDialogState,
    editorMode,
    editorRef,
    isUnlocked,
    onDialogStateChange: onEvidenceReferencesDialogStateChange,
    requestEditMode,
  });

  useExternalSyncEffect(() => {
    onUnlockedChange?.(isUnlocked);
  }, [isUnlocked, onUnlockedChange]);

  useActiveDocxRegistration({
    editorRef,
    entityId,
    fieldId,
    isUnlocked,
    requestEditMode,
  });
  useDocxUnlockTransition({ editorRef, isUnlocked, setAutosaveStatus });

  const { clearQueuedChangeCheckpoint, flushPendingChanges, handleChange } =
    useDocxCheckpointAutosave({
      editorRef,
      hasSessionChangesRef,
      isCollaborativeEditing: collaborationRuntime.isCollaborativeEditing,
      isUnlocked,
      markDirty: editSession.markDirty,
      saveCheckpoint: editSession.saveCheckpoint,
      setAutosaveStatus,
    });
  const comments = useDocxComments(handleChange);

  const { handleCancel, handleFinalize } = useDocxSessionFinish({
    clearQueuedChangeCheckpoint,
    collaboration: collaborationRuntime,
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
  });

  useDocxBrowserEditorActions({
    actionsKey,
    actionsMapRef,
    actionsRef,
    editSession,
    editorRef,
    flushPendingChanges,
    handleCancel,
    handleFinalize,
    isCollaborativeEditing: collaborationRuntime.isCollaborativeEditing,
    requestEditMode,
  });

  // Hold the last editing buffer so the editor doesn't swap to the
  // preview buffer during the save transition (`state` becomes
  // "saving" with no buffer of its own). Without this we'd reload the
  // editor against `previewFile.buffer` for the few hundred ms before
  // the parent unmounts us — and the Stella fallback would flash.
  /* oxlint-disable react/refs -- editing buffers and the derived editor buffer are intentionally latched in refs across the save transition */
  const editorBuffer = resolveAndPreserveDocxEditorBuffer({
    collaborationSeedBuffer: collaborationSession?.seedDocumentBuffer ?? null,
    fieldId,
    lastEditingBufferRef,
    preservedLoadedBufferRef,
    previewBuffer: previewFile?.buffer,
    state,
  });
  /* oxlint-enable react/refs */

  const toolbarExtra =
    showActionBar || actionBarControls !== undefined ? (
      <DocxEditorToolbarExtra
        actionBarControls={actionBarControls}
        canPublish={collaborationRuntime.canPublishCollaborationVersion}
        collaborationState={collaborationState}
        evidence={evidence}
        onClose={handleCancel}
        onPublish={collaborationRuntime.publishCollaborationVersion}
        showActionBar={showActionBar}
      />
    ) : undefined;

  const { lastStyleLabel, lastStyleLabelStyle } =
    useRetainedStylePickerLabel(containerRef);

  const blockingError = getDocxEditorBlockingError({
    collaborationState,
    state,
  });
  if (blockingError !== null) {
    return (
      <DocxEditorBlockingErrorMessage error={blockingError} onClose={onClose} />
    );
  }

  const loadingFallback = (
    <DocxEditorLoadingFallback
      scaleOffset={scaleOffset}
      showActionBar={showActionBar}
      stylePickerLabel={lastStyleLabel}
      stylePickerLabelStyle={lastStyleLabelStyle}
      toolbarExtra={toolbarExtra}
      zoom={targetZoom}
    />
  );

  if (previewFile === null || editorBuffer === undefined) {
    return loadingFallback;
  }

  const previewIdentity = previewFile.fileId;
  comments.resetCommentsForDocument(previewIdentity);

  return (
    <div
      ref={composedContainerRef}
      className="flex h-full w-full min-w-0 flex-col"
    >
      <EvidenceReferencesDialog
        workspaceId={workspaceId}
        entityId={entityId}
        fieldId={fieldId}
        view={editorView}
        {...evidence.dialog}
      />
      {state.status === "released" && (
        <EditSessionReleasedNotice
          hasUnsavedChanges={state.hasUnsavedChanges}
          onReopen={opening.reopenReleasedSession}
        />
      )}
      {find.isOpen && <DocxFindBar find={find} />}
      {/* Folio editor with AI overlay */}
      <div
        className="min-w-0 flex-1 overflow-hidden"
        // Auto-unlock on first click into the doc body — but only when we
        // can actually unlock. For locked older versions (canUnlock=false)
        // every click would otherwise pop the "latest version required"
        // dialog and the doc becomes unselectable; fall through to the
        // typing-based onReadonlyEditAttempt path instead, which only
        // fires on real edit attempts (not text-selection clicks).
        onMouseDownCapture={opening.handleReadonlySurfaceMouseDown}
      >
        <DocxEditorAiOverlay
          key={`ai-${previewIdentity}`}
          canSafelyEdit={compatibility?.canSafelyEdit}
          canUnlock={canUnlock}
          docxComments={comments.docxComments}
          editorRef={editorRef}
          entityId={entityId}
          fieldId={fieldId}
          fileName={previewFile.fileName}
          isUnlocked={isUnlocked}
          onDocxCommentsChange={comments.handleAiDocxCommentsChange}
          requestEditMode={requestEditMode}
          workspaceId={workspaceId}
        >
          <DocxEditor
            key={`docx-${previewIdentity}-${collaborationSession?.roomId ?? "local"}`}
            ref={editorRef}
            autoOpenReviewSidebar={false}
            // Docked, the pane has a find bar of its own and no Folio binding
            // may answer beside it. Full view keeps Folio's bindings for a
            // press inside the editor; the registry covers the rest.
            keyboardShortcuts={surface === "inspector" ? "none" : "editor"}
            className="folio-docx-preview folio-peek h-full"
            comments={comments.docxComments}
            onCommentsChange={comments.handleEditorDocxCommentsChange}
            documentBuffer={editorBuffer}
            initialZoom={targetZoom}
            mode={isUnlocked ? editorMode : "viewing"}
            onModeChange={handleEditorModeChange}
            onCompatibilityChange={handleCompatibilityChange}
            {...editorViewProps}
            plugins={evidence.plugins}
            showToolbar={showActionBar ? true : isUnlocked}
            toolbarExtra={toolbarExtra}
            {...(activeCollaboration !== undefined
              ? { collaboration: activeCollaboration }
              : {})}
            {...(isUnlocked ? { onChange: handleChange } : {})}
            onReadonlyEditAttempt={opening.handleLockedEditAttempt}
            {...(initialScrollTop !== undefined ? { initialScrollTop } : {})}
            {...(onScrollTopChange !== undefined ? { onScrollTopChange } : {})}
            loadingIndicator={loadingFallback}
            preserveDocumentWhileLoading
          />
        </DocxEditorAiOverlay>
      </div>
    </div>
  );
};

type ResolveAndPreserveDocxEditorBufferOptions = {
  collaborationSeedBuffer: ArrayBuffer | null;
  fieldId: string;
  lastEditingBufferRef: RefObject<ArrayBuffer | null>;
  preservedLoadedBufferRef: RefObject<PreservedLoadedBuffer | null>;
  previewBuffer: ArrayBuffer | undefined;
  state: EditSessionState;
};

const resolveAndPreserveDocxEditorBuffer = ({
  collaborationSeedBuffer,
  fieldId,
  lastEditingBufferRef,
  preservedLoadedBufferRef,
  previewBuffer,
  state,
}: ResolveAndPreserveDocxEditorBufferOptions) => {
  const preservedLoadedBufferSnapshot = preservedLoadedBufferRef.current;
  const preservedLoadedBuffer =
    preservedLoadedBufferSnapshot?.fieldId === fieldId
      ? preservedLoadedBufferSnapshot.buffer
      : null;
  const editorBuffer = selectDocxBrowserEditorBuffer({
    collaborationSeedBuffer,
    lastEditingBuffer: lastEditingBufferRef.current,
    preservedLoadedBuffer,
    previewBuffer,
    state,
  });
  if (
    (state.status === "editing" || collaborationSeedBuffer !== null) &&
    editorBuffer !== undefined
  ) {
    lastEditingBufferRef.current = editorBuffer;
    preservedLoadedBufferRef.current = null;
  }
  return editorBuffer;
};

type DocxEditorToolbarExtraProps = {
  actionBarControls: ReactNode;
  canPublish: boolean;
  collaborationState: FolioCollaborationRoomState;
  evidence: Pick<
    EvidenceReferenceInsertion,
    "canInsert" | "document" | "onClick"
  >;
  onClose: () => Promise<void>;
  onPublish: () => Promise<boolean>;
  showActionBar: boolean;
};

const DocxEditorToolbarExtra = ({
  actionBarControls,
  canPublish,
  collaborationState,
  evidence,
  onClose,
  onPublish,
  showActionBar,
}: DocxEditorToolbarExtraProps) => (
  <>
    {actionBarControls}
    <EvidenceReferencesButton
      canInsert={evidence.canInsert}
      document={evidence.document}
      onClick={evidence.onClick}
    />
    {showActionBar && collaborationState.room !== null && (
      <DocxCollaborationToolbarControls
        canPublish={canPublish}
        collaborationState={collaborationState}
        onClose={onClose}
        onPublish={onPublish}
      />
    )}
  </>
);

type DocxCollaborationToolbarControlsProps = {
  canPublish: boolean;
  collaborationState: Extract<
    FolioCollaborationRoomState,
    { room: FolioCollaborationRoom }
  >;
  onClose: () => Promise<void>;
  onPublish: () => Promise<boolean>;
};

const DocxCollaborationToolbarControls = ({
  canPublish,
  collaborationState,
  onClose,
  onPublish,
}: DocxCollaborationToolbarControlsProps) => {
  const t = useTranslations();
  const createVersionLabel = t("folio.createVersion");

  return (
    <>
      <Button
        className="min-h-11 px-3"
        disabled={!canPublish}
        onClick={() => {
          detached(
            onPublish(),
            "docx-browser-editor.publish-collaboration-version",
          );
        }}
        size="sm"
        tooltip={createVersionLabel}
      >
        <GitCommitHorizontalIcon />
        <span>{createVersionLabel}</span>
      </Button>
      <CollaborationStatusIndicator status={collaborationState.status} />
      <CollaborationPresence
        awareness={collaborationState.room.collaboration.awareness}
      />
      <Button
        aria-label={t("common.close")}
        className="min-h-11 px-3"
        onClick={() => {
          detached(onClose(), "docx-browser-editor.close");
        }}
        size="sm"
        tooltip={t("common.close")}
        variant="ghost"
      >
        <XIcon />
        <span>{t("common.close")}</span>
      </Button>
    </>
  );
};

type DocxEditorBlockingErrorMessageProps = {
  error: DocxEditorBlockingError;
  onClose: () => void;
};

const DocxEditorBlockingErrorMessage = ({
  error,
  onClose,
}: DocxEditorBlockingErrorMessageProps) => {
  const t = useTranslations();
  const { description, title } = (() => {
    switch (error.type) {
      case "finalizeFailed":
        return {
          description:
            // For known reasons, prefer the localized message — the
            // backend `state.detail` is wire jargon ("Desktop editing
            // moved to another device.") even for in-browser sessions
            // and reads as alarming. Fall back to detail only when the
            // reason is "unknown".
            error.reason === "unknown" && error.detail !== undefined
              ? error.detail
              : t(editSessionErrorDescriptionKey(error.reason)),
          title: t("folio.editSaveFailedTitle"),
        };
      case "collaborationUnavailable":
        return {
          description: error.message,
          title: t("folio.editOpenFailedTitle"),
        };
      default: {
        error satisfies never;
        return panic(`Unhandled blocking error: ${String(error)}`);
      }
    }
  })();

  return (
    <StatusMessage
      actionButton={
        <Button onClick={onClose} size="sm" variant="outline">
          {t("common.close")}
        </Button>
      }
      className="h-full w-full"
      description={description}
      status="error"
      title={title}
    />
  );
};

const CollaborationStatusIndicator = ({
  status,
}: {
  status: "connecting" | "readOnly" | "reconnecting" | "synced";
}) => {
  const t = useTranslations();
  const label = (() => {
    switch (status) {
      case "connecting":
        return t("folio.syncing");
      case "readOnly":
        return t("folio.viewOnly");
      case "reconnecting":
        return t("common.reconnecting");
      case "synced":
        return t("folio.synced");
      default: {
        status satisfies never;
        return panic(`Unhandled status: ${String(status)}`);
      }
    }
  })();
  const icon = (() => {
    switch (status) {
      case "synced":
        return <CheckCircle2Icon className="size-3.5" />;
      case "readOnly":
        return <EyeIcon className="size-3.5" />;
      case "connecting":
      case "reconnecting":
        return <RefreshCwIcon className="size-3.5 motion-safe:animate-spin" />;
      default: {
        status satisfies never;
        return panic(`Unhandled status: ${String(status)}`);
      }
    }
  })();

  return (
    <span
      className="text-foreground-muted inline-flex min-h-11 items-center gap-1.5 px-2 text-xs"
      role="status"
    >
      {icon}
      <span>{label}</span>
    </span>
  );
};

type CollaborationPresenceUser = {
  id: string;
  image: string | null;
  name: string;
};

const readCollaborationPresenceUser = (
  value: unknown,
): CollaborationPresenceUser | null => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  if (!("user" in value)) {
    return null;
  }
  const user = value.user;
  if (user === null || typeof user !== "object" || Array.isArray(user)) {
    return null;
  }
  if (!("id" in user) || !("image" in user) || !("name" in user)) {
    return null;
  }
  const { id, image, name } = user;
  if (
    typeof id !== "string" ||
    typeof name !== "string" ||
    (image !== null && typeof image !== "string")
  ) {
    return null;
  }
  return { id, image, name };
};

const readCollaborationPresence = (
  awareness: NonNullable<DocxEditorCollaboration["awareness"]>,
) => {
  const users = new Map<string, CollaborationPresenceUser>();
  for (const state of awareness.getStates().values()) {
    const user = readCollaborationPresenceUser(state);
    if (user !== null) {
      users.set(user.id, user);
    }
  }
  return [...users.values()];
};

const hasSameCollaborationPresence = (
  previous: CollaborationPresenceUser[],
  next: CollaborationPresenceUser[],
) =>
  previous.length === next.length &&
  previous.every((user, index) => {
    const nextUser = next.at(index);
    return (
      nextUser !== undefined &&
      user.id === nextUser.id &&
      user.image === nextUser.image &&
      user.name === nextUser.name
    );
  });

const CollaborationPresence = ({
  awareness,
}: {
  awareness: NonNullable<DocxEditorCollaboration["awareness"]>;
}) => {
  const [users, setUsers] = useState(() =>
    readCollaborationPresence(awareness),
  );

  useExternalSyncEffect(() => {
    const updatePresence = () => {
      const next = readCollaborationPresence(awareness);
      setUsers((previous) =>
        hasSameCollaborationPresence(previous, next) ? previous : next,
      );
    };
    updatePresence();
    awareness.on("change", updatePresence);
    return () => awareness.off("change", updatePresence);
  }, [awareness]);

  return (
    <ul className="flex min-h-11 items-center -space-x-2 px-2">
      {users.map((user) => (
        <li
          aria-label={user.name}
          className="border-background rounded-full border-2"
          key={user.id}
          title={user.name}
        >
          <UserIdentityAvatar
            className="text-3xs size-7"
            image={user.image}
            name={user.name}
          />
        </li>
      ))}
    </ul>
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
  const toolbarExtra =
    showActionBar || actionBarControls !== undefined
      ? actionBarControls
      : undefined;

  return (
    <DocxEditorLoadingFallback
      scaleOffset={scaleOffset}
      showActionBar={showActionBar}
      toolbarExtra={toolbarExtra}
    />
  );
};

type DocxEditorLoadingFallbackProps = {
  scaleOffset: number;
  showActionBar: boolean;
  stylePickerLabel?: string | undefined;
  stylePickerLabelStyle?: CSSProperties | undefined;
  toolbarExtra?: ReactNode | undefined;
  zoom?: number | undefined;
};

const DocxEditorLoadingFallback = ({
  scaleOffset,
  showActionBar,
  stylePickerLabel,
  stylePickerLabelStyle,
  toolbarExtra,
  zoom,
}: DocxEditorLoadingFallbackProps) => {
  const t = useTranslations();

  return (
    <div
      aria-live="polite"
      className="flex h-full w-full flex-col"
      role="status"
    >
      <DocxLoadingToolbar
        showActionBar={showActionBar}
        stylePickerLabel={stylePickerLabel}
        stylePickerLabelStyle={stylePickerLabelStyle}
        toolbarExtra={toolbarExtra}
      />
      <DocxLoadingShell scaleOffset={scaleOffset} zoom={zoom} />
      <span className="sr-only">{t("folio.loadingDocument")}</span>
    </div>
  );
};

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
      <FolioUIProvider components={folioUIComponents}>
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
      </FolioUIProvider>
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
        className="h-8 min-w-[140px] justify-start gap-1.5 rounded-md border-transparent px-2 text-[var(--doc-text-muted)] shadow-none hover:border-[var(--doc-border)] hover:bg-[var(--doc-primary-light)] hover:text-[var(--doc-text)]"
        size="xs"
        title={t("toggleTrackChanges")}
        variant="ghost"
      >
        <PenLineIcon className="size-3.5" />
        <span className="truncate">{t("trackingOff")}</span>
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
          <StSelectItem value="all-markup">
            {t("markupView.allMarkup")}
          </StSelectItem>
          <StSelectItem value="simple-markup">
            {t("markupView.simple")}
          </StSelectItem>
          <StSelectItem value="no-markup">
            {t("markupView.noMarkup")}
          </StSelectItem>
          <StSelectItem value="original">
            {t("markupView.original")}
          </StSelectItem>
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

type EditSessionReleasedNoticeProps = {
  hasUnsavedChanges: boolean;
  onReopen: () => void;
};

/**
 * The session moved to another tab, window or device. Losing the lock is not a
 * failure the user has to clear: the document stays open read-only, so this
 * states what happened and offers the way back.
 */
const EditSessionReleasedNotice = ({
  hasUnsavedChanges,
  onReopen,
}: EditSessionReleasedNoticeProps) => {
  const t = useTranslations();
  const reasons: ReviewOutOfDateReason[] = [
    { id: "released", label: t("folio.editSessionReleased") },
  ];
  if (hasUnsavedChanges) {
    reasons.push({
      id: "unsavedChanges",
      label: t("folio.editSessionReleasedUnsaved"),
    });
  }

  return (
    <div aria-live="polite" className="shrink-0 px-3 pt-3" role="status">
      <ReviewOutOfDateNotice
        actionLabel={t("folio.editSessionReopen")}
        onAction={onReopen}
        reasons={reasons}
        tone="muted"
      />
    </div>
  );
};
