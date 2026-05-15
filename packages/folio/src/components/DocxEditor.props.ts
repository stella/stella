import type { CSSProperties, ReactNode } from "react";

import type { EditorView } from "prosemirror-view";

import type {
  FolioAIEditApplyMode,
  FolioAIEditApplyResult,
  FolioAIEditOperation,
  FolioAIEditSnapshot,
} from "../core/ai-edits";
import type { DocxCompatibility } from "../core/docx/compatibility";
import type { SelectionState, TableContextInfo } from "../core/prosemirror";
import type { AnonymizationMatch } from "../core/prosemirror/plugins/anonymizationDecorations";
import type { Document, Theme, TabStop } from "../core/types/document";
import type { DocxInput } from "../core/utils/docxInput";
import type { PagedEditorRef } from "../paged-editor/PagedEditor";
import type { DocumentLoadState } from "./hooks/useDocumentLoader";
import type { SelectionFormatting } from "./Toolbar";

/** Editor mode. Public; mirrors Google Docs editing/suggesting/viewing semantics. */
export type EditorMode = "editing" | "suggesting" | "viewing";

/** How tracked changes render. Internal — drives the display mode dropdown. */
export type DisplayMode =
  | "all-markup"
  | "simple-markup"
  | "no-markup"
  | "original";

/** Image context surfaced to the toolbar when the cursor is on an image node. */
export type ImageContextInfo = {
  pos: number;
  wrapType: string;
  displayMode: string;
  cssFloat: string | null;
  transform: string | null;
  alt: string | null;
  borderWidth: number | null;
  borderColor: string | null;
  borderStyle: string | null;
};

/** Tracked-change context surfaced to the contextual review toolbar. */
export type ActiveTrackedChangeInfo = {
  type: "insertion" | "deletion";
  author: string;
  date: string | null;
  from: number;
  to: number;
};

export type DocxEditorProps = {
  /** Document data — ArrayBuffer, Uint8Array, Blob, or File */
  documentBuffer?: DocxInput | null;
  /** Pre-parsed document (alternative to documentBuffer) */
  document?: Document | null;
  /** Callback when document is saved */
  onSave?: (buffer: ArrayBuffer) => void;
  /** Author name used for comments and track changes */
  author?: string;
  /** Callback when document changes */
  onChange?: (document: Document) => void;
  /** Callback when selection changes */
  onSelectionChange?: (state: SelectionState | null) => void;
  /** Callback on error */
  onError?: (error: Error) => void;
  /** Callback when fonts are loaded */
  onFontsLoaded?: () => void;
  /** Theme for styling */
  theme?: Theme | null;
  /** Whether to show toolbar (default: true) */
  showToolbar?: boolean;
  /** Whether to show zoom control (default: true) */
  showZoomControl?: boolean;
  /** Whether to show page margin guides/boundaries (default: false) */
  showMarginGuides?: boolean;
  /** Color for margin guides (default: '#c0c0c0') */
  marginGuideColor?: string;
  /** Initial zoom level (default: 1.0) */
  initialZoom?: number;
  /** Whether the editor is read-only. When true, hides toolbar and rulers */
  readOnly?: boolean;
  /** Whether comments/tracked changes should auto-open the review sidebar (default: true) */
  autoOpenReviewSidebar?: boolean;
  /** Custom toolbar actions */
  toolbarExtra?: ReactNode;
  /** Additional CSS class name */
  className?: string;
  /** Additional inline styles */
  style?: CSSProperties;
  /** Placeholder when no document */
  placeholder?: ReactNode;
  /** Loading indicator */
  loadingIndicator?: ReactNode;
  /** Keep the current parsed document visible while a new buffer is loading. */
  preserveDocumentWhileLoading?: boolean;
  /** Initial scroll offset for the editor's document scroll container. */
  initialScrollTop?: number;
  /** Callback when the editor's document scroll container scrolls. */
  onScrollTopChange?: (scrollTop: number) => void;
  /** Whether to show the document outline sidebar (default: false) */
  showOutline?: boolean;
  /** Whether to show print button in toolbar (default: true) */
  showPrintButton?: boolean;
  /** Callback when print is triggered */
  onPrint?: () => void;
  /** Callback when content is copied */
  onCopy?: () => void;
  /** Callback when content is cut */
  onCut?: () => void;
  /** Callback when content is pasted */
  onPaste?: () => void;
  /** Editor mode: 'editing' (direct edits), 'suggesting' (track changes), or 'viewing' (read-only). Default: 'editing' */
  mode?: EditorMode;
  /** Callback when the editing mode changes */
  onModeChange?: (mode: EditorMode) => void;
  /** Callback when a readonly user action would mutate the document. */
  onReadonlyEditAttempt?: () => void;
  /** Callback with the parsed document's editing compatibility report. */
  onCompatibilityChange?: (compatibility: DocxCompatibility) => void;
  /**
   * Fires when the live ProseMirror view is captured (or torn down).
   * The host wires this so it can drive the AI suggestion overlay
   * (decoration meta, apply, scroll-to) from outside the editor.
   */
  onEditorViewReady?: (view: EditorView | null) => void;
  /**
   * Fires with the current anonymization match list every time
   * the decoration plugin recomputes it (initial mount, term
   * push, doc edit, async DOCX load). The host uses this to
   * mirror per-document counts and "matching workspace terms"
   * to the inspector facet without polling the plugin state.
   */
  onAnonymizationMatchesChange?: (
    matches: readonly AnonymizationMatch[],
  ) => void;
  /**
   * Fires when the user clicks an anonymization highlight in
   * the rendered document. Hosts use this to push the
   * selection into a sidebar bridge so the inspector facet can
   * scroll/flash the matching row.
   */
  onAnonymizationTermClick?:
    | ((canonical: string, label: string) => void)
    | undefined;
  /**
   * Canonical to mark as selected in the rendered document.
   * The first matching rect scrolls into view whenever
   * `anonymizationSelectionSeq` increments (so repeated
   * sidebar clicks of the same term re-trigger the scroll).
   */
  selectedAnonymizationCanonical?: string | null | undefined;
  /** Monotonic counter from the bridge store; drives the re-scroll. */
  anonymizationSelectionSeq?: number | undefined;
};

/**
 * Imperative handle exposed by the DocxEditor component.
 */
export type DocxEditorRef = {
  /** Get the current document */
  getDocument: () => Document | null;
  /** Whether the live ProseMirror state has edits that have not been serialized. */
  hasPendingChanges: () => boolean;
  /** Get the editor ref */
  getEditorRef: () => PagedEditorRef | null;
  /** Save the document to buffer. Pass { selective: false } to force full repack. */
  save: (options?: { selective?: boolean }) => Promise<ArrayBuffer | null>;
  /** Set zoom level */
  setZoom: (zoom: number) => void;
  /** Get current zoom level */
  getZoom: () => number;
  /** Focus the editor */
  focus: () => void;
  /** Get current page number */
  getCurrentPage: () => number;
  /** Get total page count */
  getTotalPages: () => number;
  /** Scroll to a specific page */
  scrollToPage: (pageNumber: number) => void;
  /** Open print preview */
  openPrintPreview: () => void;
  /** Print the document directly */
  print: () => void;
  /** Load a pre-parsed document programmatically */
  loadDocument: (doc: Document) => void;
  /** Load a DOCX buffer programmatically (ArrayBuffer, Uint8Array, Blob, or File) */
  loadDocumentBuffer: (buffer: DocxInput) => Promise<void>;
  /** Create the block snapshot that an external AI editor should reference. */
  createAIEditSnapshot: () => FolioAIEditSnapshot | null;
  /** Apply AI-authored operations against a previously created block snapshot. */
  applyAIEditOperations: (options: {
    snapshot: FolioAIEditSnapshot;
    operations: FolioAIEditOperation[];
    mode?: FolioAIEditApplyMode;
    author?: string;
  }) => FolioAIEditApplyResult;
  /**
   * Accept the tracked-change marks belonging to a previously applied AI edit.
   * Pass a single id for inserts/standalone deletions, or the full id list
   * (`applied.revisionIds`) for a replace, which has separate ids for its
   * deletion and insertion sides. Returns whether a matching range was found.
   */
  acceptAIEditOperation: (revisionIds: number | readonly number[]) => boolean;
  /**
   * Reject the tracked-change marks belonging to a previously applied AI edit.
   * Same id semantics as `acceptAIEditOperation`.
   */
  rejectAIEditOperation: (revisionIds: number | readonly number[]) => boolean;
  /**
   * Scroll the editor viewport so the tracked-change marks belonging to the
   * given `revisionIds` come into view, and select them. No-op when none of the
   * revisions are present.
   */
  scrollToAIEditOperation: (revisionIds: number | readonly number[]) => boolean;
  /**
   * Scroll the editor viewport so the block referenced by `blockId` is in view,
   * and place the selection inside it. Returns `false` when the block can't be
   * resolved on the live document (e.g. it was edited away).
   *
   * When `snapshot` is supplied, ids resolve against it — required for review
   * panel pending-suggestion navigation, because block ids are sequential and
   * a freshly recomputed snapshot would re-number blocks after a structural
   * accept (insertAfterBlock / deleteBlock). Without `snapshot`, falls back to
   * a fresh-from-live-doc snapshot.
   */
  scrollToBlock: (blockId: string, snapshot?: FolioAIEditSnapshot) => boolean;
};

/** Aggregated internal state held by DocxEditor's top-level reducer slot. */
export type EditorState = {
  documentLoad: DocumentLoadState;
  zoom: number;
  /** Current selection formatting for toolbar */
  selectionFormatting: SelectionFormatting;
  /** Paragraph indent data for ruler */
  paragraphIndentLeft: number;
  paragraphIndentRight: number;
  paragraphFirstLineIndent: number;
  paragraphHangingIndent: boolean;
  paragraphTabs: TabStop[] | null;
  /** ProseMirror table context (for showing table toolbar) */
  pmTableContext: TableContextInfo | null;
  /** Image context when cursor is on an image node */
  pmImageContext: ImageContextInfo | null;
  /** Active tracked change at cursor (for contextual toolbar) */
  activeTrackedChange: ActiveTrackedChangeInfo | null;
};
