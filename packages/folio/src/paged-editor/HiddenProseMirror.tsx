/**
 * HiddenProseMirror Component
 *
 * Off-screen ProseMirror instance that owns all keyboard input and state
 * while the paginated layout engine handles visual output. Responsibilities:
 *
 * - Keyboard input handling
 * - Selection state management
 * - Accessibility (semantic document structure for screen readers)
 * - ProseMirror transaction processing
 *
 * Visibility approach: The editor is moved off-viewport with position:fixed
 * and rendered transparent so it can still receive focus and remain part of
 * the accessibility tree. Content width is kept in sync with the document
 * so that ProseMirror's internal measurements stay valid.
 */

import {
  useRef,
  useEffect,
  useLayoutEffect,
  useCallback,
  useImperativeHandle,
  useState,
} from "react";
import type { CSSProperties, Ref } from "react";

import { panic } from "better-result";
import type {
  Transaction,
  Command,
  Plugin,
  EditorState,
} from "prosemirror-state";
import type { EditorView } from "prosemirror-view";

import {
  collectRemoteSelections,
  createHiddenEditorManager,
  type CollaborationModules,
  type HiddenEditorManager,
  type HiddenProseMirrorCollaboration,
  type HiddenProseMirrorRemoteSelection,
} from "../core/controller/hiddenEditorManager";
import type { ExtensionManager } from "../core/prosemirror/extensions/ExtensionManager";
import type { Document, Theme, StyleDefinitions } from "../core/types/document";
// Import ProseMirror CSS
import "prosemirror-view/style/prosemirror.css";

import "../core/prosemirror/editor.css";

export type {
  HiddenProseMirrorCollaboration,
  HiddenProseMirrorRemoteSelection,
} from "../core/controller/hiddenEditorManager";
export { createHiddenEditorState } from "../core/controller/hiddenEditorManager";

const EMPTY_EXTERNAL_PLUGINS: Plugin[] = [];

let collaborationModulesPromise: Promise<CollaborationModules> | null = null;

const loadCollaborationModules = (): Promise<CollaborationModules> => {
  collaborationModulesPromise ??= Promise.all([
    import("y-prosemirror"),
    import("yjs"),
  ])
    .then(([yProseMirror, yjs]) => ({ yProseMirror, yjs }))
    .catch((error: unknown) => {
      collaborationModulesPromise = null;
      throw error;
    });

  return collaborationModulesPromise;
};

// ============================================================================
// TYPES
// ============================================================================

export type HiddenProseMirrorProps = {
  /** The document to edit */
  document: Document | null;
  /** Document styles for style resolution */
  styles?: StyleDefinitions | null;
  /** Theme for styling */
  theme?: Theme | null;
  /** Width in pixels (should match document content width) */
  widthPx?: number;
  /** Whether the editor is read-only */
  readOnly?: boolean;
  /** Callback when document changes via transaction */
  onTransaction?: (transaction: Transaction, newState: EditorState) => void;
  /** Callback when selection changes */
  onSelectionChange?: (state: EditorState) => void;
  /** External ProseMirror plugins */
  externalPlugins?: Plugin[];
  /** Yjs-backed collaboration document owner. */
  collaboration?: HiddenProseMirrorCollaboration | undefined;
  onRemoteSelectionsChange?:
    | ((selections: HiddenProseMirrorRemoteSelection[]) => void)
    | undefined;
  /** Extension manager for plugins/schema/commands (optional — falls back to default) */
  extensionManager?: ExtensionManager;
  /** Callback when EditorView is ready */
  onEditorViewReady?: (view: EditorView) => void;
  /** Initial state already built by the parent for pre-view layout. */
  precomputedInitialState?: EditorState | null;
  /** Callback when EditorView is destroyed */
  onEditorViewDestroy?: () => void;
  /** Intercept key events before ProseMirror processes them. Return true to prevent PM handling. */
  onKeyDown?: (view: EditorView, event: KeyboardEvent) => boolean;
  /** Callback when a readonly user action would mutate the document. */
  onReadOnlyEditAttempt?: () => void;
};

export type HiddenProseMirrorRef = {
  /** Request the off-screen EditorView (idempotent; creates it when possible). */
  ensureView: () => void;
  /** Whether view creation has been requested. */
  isViewRequested: () => boolean;
  /** Get the ProseMirror EditorState */
  getState: () => EditorState | null;
  /** Get the ProseMirror EditorView */
  getView: () => EditorView | null;
  /** Get the current Document from PM state */
  getDocument: () => Document | null;
  /** Focus the hidden editor */
  focus: () => void;
  /** Blur the hidden editor */
  blur: () => void;
  /** Check if focused */
  isFocused: () => boolean;
  /** Dispatch a transaction */
  dispatch: (tr: Transaction) => void;
  /** Execute a ProseMirror command */
  executeCommand: (command: Command) => boolean;
  /** Undo */
  undo: () => boolean;
  /** Redo */
  redo: () => boolean;
  /** Check if undo is available */
  canUndo: () => boolean;
  /** Check if redo is available */
  canRedo: () => boolean;
  /** Set selection by PM position */
  setSelection: (anchor: number, head?: number) => void;
  /** Set node selection at a PM position (for images, etc.) */
  setNodeSelection: (pos: number) => void;
  /** Set cell selection between two positions inside table cells */
  setCellSelection: (anchorCellPos: number, headCellPos: number) => void;
  /** Scroll the PM view to selection (no-op since hidden) */
  scrollToSelection: () => void;
};

// ============================================================================
// STYLES
// ============================================================================

/**
 * Hidden wrapper styles - visually hidden, focus-safe scroll isolation.
 *
 * The focused ProseMirror contenteditable can ask the browser to reveal its
 * caret. Keeping it inside a tiny overflow-hidden fixed wrapper confines that
 * native scroll work to the wrapper instead of the visible document viewport.
 */
const HIDDEN_WRAPPER_STYLES: CSSProperties = {
  position: "fixed",
  left: "-9999px",
  top: "0",
  width: "1px",
  height: "1px",
  overflow: "hidden",
  opacity: 0,
  zIndex: -1,
  pointerEvents: "none",
  contain: "layout paint",
  overflowAnchor: "none",
  // Don't set aria-hidden - the inner editor remains the accessible document.
};

/**
 * Hidden host styles - full document-width PM mount inside the isolated wrapper.
 */
const HIDDEN_HOST_STYLES: CSSProperties = {
  position: "absolute",
  left: "0",
  top: "0",
  userSelect: "none",
  overflowAnchor: "none",
  // Don't use visibility:hidden - the editor must remain focusable.
};

// ============================================================================
// COMPONENT
// ============================================================================

/**
 * HiddenProseMirror - Off-screen ProseMirror editor for keyboard input
 */
export function HiddenProseMirror(
  props: HiddenProseMirrorProps & { ref?: Ref<HiddenProseMirrorRef> },
) {
  const {
    ref,
    document,
    styles,
    theme: _theme,
    widthPx = 612, // Default Letter width at 72dpi
    readOnly = false,
    onTransaction,
    onSelectionChange,
    externalPlugins = EMPTY_EXTERNAL_PLUGINS,
    collaboration,
    extensionManager,
    onEditorViewReady,
    onEditorViewDestroy,
    onKeyDown,
    onReadOnlyEditAttempt,
    onRemoteSelectionsChange,
    precomputedInitialState,
  } = props;

  const [collaborationModules, setCollaborationModules] =
    useState<CollaborationModules | null>(null);
  const [collaborationModulesError, setCollaborationModulesError] =
    useState<unknown>(null);
  const hasCollaboration = collaboration !== undefined;

  // Refs
  const hostRef = useRef<HTMLDivElement>(null);
  // Manager-input refs: the framework-agnostic view manager reads these via
  // accessor functions, so it always sees the current render's value.
  const readOnlyRef = useRef(readOnly);
  const documentRef = useRef(document);
  const stylesRef = useRef(styles);
  const extensionManagerRef = useRef(extensionManager);
  const externalPluginsRef = useRef(externalPlugins);
  const precomputedInitialStateRef = useRef(precomputedInitialState);
  const collaborationRef = useRef(collaboration);
  const collaborationModulesRef = useRef(collaborationModules);

  // Store callbacks in refs to avoid dependency array issues that cause infinite loops
  // when the parent component passes unstable callback references
  const onTransactionRef = useRef(onTransaction);
  const onSelectionChangeRef = useRef(onSelectionChange);
  const onEditorViewReadyRef = useRef(onEditorViewReady);
  const onEditorViewDestroyRef = useRef(onEditorViewDestroy);
  const onKeyDownRef = useRef(onKeyDown);
  const onReadOnlyEditAttemptRef = useRef(onReadOnlyEditAttempt);
  const onRemoteSelectionsChangeRef = useRef(onRemoteSelectionsChange);

  // Keep refs in sync
  readOnlyRef.current = readOnly;
  stylesRef.current = styles;
  extensionManagerRef.current = extensionManager;
  externalPluginsRef.current = externalPlugins;
  precomputedInitialStateRef.current = precomputedInitialState;
  onTransactionRef.current = onTransaction;
  onSelectionChangeRef.current = onSelectionChange;
  onEditorViewReadyRef.current = onEditorViewReady;
  onEditorViewDestroyRef.current = onEditorViewDestroy;
  onKeyDownRef.current = onKeyDown;
  onReadOnlyEditAttemptRef.current = onReadOnlyEditAttempt;
  onRemoteSelectionsChangeRef.current = onRemoteSelectionsChange;
  collaborationRef.current = collaboration;
  collaborationModulesRef.current = collaborationModules;

  // Keep document ref in sync
  documentRef.current = document;

  // The off-screen EditorView lifecycle (create/destroy, editorProps, and the
  // external-document / editable sync) lives in the framework-agnostic manager;
  // this component keeps the input refs and its effects (which decide *when* to
  // act) and drives the manager through its methods. Created once, like the
  // layout scheduler in PagedEditor.
  const managerRef = useRef<HiddenEditorManager | null>(null);
  if (managerRef.current === null) {
    managerRef.current = createHiddenEditorManager({
      getHost: () => hostRef.current,
      getDocument: () => documentRef.current,
      getStyles: () => stylesRef.current,
      getExtensionManager: () => extensionManagerRef.current,
      getExternalPlugins: () => externalPluginsRef.current,
      getCollaboration: () => collaborationRef.current,
      getCollaborationModules: () => collaborationModulesRef.current,
      getPrecomputedInitialState: () => precomputedInitialStateRef.current,
      getReadOnly: () => readOnlyRef.current,
      getDocumentContext: () => documentRef.current,
      onTransaction: (transaction, newState) =>
        onTransactionRef.current?.(transaction, newState),
      onSelectionChange: (state) => onSelectionChangeRef.current?.(state),
      onKeyDown: (view, event) => onKeyDownRef.current?.(view, event) ?? false,
      onReadOnlyEditAttempt: () => onReadOnlyEditAttemptRef.current?.(),
      onEditorViewReady: (view) => onEditorViewReadyRef.current?.(view),
      onEditorViewDestroy: () => onEditorViewDestroyRef.current?.(),
      onRemoteSelectionsChange: (selections) =>
        onRemoteSelectionsChangeRef.current?.(selections),
    });
  }

  useEffect(() => {
    if (!hasCollaboration) {
      setCollaborationModules(null);
      setCollaborationModulesError(null);
      return undefined;
    }

    let cancelled = false;
    setCollaborationModulesError(null);
    void loadCollaborationModules().then(
      (modules) => {
        if (!cancelled) {
          setCollaborationModules(modules);
          setCollaborationModulesError(null);
        }
        return undefined;
      },
      (error: unknown) => {
        if (!cancelled) {
          setCollaborationModules(null);
          setCollaborationModulesError(error);
        }
        return undefined;
      },
    );

    return () => {
      cancelled = true;
    };
  }, [hasCollaboration]);

  // ========================================================================
  // EditorView Lifecycle
  // ========================================================================

  useEffect(() => {
    const awareness = collaboration?.awareness;
    if (!awareness || !managerRef.current?.getView() || !collaborationModules) {
      onRemoteSelectionsChangeRef.current?.([]);
      return undefined;
    }

    const publishRemoteSelections = () => {
      const view = managerRef.current?.getView();
      if (!view) {
        return;
      }
      onRemoteSelectionsChangeRef.current?.(
        collectRemoteSelections(view.state, awareness, collaborationModules),
      );
    };

    awareness.on("change", publishRemoteSelections);
    publishRemoteSelections();

    return () => {
      awareness.off("change", publishRemoteSelections);
      onRemoteSelectionsChangeRef.current?.([]);
    };
  }, [collaboration?.awareness, collaborationModules]);

  // Stable wrapper so the unmount effect keeps `destroyView` in its dependency
  // array; the teardown body lives in the manager.
  const destroyView = useCallback(() => {
    managerRef.current?.destroyView();
  }, []);

  // Completes a previously-requested-but-deferred creation once the async
  // collaboration modules load. Idempotent and gated by `requested` inside the
  // manager, so it never eagerly creates a view nobody asked for. Runs in the
  // layout phase (like the former create trigger) so the view exists before the
  // passive awareness effect above subscribes to remote selections.
  useLayoutEffect(() => {
    managerRef.current?.retryViewCreation();
  }, [collaborationModules]);

  useEffect(() => () => destroyView(), [destroyView]);

  // Update state when document changes externally (e.g., loading a new file).
  // This should NOT run when the document prop changes due to internal edits
  // being passed back through the parent component's state; the manager owns
  // the external-vs-internal comparison.
  useEffect(() => {
    managerRef.current?.syncExternalDocument();
  }, [
    document,
    styles,
    extensionManager,
    externalPlugins,
    collaboration,
    collaborationModules,
  ]);

  // Update editable state
  useEffect(() => {
    managerRef.current?.syncEditable();
  }, [readOnly]);

  // ========================================================================
  // Imperative Handle
  // ========================================================================

  useImperativeHandle(ref, () => managerRef.current!.api, []);

  if (hasCollaboration && collaborationModulesError) {
    let detail = "unknown error";
    if (collaborationModulesError instanceof Error) {
      detail = collaborationModulesError.message;
    } else if (typeof collaborationModulesError === "string") {
      detail = collaborationModulesError;
    }
    panic(
      `Failed to load collaboration editor modules. Reload the document to retry. Cause: ${detail}`,
    );
  }

  // ========================================================================
  // Render
  // ========================================================================

  return (
    <div
      className="paged-editor__hidden-pm-wrapper"
      style={HIDDEN_WRAPPER_STYLES}
    >
      <div
        ref={hostRef}
        className="paged-editor__hidden-pm"
        style={{
          ...HIDDEN_HOST_STYLES,
          width: widthPx > 0 ? `${widthPx}px` : undefined,
        }}
        // DO NOT set aria-hidden - this editor provides semantic structure
      />
    </div>
  );
}
