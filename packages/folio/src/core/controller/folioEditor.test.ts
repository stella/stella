import { describe, expect, mock, test } from "bun:test";
import type { Command, EditorState, Transaction } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";

import type { Layout } from "../layout-engine/types";
import type { Document } from "../types/document";
import { createFolioEditor } from "./folioEditor";
import { createFolioEditorEmitter } from "./folioEditorEvents";
import type { HiddenEditorApi } from "./hiddenEditorApi";
import type { LayoutRunOptions } from "./layoutScheduler";

// Sentinels: opaque stand-ins for the heavy PM/layout objects. The controller
// only forwards these through; it never inspects them, so a tagged object stands
// in for the real type without constructing a real EditorState/Layout.
/* oxlint-disable typescript/no-unsafe-type-assertion -- opaque test sentinels, forwarded only */
const sentinelState = { sentinel: "state" } as unknown as EditorState;
const sentinelView = { sentinel: "view" } as unknown as EditorView;
const sentinelDocument = { sentinel: "document" } as unknown as Document;
const sentinelLayout = { sentinel: "layout" } as unknown as Layout;
const sentinelTr = { sentinel: "tr" } as unknown as Transaction;
const sentinelCommand = { sentinel: "command" } as unknown as Command;
/* oxlint-enable typescript/no-unsafe-type-assertion */

type Call = { method: string; args: unknown[] };

const createFakeApi = (): { api: HiddenEditorApi; calls: Call[] } => {
  const calls: Call[] = [];
  const record =
    (method: string) =>
    (...args: unknown[]): void => {
      calls.push({ method, args });
    };
  const api: HiddenEditorApi = {
    ensureView: record("ensureView"),
    isViewRequested: () => {
      calls.push({ method: "isViewRequested", args: [] });
      return true;
    },
    getState: () => {
      calls.push({ method: "getState", args: [] });
      return sentinelState;
    },
    getView: () => {
      calls.push({ method: "getView", args: [] });
      return sentinelView;
    },
    getDocument: () => {
      calls.push({ method: "getDocument", args: [] });
      return sentinelDocument;
    },
    focus: record("focus"),
    blur: record("blur"),
    isFocused: () => {
      calls.push({ method: "isFocused", args: [] });
      return true;
    },
    dispatch: record("dispatch"),
    executeCommand: (command) => {
      calls.push({ method: "executeCommand", args: [command] });
      return true;
    },
    undo: () => {
      calls.push({ method: "undo", args: [] });
      return true;
    },
    redo: () => {
      calls.push({ method: "redo", args: [] });
      return true;
    },
    canUndo: () => {
      calls.push({ method: "canUndo", args: [] });
      return true;
    },
    canRedo: () => {
      calls.push({ method: "canRedo", args: [] });
      return true;
    },
    setSelection: record("setSelection"),
    setNodeSelection: record("setNodeSelection"),
    setCellSelection: record("setCellSelection"),
    scrollToSelection: record("scrollToSelection"),
  };
  return { api, calls };
};

describe("createFolioEditor", () => {
  test("delegating methods forward args and return the underlying value", () => {
    const { api, calls } = createFakeApi();
    const runLayout = mock<(s: EditorState, o: LayoutRunOptions) => void>();
    const editor = createFolioEditor({
      getEditorApi: () => api,
      getLayout: () => sentinelLayout,
      runLayout,
      emitter: createFolioEditorEmitter(),
    });

    expect(editor.isViewRequested()).toBe(true);
    expect(editor.getState()).toBe(sentinelState);
    expect(editor.getView()).toBe(sentinelView);
    expect(editor.getDocument()).toBe(sentinelDocument);
    expect(editor.isFocused()).toBe(true);
    expect(editor.executeCommand(sentinelCommand)).toBe(true);
    expect(editor.undo()).toBe(true);
    expect(editor.redo()).toBe(true);
    expect(editor.canUndo()).toBe(true);
    expect(editor.canRedo()).toBe(true);

    editor.ensureView();
    editor.focus();
    editor.blur();
    editor.dispatch(sentinelTr);
    editor.setSelection(2, 5);
    editor.setNodeSelection(7);
    editor.setCellSelection(3, 9);
    editor.scrollToSelection();

    expect(calls).toContainEqual({ method: "ensureView", args: [] });
    expect(calls).toContainEqual({ method: "dispatch", args: [sentinelTr] });
    expect(calls).toContainEqual({ method: "setSelection", args: [2, 5] });
    expect(calls).toContainEqual({ method: "setNodeSelection", args: [7] });
    expect(calls).toContainEqual({ method: "setCellSelection", args: [3, 9] });
    expect(calls).toContainEqual({
      method: "executeCommand",
      args: [sentinelCommand],
    });
  });

  test("reads the editor api fresh on every call", () => {
    let current: HiddenEditorApi | null = null;
    const runLayout = mock<(s: EditorState, o: LayoutRunOptions) => void>();
    const editor = createFolioEditor({
      getEditorApi: () => current,
      getLayout: () => null,
      runLayout,
      emitter: createFolioEditorEmitter(),
    });

    expect(editor.getState()).toBeNull();

    const { api } = createFakeApi();
    current = api;
    expect(editor.getState()).toBe(sentinelState);
  });

  test("getters yield documented defaults when there is no view", () => {
    const runLayout = mock<(s: EditorState, o: LayoutRunOptions) => void>();
    const editor = createFolioEditor({
      getEditorApi: () => null,
      getLayout: () => null,
      runLayout,
      emitter: createFolioEditorEmitter(),
    });

    expect(editor.getState()).toBeNull();
    expect(editor.getView()).toBeNull();
    expect(editor.getDocument()).toBeNull();
    expect(editor.isViewRequested()).toBe(false);
    expect(editor.isFocused()).toBe(false);
    expect(editor.executeCommand(sentinelCommand)).toBe(false);
    expect(editor.undo()).toBe(false);
    expect(editor.redo()).toBe(false);
    expect(editor.canUndo()).toBe(false);
    expect(editor.canRedo()).toBe(false);
  });

  test("void methods are no-ops when there is no view", () => {
    const runLayout = mock<(s: EditorState, o: LayoutRunOptions) => void>();
    const editor = createFolioEditor({
      getEditorApi: () => null,
      getLayout: () => null,
      runLayout,
      emitter: createFolioEditorEmitter(),
    });

    expect(() => {
      editor.ensureView();
      editor.focus();
      editor.blur();
      editor.dispatch(sentinelTr);
      editor.setSelection(0);
      editor.setNodeSelection(0);
      editor.setCellSelection(0, 1);
      editor.scrollToSelection();
    }).not.toThrow();
  });

  test("relayout runs layout for the current state with reason manual", () => {
    const { api } = createFakeApi();
    const runLayout = mock<(s: EditorState, o: LayoutRunOptions) => void>();
    const editor = createFolioEditor({
      getEditorApi: () => api,
      getLayout: () => sentinelLayout,
      runLayout,
      emitter: createFolioEditorEmitter(),
    });

    editor.relayout();

    expect(runLayout).toHaveBeenCalledTimes(1);
    expect(runLayout).toHaveBeenCalledWith(sentinelState, { reason: "manual" });
  });

  test("relayout is a no-op when there is no view", () => {
    const runLayout = mock<(s: EditorState, o: LayoutRunOptions) => void>();
    const editor = createFolioEditor({
      getEditorApi: () => null,
      getLayout: () => null,
      runLayout,
      emitter: createFolioEditorEmitter(),
    });

    editor.relayout();

    expect(runLayout).not.toHaveBeenCalled();
  });

  test("getLayout returns the dep's value", () => {
    const runLayout = mock<(s: EditorState, o: LayoutRunOptions) => void>();
    const editor = createFolioEditor({
      getEditorApi: () => null,
      getLayout: () => sentinelLayout,
      runLayout,
      emitter: createFolioEditorEmitter(),
    });

    expect(editor.getLayout()).toBe(sentinelLayout);
  });

  test("on subscribes through the emitter and the unsubscribe works", () => {
    const emitter = createFolioEditorEmitter();
    const runLayout = mock<(s: EditorState, o: LayoutRunOptions) => void>();
    const editor = createFolioEditor({
      getEditorApi: () => null,
      getLayout: () => null,
      runLayout,
      emitter,
    });

    const seen: Document[] = [];
    const unsubscribe = editor.on("docChange", (doc) => {
      seen.push(doc);
    });

    emitter.emit("docChange", sentinelDocument);
    expect(seen).toEqual([sentinelDocument]);

    unsubscribe();
    emitter.emit("docChange", sentinelDocument);
    expect(seen).toEqual([sentinelDocument]);
  });
});
