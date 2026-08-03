import { afterEach, expect, test } from "bun:test";

import { attachCreateDocumentDraftEditor } from "@/components/chat/create-document-draft-inspector-editor.logic";
import {
  __resetCreateDocumentDraftRuntimeForTests,
  saveCreateDocumentDraft,
} from "@/components/chat/create-document-draft-runtime";

afterEach(() => {
  __resetCreateDocumentDraftRuntimeForTests();
});

test("captures draft bytes before clearing the attached editor ref", async () => {
  const bytes = new Uint8Array([1, 2, 3]).buffer;
  let wasEditorAttachedAtSave = false;
  const editorRef: {
    current: { save: () => Promise<ArrayBuffer> } | null;
  } = { current: null };
  const editor = {
    save: async () => {
      wasEditorAttachedAtSave = editorRef.current !== null;
      return bytes;
    },
  };

  const detachEditor = attachCreateDocumentDraftEditor({
    editor,
    editorRef,
    toolCallId: "tool-1",
  });
  detachEditor();

  expect(await saveCreateDocumentDraft("tool-1")).toEqual({
    status: "saved",
    buffer: bytes,
  });
  expect(wasEditorAttachedAtSave).toBe(true);
  expect(editorRef.current).toBeNull();
});
