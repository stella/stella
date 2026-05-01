import { selectStableArrayBuffer } from "./array-buffer-utils";

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
  isCurrentVersionFile: boolean;
  isDocxFile: boolean;
  hasFilePropertyId: boolean;
  isComparing: boolean;
};

export const shouldUseDocxBrowserEditor = ({
  isCurrentVersionFile,
  isDocxFile,
  hasFilePropertyId,
  isComparing,
}: ShouldUseDocxBrowserEditorOptions) =>
  isCurrentVersionFile && isDocxFile && hasFilePropertyId && !isComparing;
