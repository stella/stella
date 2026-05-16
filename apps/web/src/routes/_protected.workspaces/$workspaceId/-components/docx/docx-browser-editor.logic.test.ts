import { describe, expect, test } from "bun:test";

import {
  getDocxEditBlockReason,
  selectDocxBrowserEditorBuffer,
  selectEditorBuffer,
  selectPreviewFile,
  shouldBlockDocxEdit,
  shouldFinalizeEditSession,
  shouldPromptReadonlyUnlock,
  shouldUseDocxBrowserEditor,
} from "./docx-browser-editor.logic";
import type { DocxPreviewFile } from "./docx-browser-editor.logic";

const bufferFrom = (values: number[]) => new Uint8Array(values).buffer;

const previewFile = (buffer: ArrayBuffer): DocxPreviewFile => ({
  buffer,
  fileId: "file-1",
  fileName: "Contract.docx",
  mimeType:
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  originalMimeType:
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
});

describe("DOCX browser editor preview selection", () => {
  test("reuses the optimistic saved buffer when the server preview bytes match", () => {
    const optimisticBuffer = bufferFrom([1, 2, 3]);
    const serverFile = previewFile(bufferFrom([1, 2, 3]));

    const selected = selectPreviewFile({
      file: serverFile,
      fieldId: "field-1",
      optimisticPreview: {
        fieldId: "field-1",
        file: previewFile(optimisticBuffer),
      },
    });

    expect(selected.buffer).toBe(optimisticBuffer);
  });

  test("ignores optimistic previews from another field", () => {
    const serverBuffer = bufferFrom([1, 2, 3]);
    const serverFile = previewFile(serverBuffer);

    const selected = selectPreviewFile({
      file: serverFile,
      fieldId: "field-1",
      optimisticPreview: {
        fieldId: "field-2",
        file: previewFile(bufferFrom([1, 2, 3])),
      },
    });

    expect(selected.buffer).toBe(serverBuffer);
  });
});

describe("DOCX browser editor buffer selection", () => {
  test("uses the edit-session buffer when unlocking", () => {
    const editingBuffer = bufferFrom([1]);
    const previewBuffer = bufferFrom([4]);

    expect(
      selectEditorBuffer({
        status: "editing",
        editingBuffer,
        lastEditingBuffer: bufferFrom([2]),
        preservedLoadedBuffer: null,
        previewBuffer,
      }),
    ).toBe(editingBuffer);
  });

  test("uses the edit-session buffer when no preview is mounted", () => {
    const editingBuffer = bufferFrom([1]);

    expect(
      selectEditorBuffer({
        status: "editing",
        editingBuffer,
        lastEditingBuffer: null,
        preservedLoadedBuffer: null,
        previewBuffer: undefined,
      }),
    ).toBe(editingBuffer);
  });

  test("keeps the last editing buffer mounted during finalize", () => {
    const lastEditingBuffer = bufferFrom([2]);

    expect(
      selectEditorBuffer({
        status: "saving",
        lastEditingBuffer,
        preservedLoadedBuffer: bufferFrom([3]),
        previewBuffer: bufferFrom([4]),
      }),
    ).toBe(lastEditingBuffer);
  });

  test("keeps the already-loaded document mounted after save returns to readonly", () => {
    const preservedLoadedBuffer = bufferFrom([3]);

    expect(
      selectEditorBuffer({
        status: "idle",
        lastEditingBuffer: bufferFrom([2]),
        preservedLoadedBuffer,
        previewBuffer: bufferFrom([4]),
      }),
    ).toBe(preservedLoadedBuffer);
  });

  test("falls back to the preview buffer for ordinary readonly loads", () => {
    const previewBuffer = bufferFrom([4]);

    expect(
      selectEditorBuffer({
        status: "idle",
        lastEditingBuffer: null,
        preservedLoadedBuffer: null,
        previewBuffer,
      }),
    ).toBe(previewBuffer);
  });

  test("uses the collaboration seed buffer before seeding a shared session", () => {
    const seedBuffer = bufferFrom([7]);
    const previewBuffer = bufferFrom([4]);

    expect(
      selectDocxBrowserEditorBuffer({
        collaborationSeedBuffer: seedBuffer,
        isCollaborativeEditing: true,
        lastEditingBuffer: null,
        preservedLoadedBuffer: null,
        previewBuffer,
        state: { status: "idle" },
      }),
    ).toBe(seedBuffer);
  });

  test("falls back to the preview buffer for already-seeded shared sessions", () => {
    const previewBuffer = bufferFrom([4]);

    expect(
      selectDocxBrowserEditorBuffer({
        collaborationSeedBuffer: null,
        isCollaborativeEditing: true,
        lastEditingBuffer: null,
        preservedLoadedBuffer: null,
        previewBuffer,
        state: { status: "idle" },
      }),
    ).toBe(previewBuffer);
  });
});

describe("DOCX readonly unlock prompt", () => {
  test("prompts only when readonly editing is available", () => {
    expect(
      shouldPromptReadonlyUnlock({ canUnlock: true, isEditing: false }),
    ).toBe(true);
    expect(
      shouldPromptReadonlyUnlock({ canUnlock: false, isEditing: false }),
    ).toBe(false);
    expect(
      shouldPromptReadonlyUnlock({ canUnlock: true, isEditing: true }),
    ).toBe(false);
  });
});

describe("DOCX edit finalization", () => {
  test("finalizes if the live editor has pending changes before dirty state catches up", () => {
    expect(
      shouldFinalizeEditSession({
        isDirty: false,
        hasSessionChanges: false,
        hasPendingEditorChanges: true,
      }),
    ).toBe(true);
  });

  test("finalizes previously checkpointed session changes even after dirty resets", () => {
    expect(
      shouldFinalizeEditSession({
        isDirty: false,
        hasSessionChanges: true,
        hasPendingEditorChanges: false,
      }),
    ).toBe(true);
  });

  test("cancels when there were no edit-session changes", () => {
    expect(
      shouldFinalizeEditSession({
        isDirty: false,
        hasSessionChanges: false,
        hasPendingEditorChanges: false,
      }),
    ).toBe(false);
  });
});

describe("DOCX unsupported edit guard", () => {
  test("blocks until compatibility inspection explicitly allows editing", () => {
    expect(shouldBlockDocxEdit({ canSafelyEdit: false })).toBe(true);
    expect(shouldBlockDocxEdit({ canSafelyEdit: true })).toBe(false);
    expect(shouldBlockDocxEdit({ canSafelyEdit: undefined })).toBe(true);
  });

  test("reports why editing is blocked", () => {
    expect(getDocxEditBlockReason({ canSafelyEdit: undefined })).toBe(
      "pendingCompatibility",
    );
    expect(getDocxEditBlockReason({ canSafelyEdit: false })).toBe("unsafe");
    expect(getDocxEditBlockReason({ canSafelyEdit: true })).toBeNull();
  });
});

describe("DOCX browser editor route selection", () => {
  test("uses the DOCX browser editor for any DOCX with a file property", () => {
    expect(
      shouldUseDocxBrowserEditor({
        isDocxFile: true,
        hasFilePropertyId: true,
        isComparing: false,
      }),
    ).toBe(true);
  });

  test("falls back when comparing — redline overlay is bbox-driven", () => {
    expect(
      shouldUseDocxBrowserEditor({
        isDocxFile: true,
        hasFilePropertyId: true,
        isComparing: true,
      }),
    ).toBe(false);
  });

  test("falls back for non-DOCX or files without a file property", () => {
    expect(
      shouldUseDocxBrowserEditor({
        isDocxFile: false,
        hasFilePropertyId: true,
        isComparing: false,
      }),
    ).toBe(false);
    expect(
      shouldUseDocxBrowserEditor({
        isDocxFile: true,
        hasFilePropertyId: false,
        isComparing: false,
      }),
    ).toBe(false);
  });
});
