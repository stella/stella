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
  useCallback,
  useImperativeHandle,
  forwardRef,
  memo,
} from "react";
import type { CSSProperties } from "react";

import { undo, redo } from "prosemirror-history";
import type { Transaction, Command, Plugin } from "prosemirror-state";
import {
  EditorState,
  NodeSelection,
  Selection,
  TextSelection,
} from "prosemirror-state";
import { CellSelection } from "prosemirror-tables";
import { EditorView } from "prosemirror-view";
import type { DirectEditorProps } from "prosemirror-view";

import { toProseDoc, createEmptyDoc } from "../core/prosemirror/conversion";
import { fromProseDoc } from "../core/prosemirror/conversion/fromProseDoc";
import type { ExtensionManager } from "../core/prosemirror/extensions/ExtensionManager";
import { schema } from "../core/prosemirror/schema";
import type { Document, Theme, StyleDefinitions } from "../core/types/document";
import { suppressHiddenEditorScrollToSelection } from "./hiddenEditorScroll";
import { isReadOnlyEditKey } from "./readOnlyEditAttempt";
// Import ProseMirror CSS
import "prosemirror-view/style/prosemirror.css";

import "../core/prosemirror/editor.css";

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
  /** Extension manager for plugins/schema/commands (optional — falls back to default) */
  extensionManager?: ExtensionManager;
  /** Callback when EditorView is ready */
  onEditorViewReady?: (view: EditorView) => void;
  /** Callback when EditorView is destroyed */
  onEditorViewDestroy?: () => void;
  /** Intercept key events before ProseMirror processes them. Return true to prevent PM handling. */
  onKeyDown?: (view: EditorView, event: KeyboardEvent) => boolean;
  /** Callback when a readonly user action would mutate the document. */
  onReadOnlyEditAttempt?: () => void;
};

export type HiddenProseMirrorRef = {
  /** Get the ProseMirror EditorState */
  getState(): EditorState | null;
  /** Get the ProseMirror EditorView */
  getView(): EditorView | null;
  /** Get the current Document from PM state */
  getDocument(): Document | null;
  /** Focus the hidden editor */
  focus(): void;
  /** Blur the hidden editor */
  blur(): void;
  /** Check if focused */
  isFocused(): boolean;
  /** Dispatch a transaction */
  dispatch(tr: Transaction): void;
  /** Execute a ProseMirror command */
  executeCommand(command: Command): boolean;
  /** Undo */
  undo(): boolean;
  /** Redo */
  redo(): boolean;
  /** Check if undo is available */
  canUndo(): boolean;
  /** Check if redo is available */
  canRedo(): boolean;
  /** Set selection by PM position */
  setSelection(anchor: number, head?: number): void;
  /** Set node selection at a PM position (for images, etc.) */
  setNodeSelection(pos: number): void;
  /** Set cell selection between two positions inside table cells */
  setCellSelection(anchorCellPos: number, headCellPos: number): void;
  /** Scroll the PM view to selection (no-op since hidden) */
  scrollToSelection(): void;
};

// ============================================================================
// STYLES
// ============================================================================

/**
 * Hidden host styles - visually hidden but focusable
 */
const HIDDEN_HOST_STYLES: CSSProperties = {
  // Position off-screen but in document flow for accessibility
  position: "fixed",
  left: "-9999px",
  top: "0",
  // Hide visually but keep focusable (NOT visibility:hidden!)
  opacity: 0,
  zIndex: -1,
  // Prevent interaction with visual layer
  pointerEvents: "none",
  // Prevent text selection in hidden area
  userSelect: "none",
  // Prevent scroll anchoring issues
  overflowAnchor: "none",
  // Don't set aria-hidden - editor must remain accessible to screen readers
};

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Create ProseMirror state from document
 *
 * When an ExtensionManager is provided, it supplies the schema and plugins.
 * Otherwise falls back to the default singleton schema with no extension plugins.
 */
function createInitialState(
  document: Document | null,
  styles: StyleDefinitions | null | undefined,
  manager?: ExtensionManager,
  externalPlugins: Plugin[] = [],
): EditorState {
  const activeSchema = manager?.getSchema() ?? schema;
  let doc = createEmptyDoc();
  if (document) {
    doc =
      styles === undefined || styles === null
        ? toProseDoc(document)
        : toProseDoc(document, { styles });
  }

  // External plugins go first so they can intercept before extension keymaps
  // (e.g. suggestion mode must handle Backspace/Delete before deleteSelection)
  const plugins: Plugin[] = [
    ...externalPlugins,
    ...(manager?.getPlugins() ?? []),
  ];

  return EditorState.create({
    doc,
    schema: activeSchema,
    plugins,
  });
}

/**
 * Convert PM state to Document
 */
function stateToDocument(
  state: EditorState,
  originalDoc: Document | null,
): Document | null {
  if (!originalDoc) {
    return null;
  }

  // fromProseDoc preserves the base document structure when provided
  return fromProseDoc(state.doc, originalDoc);
}

// ============================================================================
// COMPONENT
// ============================================================================

/**
 * HiddenProseMirror - Off-screen ProseMirror editor for keyboard input
 */
const HiddenProseMirrorComponent = forwardRef<
  HiddenProseMirrorRef,
  HiddenProseMirrorProps
>(function HiddenProseMirror(props, ref) {
  const {
    document,
    styles,
    theme: _theme,
    widthPx = 612, // Default Letter width at 72dpi
    readOnly = false,
    onTransaction,
    onSelectionChange,
    externalPlugins = [],
    extensionManager,
    onEditorViewReady,
    onEditorViewDestroy,
    onKeyDown,
    onReadOnlyEditAttempt,
  } = props;

  // Refs
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const readOnlyRef = useRef(readOnly);
  const documentRef = useRef(document);
  const isDestroyingRef = useRef(false);
  // Track the document identity to detect truly external changes
  // vs changes that originated from editing (which get passed back through props)
  const lastDocumentIdRef = useRef<string | null>(null);
  // Track if we've initialized - first render needs to set up state
  const isInitializedRef = useRef(false);

  // Store callbacks in refs to avoid dependency array issues that cause infinite loops
  // when the parent component passes unstable callback references
  const onTransactionRef = useRef(onTransaction);
  const onSelectionChangeRef = useRef(onSelectionChange);
  const onEditorViewReadyRef = useRef(onEditorViewReady);
  const onEditorViewDestroyRef = useRef(onEditorViewDestroy);
  const onKeyDownRef = useRef(onKeyDown);
  const onReadOnlyEditAttemptRef = useRef(onReadOnlyEditAttempt);

  // Keep refs in sync
  readOnlyRef.current = readOnly;
  onTransactionRef.current = onTransaction;
  onSelectionChangeRef.current = onSelectionChange;
  onEditorViewReadyRef.current = onEditorViewReady;
  onEditorViewDestroyRef.current = onEditorViewDestroy;
  onKeyDownRef.current = onKeyDown;
  onReadOnlyEditAttemptRef.current = onReadOnlyEditAttempt;

  // Keep document ref in sync
  documentRef.current = document;

  // ========================================================================
  // EditorView Lifecycle
  // ========================================================================

  /**
   * Create EditorView with proper dispatch handling
   * Uses refs for callbacks to avoid infinite re-render loops
   */
  const createView = useCallback(() => {
    if (!hostRef.current || isDestroyingRef.current) {
      return;
    }

    const initialState = createInitialState(
      document,
      styles,
      extensionManager,
      externalPlugins,
    );

    const editorProps: DirectEditorProps = {
      state: initialState,
      editable: () => !readOnlyRef.current,
      dispatchTransaction: (transaction: Transaction) => {
        if (!viewRef.current || isDestroyingRef.current) {
          return;
        }

        if (readOnlyRef.current && transaction.docChanged) {
          onReadOnlyEditAttemptRef.current?.();
          return;
        }

        const newState = viewRef.current.state.apply(transaction);
        viewRef.current.updateState(newState);

        // Notify about transaction (use ref to avoid dependency issues)
        onTransactionRef.current?.(transaction, newState);

        // Notify about selection changes (use ref to avoid dependency issues)
        if (transaction.selectionSet || transaction.docChanged) {
          onSelectionChangeRef.current?.(newState);
        }
      },
      // Intercept key events before ProseMirror processes them
      handleKeyDown: (view: EditorView, event: KeyboardEvent): boolean => {
        if (readOnlyRef.current && isReadOnlyEditKey(event)) {
          onReadOnlyEditAttemptRef.current?.();
          event.preventDefault();
          return true;
        }

        return onKeyDownRef.current?.(view, event) ?? false;
      },
      handleScrollToSelection: suppressHiddenEditorScrollToSelection,
      // Prevent focus handling from interfering with visual layer
      handleDOMEvents: {
        focus: () => false,
        blur: () => false,
        beforeinput: (_view, event) => {
          if (!readOnlyRef.current) {
            return false;
          }
          onReadOnlyEditAttemptRef.current?.();
          event.preventDefault();
          return true;
        },
        paste: (_view, event) => {
          if (!readOnlyRef.current) {
            return false;
          }
          onReadOnlyEditAttemptRef.current?.();
          event.preventDefault();
          return true;
        },
        drop: (_view, event) => {
          if (!readOnlyRef.current) {
            return false;
          }
          onReadOnlyEditAttemptRef.current?.();
          event.preventDefault();
          return true;
        },
      },
    };

    viewRef.current = new EditorView(hostRef.current, editorProps);

    // Notify that view is ready (use ref to avoid dependency issues)
    onEditorViewReadyRef.current?.(viewRef.current);
  }, [
    document,
    styles,
    externalPlugins,
    extensionManager,
    // Callbacks removed from dependencies - accessed via refs
  ]);

  /**
   * Destroy EditorView
   */
  const destroyView = useCallback(() => {
    if (viewRef.current && !isDestroyingRef.current) {
      isDestroyingRef.current = true;

      // Use ref to avoid dependency issues
      onEditorViewDestroyRef.current?.();

      viewRef.current.destroy();
      viewRef.current = null;
      isDestroyingRef.current = false;
    }
  }, []);

  // Mount/unmount
  useEffect(() => {
    createView();
    return () => destroyView();
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Only on mount/unmount

  // Update state when document changes externally (e.g., loading a new file)
  // This should NOT run when the document prop changes due to internal edits
  // being passed back through the parent component's state
  useEffect(() => {
    if (!viewRef.current || isDestroyingRef.current) {
      return;
    }

    // Generate a simple document identity based on its structure
    // This helps detect truly different documents vs the same doc passed back after editing
    const getDocumentId = (doc: Document | null): string => {
      if (!doc) {
        return "empty";
      }
      // Use the document's package id or a hash of its structure
      // For simplicity, we compare based on whether it's a different document object
      // and whether it has different metadata
      const meta = doc.package.properties;
      const created = meta?.created ? String(meta.created) : "";
      const modified = meta?.modified ? String(meta.modified) : "";
      const title = meta?.title ?? "";
      return `${created}-${modified}-${title}`;
    };

    const currentDocId = getDocumentId(document);

    // Skip if this is the same document (likely passed back after internal edit)
    // Only reset state if:
    // 1. Not yet initialized (first mount)
    // 2. Document identity changed (truly external change like loading a new file)
    if (
      isInitializedRef.current &&
      currentDocId === lastDocumentIdRef.current
    ) {
      return;
    }

    // Update tracking refs
    isInitializedRef.current = true;
    lastDocumentIdRef.current = currentDocId;

    // Create new state from document
    const newState = createInitialState(
      document,
      styles,
      extensionManager,
      externalPlugins,
    );
    viewRef.current.updateState(newState);

    // Use ref to avoid infinite loop when callback is unstable
    onSelectionChangeRef.current?.(newState);
  }, [document, styles, extensionManager, externalPlugins]);
  // NOTE: onSelectionChange removed from dependencies - accessed via ref to prevent infinite loops

  // Update editable state
  useEffect(() => {
    if (!viewRef.current) {
      return;
    }
    // EditorView will call editable() on each check, so we don't need to update
  }, [readOnly]);

  // ========================================================================
  // Imperative Handle
  // ========================================================================

  useImperativeHandle(
    ref,
    () => ({
      getState() {
        return viewRef.current?.state ?? null;
      },

      getView() {
        return viewRef.current ?? null;
      },

      getDocument() {
        if (!viewRef.current) {
          return null;
        }
        return stateToDocument(viewRef.current.state, documentRef.current);
      },

      focus() {
        viewRef.current?.focus();
      },

      blur() {
        const dom = viewRef.current?.dom;
        if (viewRef.current?.hasFocus() && dom instanceof HTMLElement) {
          dom.blur();
        }
      },

      isFocused() {
        return viewRef.current?.hasFocus() ?? false;
      },

      dispatch(tr: Transaction) {
        if (viewRef.current && !isDestroyingRef.current) {
          viewRef.current.dispatch(tr);
        }
      },

      executeCommand(command: Command) {
        if (!viewRef.current) {
          return false;
        }
        return command(
          viewRef.current.state,
          viewRef.current.dispatch,
          viewRef.current,
        );
      },

      undo() {
        if (!viewRef.current) {
          return false;
        }
        return undo(viewRef.current.state, viewRef.current.dispatch);
      },

      redo() {
        if (!viewRef.current) {
          return false;
        }
        return redo(viewRef.current.state, viewRef.current.dispatch);
      },

      canUndo() {
        if (!viewRef.current) {
          return false;
        }
        return undo(viewRef.current.state);
      },

      canRedo() {
        if (!viewRef.current) {
          return false;
        }
        return redo(viewRef.current.state);
      },

      setSelection(anchor: number, head?: number) {
        if (!viewRef.current) {
          return;
        }
        const { state, dispatch } = viewRef.current;
        const docEnd = state.doc.content.size;
        const clampedAnchor = Math.max(0, Math.min(anchor, docEnd));
        const clampedHead =
          head === undefined
            ? clampedAnchor
            : Math.max(0, Math.min(head, docEnd));
        const $anchor = state.doc.resolve(clampedAnchor);
        const $head = state.doc.resolve(clampedHead);
        const selection =
          head === undefined
            ? Selection.near($anchor)
            : TextSelection.between($anchor, $head);
        dispatch(state.tr.setSelection(selection));
      },

      setNodeSelection(pos: number) {
        if (!viewRef.current) {
          return;
        }
        const { state, dispatch } = viewRef.current;
        try {
          const selection = NodeSelection.create(state.doc, pos);
          dispatch(state.tr.setSelection(selection));
        } catch {
          // Fallback to text selection if NodeSelection fails
          this.setSelection(pos);
        }
      },

      setCellSelection(anchorCellPos: number, headCellPos: number) {
        if (!viewRef.current) {
          return;
        }
        const { state, dispatch } = viewRef.current;
        try {
          const cellSel = CellSelection.create(
            state.doc,
            anchorCellPos,
            headCellPos,
          );
          dispatch(state.tr.setSelection(cellSel));
        } catch {
          // Fallback to text selection if positions aren't valid for CellSelection
          this.setSelection(anchorCellPos, headCellPos);
        }
      },

      scrollToSelection() {
        // No-op for hidden editor - visual scrolling handled by PagedEditor
      },
    }),
    [],
  );

  // ========================================================================
  // Render
  // ========================================================================

  return (
    <div
      ref={hostRef}
      className="paged-editor__hidden-pm"
      style={{
        ...HIDDEN_HOST_STYLES,
        width: widthPx > 0 ? `${widthPx}px` : undefined,
      }}
      // DO NOT set aria-hidden - this editor provides semantic structure
    />
  );
});

export const HiddenProseMirror = memo(HiddenProseMirrorComponent);
