import { selectStableArrayBuffer } from "./array-buffer-utils";
import type { EditSessionState } from "./use-edit-session";

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
      status: "saving";
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

  if (options.status === "saving" && options.lastEditingBuffer !== null) {
    return options.lastEditingBuffer;
  }

  return options.preservedLoadedBuffer ?? options.previewBuffer;
};

type SelectDocxBrowserEditorBufferOptions = {
  collaborationSeedBuffer: ArrayBuffer | null;
  isCollaborativeEditing: boolean;
  lastEditingBuffer: ArrayBuffer | null;
  preservedLoadedBuffer: ArrayBuffer | null;
  previewBuffer?: ArrayBuffer | undefined;
  state: EditSessionState;
};

export const selectDocxBrowserEditorBuffer = ({
  collaborationSeedBuffer,
  isCollaborativeEditing,
  lastEditingBuffer,
  preservedLoadedBuffer,
  previewBuffer,
  state,
}: SelectDocxBrowserEditorBufferOptions) => {
  if (isCollaborativeEditing) {
    return collaborationSeedBuffer ?? previewBuffer;
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

type ShouldPromptReadonlyUnlockOptions = {
  canUnlock: boolean;
  isEditing: boolean;
};

export const shouldPromptReadonlyUnlock = ({
  canUnlock,
  isEditing,
}: ShouldPromptReadonlyUnlockOptions) => canUnlock && !isEditing;

type ShouldBlockDocxEditOptions = {
  canSafelyEdit: boolean | undefined;
};

export type DocxEditBlockReason = "pendingCompatibility" | "unsafe";

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

type ShouldUseDocxBrowserEditorOptions = {
  isDocxFile: boolean;
  hasFilePropertyId: boolean;
  isComparing: boolean;
};

/**
 * Folio is the only renderer for DOCX in the inspector and the
 * document route — current and older versions alike. The previous
 * "isCurrentVersionFile" gate kicked older versions onto a PDF
 * derivative, which served bytes faster but left the AI without
 * block ids to target. Read-only Folio still parses the doc, so
 * version browsing keeps full block structure.
 *
 * Comparison mode swaps the live DocxBrowserEditor for a
 * separate Folio surface (the redline overlay) that renders the
 * server-merged DOCX buffer — also Folio, not PDF — so this gate
 * is purely "live editor vs redline overlay", not Folio vs PDF.
 */
export const shouldUseDocxBrowserEditor = ({
  isDocxFile,
  hasFilePropertyId,
  isComparing,
}: ShouldUseDocxBrowserEditorOptions) =>
  isDocxFile && hasFilePropertyId && !isComparing;
