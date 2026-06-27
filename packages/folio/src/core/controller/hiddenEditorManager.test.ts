import { describe, expect, test } from "bun:test";
import type { EditorState, Transaction } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";

import {
  createHiddenEditorManager,
  type HiddenEditorManagerDeps,
  type HiddenProseMirrorRemoteSelection,
} from "./hiddenEditorManager";

// A real DOM-backed EditorView cannot be constructed in this headless test
// environment (repo convention; see hiddenEditorApi.test.ts). These tests cover
// the lifecycle guards that run before any EditorView exists, plus the
// slice-2a API composition that shares the manager's view owner.

type Spy = { calls: number };

type DepsOverrides = Partial<HiddenEditorManagerDeps>;

const makeDeps = (
  overrides: DepsOverrides = {},
): { deps: HiddenEditorManagerDeps; spies: Record<string, Spy> } => {
  const spies: Record<string, Spy> = {
    onTransaction: { calls: 0 },
    onSelectionChange: { calls: 0 },
    onKeyDown: { calls: 0 },
    onReadOnlyEditAttempt: { calls: 0 },
    onEditorViewReady: { calls: 0 },
    onEditorViewDestroy: { calls: 0 },
    onRemoteSelectionsChange: { calls: 0 },
  };

  const deps: HiddenEditorManagerDeps = {
    getHost: () => null,
    getDocument: () => null,
    getStyles: () => null,
    getExtensionManager: () => undefined,
    getExternalPlugins: () => [],
    getCollaboration: () => undefined,
    getCollaborationModules: () => null,
    getPrecomputedInitialState: () => null,
    getReadOnly: () => false,
    getDocumentContext: () => null,
    onTransaction: (_transaction: Transaction, _newState: EditorState) => {
      spies["onTransaction"].calls += 1;
    },
    onSelectionChange: (_state: EditorState) => {
      spies["onSelectionChange"].calls += 1;
    },
    onKeyDown: (_view: EditorView, _event: KeyboardEvent) => {
      spies["onKeyDown"].calls += 1;
      return false;
    },
    onReadOnlyEditAttempt: () => {
      spies["onReadOnlyEditAttempt"].calls += 1;
    },
    onEditorViewReady: (_view: EditorView) => {
      spies["onEditorViewReady"].calls += 1;
    },
    onEditorViewDestroy: () => {
      spies["onEditorViewDestroy"].calls += 1;
    },
    onRemoteSelectionsChange: (
      _selections: HiddenProseMirrorRemoteSelection[],
    ) => {
      spies["onRemoteSelectionsChange"].calls += 1;
    },
    ...overrides,
  };

  return { deps, spies };
};

describe("createHiddenEditorManager", () => {
  test("starts with no view and uninitialized", () => {
    const { deps } = makeDeps();
    const manager = createHiddenEditorManager(deps);
    expect(manager.getView()).toBeNull();
    expect(manager.isInitialized()).toBe(false);
  });

  test("ensureView marks requested but creates nothing without a host", () => {
    const { deps, spies } = makeDeps({ getHost: () => null });
    const manager = createHiddenEditorManager(deps);
    manager.ensureView();
    expect(manager.isViewRequested()).toBe(true);
    expect(manager.getView()).toBeNull();
    expect(manager.isInitialized()).toBe(false);
    expect(spies["onEditorViewReady"].calls).toBe(0);
  });

  test("retryViewCreation does nothing until creation is requested", () => {
    const { deps, spies } = makeDeps({ getHost: () => null });
    const manager = createHiddenEditorManager(deps);
    manager.retryViewCreation();
    expect(manager.isViewRequested()).toBe(false);
    expect(manager.getView()).toBeNull();
    expect(spies["onEditorViewReady"].calls).toBe(0);
  });

  test("destroyView is a no-op without a view", () => {
    const { deps, spies } = makeDeps();
    const manager = createHiddenEditorManager(deps);
    manager.destroyView();
    expect(spies["onEditorViewDestroy"].calls).toBe(0);
  });

  test("syncExternalDocument is a no-op without a view", () => {
    const { deps, spies } = makeDeps();
    const manager = createHiddenEditorManager(deps);
    expect(() => {
      manager.syncExternalDocument();
    }).not.toThrow();
    expect(spies["onSelectionChange"].calls).toBe(0);
  });

  test("syncEditable is a no-op without a view", () => {
    const { deps } = makeDeps();
    const manager = createHiddenEditorManager(deps);
    expect(() => {
      manager.syncEditable();
    }).not.toThrow();
  });

  test("composes an API that shares the manager's (null) view owner", () => {
    const { deps } = makeDeps();
    const manager = createHiddenEditorManager(deps);
    expect(manager.api.getView()).toBeNull();
    expect(manager.api.getState()).toBeNull();
    expect(manager.api.getDocument()).toBeNull();
  });
});
