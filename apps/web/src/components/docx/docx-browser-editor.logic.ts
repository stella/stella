import { panic } from "better-result";

import type { DocxEditSafety } from "@/lib/chat-edit-mode";
import { selectStableArrayBuffer } from "@/lib/files/array-buffer-utils";

import type {
  EditSessionErrorReason,
  EditSessionState,
} from "./use-edit-session.logic";
import type { FolioCollaborationRoomState } from "./use-folio-collaboration-room";

export type DocxPreviewFile = {
  fileId: string;
  fileName: string;
  mimeType: string;
  originalMimeType: string;
  buffer: ArrayBuffer;
};

export type OptimisticPreviewFile = {
  fieldId: string;
  file: DocxPreviewFile;
};

/** Bytes the editor last showed, kept for the document they belong to. */
export type PreservedLoadedBuffer = {
  buffer: ArrayBuffer;
  fieldId: string;
};

type SelectPreviewFileOptions = {
  file: DocxPreviewFile;
  fieldId: string;
  optimisticPreview: OptimisticPreviewFile | null;
};

export const selectPreviewFile = ({
  file,
  fieldId,
  optimisticPreview,
}: SelectPreviewFileOptions): DocxPreviewFile => {
  if (optimisticPreview?.fieldId !== fieldId) {
    return file;
  }

  return {
    ...file,
    buffer: selectStableArrayBuffer({
      incomingBuffer: file.buffer,
      stableBuffer: optimisticPreview.file.buffer,
    }),
  };
};

type SelectEditorBufferOptions =
  | {
      status: "editing";
      editingBuffer: ArrayBuffer;
      lastEditingBuffer: ArrayBuffer | null;
      preservedLoadedBuffer: ArrayBuffer | null;
      previewBuffer: ArrayBuffer | undefined;
    }
  | {
      status: "released" | "saving";
      editingBuffer?: undefined;
      lastEditingBuffer: ArrayBuffer | null;
      preservedLoadedBuffer: ArrayBuffer | null;
      previewBuffer: ArrayBuffer | undefined;
    }
  | {
      status: "error" | "idle" | "opening";
      editingBuffer?: undefined;
      lastEditingBuffer: ArrayBuffer | null;
      preservedLoadedBuffer: ArrayBuffer | null;
      previewBuffer: ArrayBuffer | undefined;
    };

export const selectEditorBuffer = (
  options: SelectEditorBufferOptions,
): ArrayBuffer | undefined => {
  if (options.status === "editing") {
    return options.editingBuffer;
  }

  // Finalizing and a taken-over session both keep the document the user was
  // working in: reverting to the server preview would drop their unsaved work.
  if (
    (options.status === "saving" || options.status === "released") &&
    options.lastEditingBuffer !== null
  ) {
    return options.lastEditingBuffer;
  }

  return options.preservedLoadedBuffer ?? options.previewBuffer;
};

type SelectDocxBrowserEditorBufferOptions = {
  collaborationSeedBuffer: ArrayBuffer | null;
  lastEditingBuffer: ArrayBuffer | null;
  preservedLoadedBuffer: ArrayBuffer | null;
  previewBuffer?: ArrayBuffer | undefined;
  state: EditSessionState;
};

export const selectDocxBrowserEditorBuffer = ({
  collaborationSeedBuffer,
  lastEditingBuffer,
  preservedLoadedBuffer,
  previewBuffer,
  state,
}: SelectDocxBrowserEditorBufferOptions) => {
  if (collaborationSeedBuffer !== null) {
    return collaborationSeedBuffer;
  }

  if (state.status === "editing") {
    return selectEditorBuffer({
      status: state.status,
      editingBuffer: state.buffer,
      lastEditingBuffer,
      preservedLoadedBuffer,
      previewBuffer,
    });
  }

  return selectEditorBuffer({
    status: state.status,
    lastEditingBuffer,
    preservedLoadedBuffer,
    previewBuffer,
  });
};

type IsDocxEditorUnlockedOptions = {
  canEditCollaboratively: boolean;
  state: EditSessionState;
};

/**
 * What takes the document out of read-only: an acquired edit session, or a
 * collaboration room that accepts this reader's edits. Every other status,
 * including a session another tab took over, renders the document as it is.
 */
export const isDocxEditorUnlocked = ({
  canEditCollaboratively,
  state,
}: IsDocxEditorUnlockedOptions) =>
  canEditCollaboratively || state.status === "editing";

type ShouldFinalizeEditSessionOptions = {
  isDirty: boolean;
  hasSessionChanges: boolean;
  hasPendingEditorChanges: boolean;
};

export const shouldFinalizeEditSession = ({
  isDirty,
  hasSessionChanges,
  hasPendingEditorChanges,
}: ShouldFinalizeEditSessionOptions) =>
  isDirty || hasSessionChanges || hasPendingEditorChanges;

export type DocxLeaveAction = "allow" | "block" | "finalize" | "retryFinalize";

export const getDocxLeaveAction = (
  state: EditSessionState,
): DocxLeaveAction => {
  switch (state.status) {
    case "idle":
    case "opening":
      return "allow";
    case "editing":
      return "finalize";
    case "saving":
      return "block";
    case "released":
      // The lock is gone, so there is nothing left to save or wait for.
      return "allow";
    case "error":
      return state.source === "finalize" ? "retryFinalize" : "block";
    default:
      return panic("Unsupported DOCX edit-session state");
  }
};

type CollaborationPublicationCut = {
  documentMutationRevision: number;
  generation: number;
  roomId: string;
};

export const shouldReuseCollaborationPublication = ({
  current,
  pending,
}: {
  current: CollaborationPublicationCut;
  pending: CollaborationPublicationCut;
}) =>
  pending.roomId === current.roomId &&
  pending.generation === current.generation &&
  pending.documentMutationRevision === current.documentMutationRevision;

type ShouldPromptReadonlyUnlockOptions = {
  canUnlock: boolean;
  isEditing: boolean;
};

export const shouldPromptReadonlyUnlock = ({
  canUnlock,
  isEditing,
}: ShouldPromptReadonlyUnlockOptions) => canUnlock && !isEditing;

type ShouldRequestEditFromMouseDownOptions = {
  canUnlock: boolean;
  isEditing: boolean;
  isToolbarTarget: boolean;
};

/** Toolbar commands act on the readonly document without opening an edit session. */
export const shouldRequestEditFromMouseDown = ({
  canUnlock,
  isEditing,
  isToolbarTarget,
}: ShouldRequestEditFromMouseDownOptions) =>
  canUnlock && !isEditing && !isToolbarTarget;

type ShouldBlockDocxEditOptions = {
  canSafelyEdit: boolean | undefined;
};

export type DocxEditBlockReason = "pendingCompatibility" | "unsafe";

/**
 * Why a request to enter edit mode did not reach it. `collaboration` and
 * `opening` are the waits the editor cannot answer synchronously: the shared
 * session is being joined, or an edit session is already opening.
 * `collaborationReadOnly` is not a wait: the shared session this reader joined
 * does not take edits at all.
 */
export type DocxEditModeBlockReason =
  | DocxEditBlockReason
  | "collaboration"
  | "collaborationReadOnly"
  | "opening";

/**
 * The answer to "put this document into edit mode". A caller holding the
 * user's unsaved input needs the reason, not a bare false: every block here
 * is something to tell the user before their input is thrown away.
 */
export type DocxEditModeResult =
  | { type: "editing" }
  | { type: "blocked"; reason: DocxEditModeBlockReason };

export const getDocxEditBlockReason = ({
  canSafelyEdit,
}: ShouldBlockDocxEditOptions): DocxEditBlockReason | null => {
  if (canSafelyEdit === undefined) {
    return "pendingCompatibility";
  }

  if (!canSafelyEdit) {
    return "unsafe";
  }

  return null;
};

export const shouldBlockDocxEdit = ({
  canSafelyEdit,
}: ShouldBlockDocxEditOptions) =>
  getDocxEditBlockReason({ canSafelyEdit }) !== null;

/**
 * The DOCX rewrite-safety state the chat overlay consumes: `unsafe` and
 * `checking` (compatibility probe still pending) both withhold the AI edit
 * tool, but only `unsafe` surfaces the "View only" chip. `safe` means the
 * probe confirmed the document round-trips.
 */
export const getDocxEditSafety = ({
  canSafelyEdit,
}: ShouldBlockDocxEditOptions): DocxEditSafety => {
  switch (getDocxEditBlockReason({ canSafelyEdit })) {
    case "unsafe":
      return "unsafe";
    case "pendingCompatibility":
      return "checking";
    case null:
      return "safe";
    default:
      return panic("Unsupported DOCX edit safety state");
  }
};

type ShouldUseDocxBrowserEditorOptions = {
  isDocxFile: boolean;
  hasFilePropertyId: boolean;
};

/**
 * Folio is the only renderer for DOCX in the inspector and the
 * document route — current and older versions alike. The previous
 * "isCurrentVersionFile" gate kicked older versions onto a PDF
 * derivative, which served bytes faster but left the AI without
 * block ids to target. Read-only Folio still parses the doc, so
 * version browsing keeps full block structure.
 *
 */
export const shouldUseDocxBrowserEditor = ({
  isDocxFile,
  hasFilePropertyId,
}: ShouldUseDocxBrowserEditorOptions) => isDocxFile && hasFilePropertyId;

type EditSessionErrorMessageKey =
  | "folio.editAuthRequired"
  | "folio.editPermissionDenied"
  | "folio.editDownloadFailed"
  | "folio.editOpenFailed";

export const editSessionErrorDescriptionKey = (
  reason: EditSessionErrorReason,
): EditSessionErrorMessageKey => {
  switch (reason) {
    case "authRequired":
      return "folio.editAuthRequired";
    case "permissionDenied":
      return "folio.editPermissionDenied";
    case "downloadFailed":
      return "folio.editDownloadFailed";
    case "unknown":
      return "folio.editOpenFailed";
    default: {
      reason satisfies never;
      return panic(`Unhandled reason: ${String(reason)}`);
    }
  }
};

/** A failure that replaces the editor with a closable error message. */
export type DocxEditorBlockingError =
  | {
      type: "finalizeFailed";
      reason: EditSessionErrorReason;
      detail: string | undefined;
    }
  | { type: "collaborationUnavailable"; message: string };

type GetDocxEditorBlockingErrorOptions = {
  collaborationState: FolioCollaborationRoomState;
  state: EditSessionState;
};

export const getDocxEditorBlockingError = ({
  collaborationState,
  state,
}: GetDocxEditorBlockingErrorOptions): DocxEditorBlockingError | null => {
  if (state.status === "error" && state.source === "finalize") {
    return {
      type: "finalizeFailed",
      reason: state.reason,
      detail: state.detail,
    };
  }
  if (
    collaborationState.status === "unavailable" &&
    collaborationState.message !== null
  ) {
    return {
      type: "collaborationUnavailable",
      message: collaborationState.message,
    };
  }
  return null;
};
