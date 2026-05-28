/**
 * PagedEditor Component
 *
 * Main paginated editing component that integrates:
 * - HiddenProseMirror: off-screen editor for keyboard input
 * - Layout engine: computes page layout from PM state
 * - DOM painter: renders pages to visible DOM
 * - Selection overlay: renders caret and selection highlights
 *
 * Architecture:
 * 1. User clicks on visible pages → hit test → update PM selection
 * 2. User types → hidden PM receives input → PM transaction
 * 3. PM transaction → convert to blocks → measure → layout → paint
 * 4. Selection changes → compute rects → update overlay
 */

import React, {
  useRef,
  useState,
  useCallback,
  useEffect,
  useMemo,
  useImperativeHandle,
} from "react";
import type { CSSProperties, Ref } from "react";
import { flushSync } from "react-dom";

import type { Mark, Node as PMNode } from "prosemirror-model";
import { NodeSelection, TextSelection } from "prosemirror-state";
import type { EditorState, Transaction, Plugin } from "prosemirror-state";
import { CellSelection } from "prosemirror-tables";
import type { EditorView } from "prosemirror-view";

import { HiddenHeaderFooterPMs } from "../components/HiddenHeaderFooterPMs";
import type { HiddenHeaderFooterPMsRef } from "../components/HiddenHeaderFooterPMs";
import { getFootnoteText } from "../core/docx/footnoteParser";
import { clickToPosition } from "../core/layout-bridge/clickToPosition";
import { clickToPositionDom } from "../core/layout-bridge/clickToPositionDom";
import {
  findBodyEmptyRuns,
  findBodyPmAnchor,
  findBodyPmAnchors,
  findBodyPmSpans,
} from "../core/layout-bridge/findBodyPmSpans";
import {
  findHfPmAnchor,
  findHfSlotForTarget,
} from "../core/layout-bridge/findHfPmSpans";
import {
  collectFootnoteRefs,
  buildFootnoteContentMap,
} from "../core/layout-bridge/footnoteLayout";
import {
  convertHeaderFooterPmDocToContent,
  convertHeaderFooterToContent,
} from "../core/layout-bridge/headerFooterLayout";
import type {
  ConvertHeaderFooterOptions,
  HeaderFooterMetrics,
} from "../core/layout-bridge/headerFooterLayout";
import {
  hitTestFragment,
  hitTestTableCell,
  getPageTop,
} from "../core/layout-bridge/hitTest";
import {
  measureParagraph,
  resetCanvasContext,
  clearAllCaches,
  getCachedParagraphMeasure,
  setCachedParagraphMeasure,
} from "../core/layout-bridge/measuring";
import type { FloatingImageZone } from "../core/layout-bridge/measuring";
import type {
  SelectionRect,
  CaretPosition,
} from "../core/layout-bridge/selectionRects";
import type * as SelectionGeometry from "../core/layout-bridge/selectionRects";
// Layout bridge
import { toFlowBlocks } from "../core/layout-bridge/toFlowBlocks";
import type { ToFlowBlocksOptions } from "../core/layout-bridge/toFlowBlocks";
// Layout engine
import { layoutDocument } from "../core/layout-engine";
import type { ColumnLayout, SectionLayoutConfig } from "../core/layout-engine";
import type {
  Layout,
  FlowBlock,
  Measure,
  ParagraphMeasure,
  ParagraphBlock,
  TableBlock,
  TableCell,
  TableMeasure,
  TableCellMeasure,
  ImageBlock,
  ImageRun,
  PageMargins,
  SectionBreakBlock,
  TextBoxBlock,
  FootnoteContent,
} from "../core/layout-engine/types";
import { DEFAULT_TEXTBOX_MARGINS } from "../core/layout-engine/types";
// Layout painter
import { LayoutPainter } from "../core/layout-painter";
import type { BlockLookup } from "../core/layout-painter";
import {
  findPageShellForPmPos,
  PAINTER_PAINTED_EVENT,
  renderPages,
} from "../core/layout-painter/renderPage";
import type {
  HeaderFooterContent,
  RenderPageOptions,
  FootnoteRenderItem,
} from "../core/layout-painter/renderPage";
// Table commands (for quick-action insert buttons)
import { addRowBelow, addColumnRight } from "../core/prosemirror";
import {
  expectFontFamilyMarkAttrs,
  expectImageAttrs,
  expectTableAttrs,
  expectTableCellAttrs,
  mergeImageAttrs,
  mergeTableAttrs,
  mergeTableCellAttrs,
  mergeTableRowAttrs,
} from "../core/prosemirror/attrs";
import { proseDocToBlocks } from "../core/prosemirror/conversion/fromProseDoc";
import type { ExtensionManager } from "../core/prosemirror/extensions/ExtensionManager";
import { anonymizationDecorationsKey } from "../core/prosemirror/plugins/anonymizationDecorations";
import type { AnonymizationMatch } from "../core/prosemirror/plugins/anonymizationDecorations";
import type { ImagePositionAttrs } from "../core/prosemirror/schema/nodes";
import type { Footnote } from "../core/types/content";
// Types
import type {
  Document,
  Theme,
  StyleDefinitions,
  SectionProperties,
  HeaderFooter,
  TextFormatting,
} from "../core/types/document";
import {
  closestHtmlElement,
  htmlQueryAll,
  queryHtmlElement,
} from "../core/utils/domGuards";
// Internal components
import { AnonymizationRectsOverlay } from "./AnonymizationRectsOverlay";
import type { AnonymizationRectGroup } from "./AnonymizationRectsOverlay";
import {
  computeFirstPageHeaderFooterMarginExtender,
  computeHeaderFooterMarginExtender,
} from "./headerFooterMargins";
import {
  createHiddenEditorState,
  HiddenProseMirror,
} from "./HiddenProseMirror";
import type {
  HiddenProseMirrorCollaboration,
  HiddenProseMirrorRemoteSelection,
  HiddenProseMirrorRef,
} from "./HiddenProseMirror";
import { ImageSelectionOverlay } from "./ImageSelectionOverlay";
import type { ImageSelectionInfo } from "./ImageSelectionOverlay";
import {
  mergeDirtyRanges,
  tryBuildIncrementalMeasures,
} from "./incrementalMeasure";
import type { DirtyRange } from "./incrementalMeasure";
import {
  recordLayoutComplete,
  recordLayoutError,
  recordLayoutPhase,
  recordMeasureBlock,
} from "./layoutInstrumentation";
import type { LayoutPhase, LayoutRunReason } from "./layoutInstrumentation";
// Selection sync
import { LayoutSelectionGate } from "./LayoutSelectionGate";
import { isReadOnlyEditKey } from "./readOnlyEditAttempt";
import {
  getPageScrollTarget,
  isValidPmScrollPosition,
  prefersReducedMotionBehavior,
} from "./scrollNavigation";
import { computePerBlockWidths } from "./sectionBlockWidths";
import { SelectionOverlay } from "./SelectionOverlay";
import { getTransactionDirtyRange } from "./transactionDirtyRange";
import { useDragAutoScroll } from "./useDragAutoScroll";
// Visual line navigation hook
import { useVisualLineNavigation } from "./useVisualLineNavigation";

// =============================================================================
// TYPES
// =============================================================================

export type PagedEditorProps = {
  /** The document to edit. */
  document: Document | null;
  /** Document styles for style resolution. */
  styles?: StyleDefinitions | null;
  /** Theme for styling. */
  theme?: Theme | null;
  /** Section properties (page size, margins). */
  sectionProperties?: SectionProperties | null;
  /** Header content for all pages (or pages 2+ when titlePg is set). */
  headerContent?: HeaderFooter | null;
  /** Footer content for all pages (or pages 2+ when titlePg is set). */
  footerContent?: HeaderFooter | null;
  /** Header content for first page only (when titlePg is set). */
  firstPageHeaderContent?: HeaderFooter | null;
  /** Footer content for first page only (when titlePg is set). */
  firstPageFooterContent?: HeaderFooter | null;
  /**
   * Relationship ids for the displayed HF slots — used by the painter to
   * emit `data-rid` on `.layout-page-header` / `.layout-page-footer` and
   * by the layout pipeline to look up persistent hidden HF EditorViews.
   */
  headerContentRId?: string | null;
  footerContentRId?: string | null;
  firstPageHeaderContentRId?: string | null;
  firstPageFooterContentRId?: string | null;
  /** Whether the editor is read-only. */
  readOnly?: boolean;
  /** Gap between pages in pixels. */
  pageGap?: number;
  /** Zoom level (1 = 100%). */
  zoom?: number;
  /** Callback when document changes. */
  onDocumentChange?: (document: Document) => void;
  /** Callback when a readonly user action would mutate the document. */
  onReadOnlyEditAttempt?: () => void;
  /** Callback when selection changes. */
  onSelectionChange?: (from: number, to: number) => void;
  /**
   * Callback when the active text selection changes. Fires
   * with the resolved PM positions and the selected plain
   * text (atom inline nodes — tab, hard_break — are
   * collapsed to a single space). Useful for consumers that
   * want the selected phrase without having to hold a
   * reference to the editor view themselves; fires on every
   * selection-bearing transaction (caret moves, drag,
   * word-select, programmatic `setSelection`).
   */
  onSelectionTextChange?: (selection: {
    from: number;
    to: number;
    text: string;
  }) => void;
  /** External ProseMirror plugins. */
  externalPlugins?: Plugin[];
  /** Optional Yjs collaboration owner for the hidden ProseMirror state. */
  collaboration?: HiddenProseMirrorCollaboration | undefined;
  /** Extension manager for plugins/schema/commands (optional — falls back to default) */
  extensionManager?: ExtensionManager;
  /** Callback when header or footer is double-clicked for editing. */
  onHeaderFooterDoubleClick?: (
    position: "header" | "footer",
    pageNumber?: number,
  ) => void;
  /** Active header/footer editing mode (dims body, intercepts body clicks). */
  hfEditMode?: "header" | "footer" | null;
  /** Called when user clicks the body area while in HF editing mode. */
  onBodyClick?: () => void;
  /** Custom class name. */
  className?: string;
  /** Custom styles. */
  style?: CSSProperties;
  /** Whether comments sidebar is open (shifts document left). */
  commentsSidebarOpen?: boolean;
  /** Sidebar overlay rendered inside the scroll container (scrolls with document). */
  sidebarOverlay?: React.ReactNode;
  /** Ref callback for the scroll container element. */
  scrollContainerRef?: React.Ref<HTMLDivElement>;
  /** Callback when a hyperlink is clicked (for showing popup). */
  onHyperlinkClick?: (data: {
    href: string;
    displayText: string;
    tooltip?: string;
    anchorEl: HTMLAnchorElement;
  }) => void;
  /** Callback when user right-clicks on the pages (for context menu). */
  onContextMenu?: (data: {
    x: number;
    y: number;
    hasSelection: boolean;
  }) => void;
  /** Callback with pre-computed Y positions for comment/tracked-change anchors (for sidebar positioning without DOM queries). */
  onAnchorPositionsChange?: (positions: Map<string, number>) => void;
  /** Callback when layout reports a different total page count. */
  onTotalPagesChange?: (totalPages: number) => void;
  /** Which mark anchors should be mapped for sidebars/margin markers. */
  anchorPositionMode?: "comments" | "comments-and-revisions";
  /**
   * Called when the user clicks an anonymization highlight in
   * the rendered document. Receives the canonical surface form
   * and label slug; the host wires this to the sidebar bridge.
   */
  onAnonymizationTermClick?:
    | ((canonical: string, label: string) => void)
    | undefined;
  /**
   * Canonical to highlight as "selected" in the overlay. The
   * first matching rect scrolls into view whenever
   * `anonymizationSelectionSeq` changes (so repeated sidebar
   * clicks of the same term re-trigger the scroll).
   */
  selectedAnonymizationCanonical?: string | null | undefined;
  /** Monotonic counter from the bridge store; drives the re-scroll. */
  anonymizationSelectionSeq?: number | undefined;
};

export type PagedEditorRef = {
  /** Get the current document. */
  getDocument(): Document | null;
  /** Get the ProseMirror EditorState. */
  getState(): EditorState | null;
  /** Get the ProseMirror EditorView. */
  getView(): EditorView | null;
  /**
   * Look up the persistent hidden HF EditorView by `rId`. Returns null when
   * the slot isn't mounted (e.g. document has no HF for that rId, or the
   * hidden host hasn't mounted yet).
   */
  getHfView(rId: string): EditorView | null;
  /**
   * Force-create the hidden editor view if it has been deferred.
   * Use from surfaces that need a live view before any user
   * interaction (e.g. AI chat reading a snapshot of the doc).
   */
  ensureView(options?: { focus?: boolean }): void;
  /** Focus the editor. */
  focus(): void;
  /** Blur the editor. */
  blur(): void;
  /** Check if focused. */
  isFocused(): boolean;
  /** Dispatch a transaction. */
  dispatch(tr: Transaction): void;
  /** Undo. */
  undo(): boolean;
  /** Redo. */
  redo(): boolean;
  /** Check whether undo is available. */
  canUndo(): boolean;
  /** Check whether redo is available. */
  canRedo(): boolean;
  /** Set selection by PM position. */
  setSelection(anchor: number, head?: number): void;
  /** Get current layout. */
  getLayout(): Layout | null;
  /** Force re-layout. */
  relayout(): void;
  /** Scroll the visible pages to bring a PM position into view. */
  scrollToPosition(pmPos: number): void;
  /** Scroll the visible pages to bring a page into view. */
  scrollToPage(pageNumber: number): void;
  /** Resolve the page number (1-indexed) that contains the given PM position,
   *  or null if no layout is available yet. Works for unrendered pages too via
   *  the page shell map. */
  getPageNumberForPmPos(pmPos: number): number | null;
};

type PendingHiddenEditorSelection =
  | { type: "node"; pos: number }
  | { type: "text"; anchor: number; head?: number };

type QueuedHiddenEditorInput =
  | { type: "text"; text: string }
  | { type: "keydown"; eventInit: KeyboardEventInit };

type EnsureHiddenEditorViewOptions = {
  focus?: boolean;
  sync?: boolean;
};

type TextInputHandler<TView> = (
  view: TView,
  from: number,
  to: number,
  text: string,
  defaultTransaction: () => Transaction,
) => unknown;

type TextInputDispatchTarget<TView> = {
  dispatch(tr: Transaction): void;
  someProp(
    propName: "handleTextInput",
    f: (handler: TextInputHandler<TView>) => unknown,
  ): unknown;
  state: EditorState;
};

// =============================================================================
// CONSTANTS
// =============================================================================

// Default page size (US Letter at 96 DPI)
const DEFAULT_PAGE_WIDTH = 816;
const DEFAULT_PAGE_HEIGHT = 1056;

// Default margins (1 inch at 96 DPI)
const DEFAULT_MARGINS: PageMargins = {
  top: 96,
  right: 96,
  bottom: 96,
  left: 96,
};

export const DEFAULT_PAGE_GAP = 24;
const COMMENTS_SIDEBAR_SCROLL_GUTTER = 304;

/** Distance in px from a row/column boundary that triggers the insert button */
/** Distance in px from the table edge where boundary detection is active */
const TABLE_INSERT_EDGE_PROXIMITY = 30;
/** Delay in ms before hiding the insert button when cursor moves away */
const TABLE_INSERT_HIDE_DELAY = 200;
/** Delay before converting PM state back to the Folio document model. */
const DOCUMENT_CHANGE_NOTIFY_DELAY = 250;
/** Short window for coalescing rapid typing transactions into one visual layout. */
const TRANSACTION_LAYOUT_DEBOUNCE_MS = 32;
/** Upper bound for how long visible layout can trail the hidden editor. */
const TRANSACTION_LAYOUT_MAX_DELAY_MS = 96;
/** Keep the visual caret hidden briefly while typed content relayouts. */
const SELECTION_REVEAL_AFTER_INPUT_DELAY = 120;

// Stable empty array to avoid re-creating on each render
const EMPTY_PLUGINS: Plugin[] = [];

const DEFERRED_KEYDOWN_REPLAY_KEYS = new Set([
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "Backspace",
  "Delete",
  "End",
  "Enter",
  "Home",
  "PageDown",
  "PageUp",
  "Tab",
]);
const DEFERRED_MODIFIER_KEYDOWN_REPLAY_KEYS = new Set([
  "a",
  "b",
  "i",
  "u",
  "v",
  "x",
  "y",
  "z",
]);

const isPlainTextInputEvent = (event: React.KeyboardEvent): boolean =>
  event.key.length === 1 &&
  !event.altKey &&
  !event.ctrlKey &&
  !event.metaKey &&
  !event.nativeEvent.isComposing;

type DeferredEditorKeyDownEvent = {
  altKey: boolean;
  ctrlKey: boolean;
  key: string;
  metaKey: boolean;
  nativeEvent: {
    isComposing: boolean;
  };
};

export const isDeferredEditorKeyDown = (
  event: DeferredEditorKeyDownEvent,
): boolean => {
  if (event.nativeEvent.isComposing) {
    return true;
  }

  if (DEFERRED_KEYDOWN_REPLAY_KEYS.has(event.key)) {
    return true;
  }

  if (event.metaKey || event.ctrlKey) {
    return DEFERRED_MODIFIER_KEYDOWN_REPLAY_KEYS.has(event.key.toLowerCase());
  }

  return isReadOnlyEditKey(event);
};

const toDeferredKeyboardEventInit = (
  event: React.KeyboardEvent,
): KeyboardEventInit => ({
  altKey: event.altKey,
  bubbles: true,
  cancelable: true,
  code: event.code,
  composed: true,
  ctrlKey: event.ctrlKey,
  isComposing: event.nativeEvent.isComposing,
  key: event.key,
  location: event.location,
  metaKey: event.metaKey,
  repeat: event.repeat,
  shiftKey: event.shiftKey,
});

const replayDeferredKeyDown = (
  view: EditorView,
  eventInit: KeyboardEventInit,
) => {
  view.dom.dispatchEvent(new KeyboardEvent("keydown", eventInit));
};

export const dispatchEditorTextInput = <
  TView extends TextInputDispatchTarget<TView>,
>(
  view: TView,
  text: string,
) => {
  const { from, to } = view.state.selection;
  const defaultTransaction = () => view.state.tr.insertText(text, from, to);
  const handled = view.someProp("handleTextInput", (handler) =>
    handler(view, from, to, text, defaultTransaction),
  );

  if (!handled) {
    view.dispatch(defaultTransaction());
  }
};

/**
 * Get the zero-based page index for a node by climbing to its
 * `.layout-page` ancestor and reading `data-page-number`. Returns
 * 0 if no ancestor is found.
 */
const getPageIndex = (el: Element): number => {
  const pageEl = closestHtmlElement(el, ".layout-page");
  if (!pageEl) {
    return 0;
  }
  const raw = pageEl.dataset["pageNumber"];
  return raw ? Number(raw) - 1 : 0;
};

/**
 * Get the line height for a node by climbing to its `.layout-line`
 * ancestor and reading `offsetHeight`. Returns `fallback` if no
 * ancestor is found.
 */
const getLineHeight = (el: Element, fallback = 16): number => {
  const lineEl = closestHtmlElement(el, ".layout-line");
  return lineEl ? lineEl.offsetHeight : fallback;
};

// =============================================================================
// STYLES
// =============================================================================

const containerStyles: CSSProperties = {
  position: "relative",
  width: "100%",
  minHeight: "100%",
  overflow: "visible",
  backgroundColor: "var(--doc-bg, #f8f9fa)",
};

/** Padding above page content in the viewport div. */
export const VIEWPORT_PADDING_TOP = 24;

const viewportStyles: CSSProperties = {
  position: "relative",
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  paddingTop: VIEWPORT_PADDING_TOP,
  paddingBottom: 24,
  backgroundColor: "transparent",
};

type RemoteSelectionOverlayProps = {
  blocks: FlowBlock[];
  layout: Layout;
  measures: Measure[];
  pagesContainer: HTMLDivElement | null;
  remoteSelection: HiddenProseMirrorRemoteSelection;
  zoom: number;
};

type SelectionGeometryModule = typeof SelectionGeometry;

let selectionGeometryPromise: Promise<SelectionGeometryModule> | null = null;

const loadSelectionGeometry = (): Promise<SelectionGeometryModule> => {
  selectionGeometryPromise ??=
    import("../core/layout-bridge/selectionRects").catch((error: unknown) => {
      selectionGeometryPromise = null;
      throw error;
    });

  return selectionGeometryPromise;
};

// HF caret overlay — minimal "paint the caret + selection rects for the
// currently focused HF PM" implementation. Re-runs the DOM lookup on each
// painter:painted event and whenever the selection changes.
type HfCaretSelection = {
  rId: string;
  kind: "header" | "footer";
  from: number;
  to: number;
};

function HfCaretOverlay({
  selection,
  pagesContainer,
}: {
  selection: HfCaretSelection;
  pagesContainer: HTMLDivElement | null;
}) {
  const [caret, setCaret] = useState<{
    x: number;
    y: number;
    height: number;
  } | null>(null);
  const [rangeRects, setRangeRects] = useState<
    { x: number; y: number; width: number; height: number }[]
  >([]);

  useEffect(() => {
    if (!pagesContainer) {
      return;
    }
    const recompute = () => {
      const cr = pagesContainer.getBoundingClientRect();
      const collapsed = selection.from === selection.to;
      if (collapsed) {
        const anchor = findHfPmAnchor(
          pagesContainer,
          selection.kind,
          selection.rId,
          selection.from,
        );
        if (!anchor) {
          setCaret(null);
          setRangeRects([]);
          return;
        }
        const ar = anchor.getBoundingClientRect();
        setCaret({
          x: ar.left - cr.left,
          y: ar.top - cr.top,
          height: ar.height || 16,
        });
        setRangeRects([]);
        return;
      }
      // Range selection — walk every painted pm span inside the slot
      // and project the union of those whose [pmStart,pmEnd] intersect
      // [from,to). The painter emits one span per run so this is good
      // enough for single-line and multi-line highlights without doing
      // glyph-level math (Word's selection model is paragraph-line-based
      // — same convention).
      const slotSelector =
        selection.kind === "header"
          ? `.layout-page-header[data-rid="${selection.rId}"]`
          : `.layout-page-footer[data-rid="${selection.rId}"]`;
      const spans = pagesContainer.querySelectorAll<HTMLElement>(
        `${slotSelector} span[data-pm-start][data-pm-end]`,
      );
      const rects: { x: number; y: number; width: number; height: number }[] =
        [];
      for (const span of spans) {
        const spanStart = Number.parseInt(span.dataset["pmStart"] ?? "", 10);
        const spanEnd = Number.parseInt(span.dataset["pmEnd"] ?? "", 10);
        if (!Number.isFinite(spanStart) || !Number.isFinite(spanEnd)) {
          continue;
        }
        if (spanEnd <= selection.from || spanStart >= selection.to) {
          continue;
        }
        const r = span.getBoundingClientRect();
        rects.push({
          x: r.left - cr.left,
          y: r.top - cr.top,
          width: r.width,
          height: r.height,
        });
      }
      setRangeRects(rects);
      setCaret(null);
    };
    recompute();
    const onPainted = () => recompute();
    pagesContainer.addEventListener(PAINTER_PAINTED_EVENT, onPainted);
    return () => {
      pagesContainer.removeEventListener(PAINTER_PAINTED_EVENT, onPainted);
    };
  }, [selection, pagesContainer]);

  return (
    <>
      {rangeRects.map((r, i) => (
        <div
          key={`hf-sel-${i}-${r.x}-${r.y}-${r.width}`}
          data-testid="hf-selection-rect"
          style={{
            position: "absolute",
            left: r.x,
            top: r.y,
            width: r.width,
            height: r.height,
            backgroundColor: "var(--doc-selection, rgba(66, 133, 244, 0.3))",
            pointerEvents: "none",
            zIndex: 10,
          }}
        />
      ))}
      {caret && (
        <div
          data-testid="hf-caret"
          style={{
            position: "absolute",
            left: caret.x,
            top: caret.y,
            width: 2,
            height: caret.height,
            backgroundColor: "var(--doc-canvas-text, #000)",
            pointerEvents: "none",
            zIndex: 11,
            animation: "folio-caret-blink 1060ms steps(1, end) infinite",
          }}
        />
      )}
    </>
  );
}

// Source HeaderFooterContent for the painter from either a persistent hidden
// HF EditorView (preferred — keeps the painter in lockstep with live PM edits)
// or the HeaderFooter document blocks (fallback before the view mounts).
// `rId` is stamped on the result so the painter emits `data-rid` and the
// pointer pipeline can route clicks back to the matching EditorView.
function renderHfFromContentOrPm(
  hf: HeaderFooter | null | undefined,
  rId: string | null | undefined,
  hfPMs: HiddenHeaderFooterPMsRef | null,
  contentWidth: number,
  metrics: HeaderFooterMetrics,
  options: ConvertHeaderFooterOptions,
): HeaderFooterContent | undefined {
  if (!hf) {
    return undefined;
  }
  const optsWithRId: ConvertHeaderFooterOptions = rId
    ? { ...options, rId }
    : options;
  const view = rId ? hfPMs?.getView(rId) : null;
  if (view) {
    return convertHeaderFooterPmDocToContent(
      view.state.doc,
      contentWidth,
      metrics,
      optsWithRId,
    );
  }
  return convertHeaderFooterToContent(hf, contentWidth, metrics, optsWithRId);
}

type LayoutInputSignatureOptions = {
  columns: ColumnLayout | undefined;
  contentWidth: number;
  defaultTabStop: number | undefined;
  firstPageFooterContent: HeaderFooter | null | undefined;
  firstPageHeaderContent: HeaderFooter | null | undefined;
  footerContent: HeaderFooter | null | undefined;
  headerContent: HeaderFooter | null | undefined;
  margins: PageMargins;
  pageGap: number;
  pageSize: { h: number; w: number };
  sectionProperties: SectionProperties | null | undefined;
  styles: StyleDefinitions | null | undefined;
  theme: Theme | null | undefined;
};

type PendingLayoutRequest = {
  dirtyRange: DirtyRange | null;
  firstScheduledAt: number;
  rafId: number | null;
  state: EditorState;
  timerId: number | null;
};

const getPageOverlayOffset = (pagesContainer: HTMLDivElement, zoom: number) => {
  const overlay = pagesContainer.parentElement?.querySelector(
    '[data-testid="selection-overlay"]',
  );
  const firstPage = pagesContainer.querySelector(".layout-page");
  if (!overlay || !firstPage) {
    return null;
  }

  const overlayRect = overlay.getBoundingClientRect();
  const pageRect = firstPage.getBoundingClientRect();
  return {
    x: (pageRect.left - overlayRect.left) / zoom,
    y: (pageRect.top - overlayRect.top) / zoom,
  };
};

function buildLayoutInputSignature(
  options: LayoutInputSignatureOptions,
): string {
  return stableJsonStringify(options);
}

function stableJsonStringify(value: unknown): string {
  return JSON.stringify(value, (_key, nestedValue: unknown) => {
    if (nestedValue instanceof Map) {
      return Array.from(nestedValue.entries());
    }
    return nestedValue;
  });
}

function getDocumentFontSet(): FontFaceSet | null {
  if (typeof document === "undefined" || !("fonts" in document)) {
    return null;
  }
  return document.fonts;
}

function documentFontsAreLoaded(): boolean {
  const fontSet = getDocumentFontSet();
  return !fontSet || fontSet.status === "loaded";
}

const INITIAL_LAYOUT_FONT_TIMEOUT_MS = 2000;
const INITIAL_FONT_READY_SUPPRESSION_MS = 250;
const DEFAULT_LAYOUT_FONT_FAMILY = "Calibri";
const OFFICE_FONT_FAMILY_MAP: Record<string, string> = {
  Arial: "Arimo",
  Calibri: "Carlito",
  Cambria: "Caladea",
  "Times New Roman": "Tinos",
  "Courier New": "Cousine",
};
const CSS_GENERIC_FONT_FAMILIES = new Set([
  "serif",
  "sans-serif",
  "monospace",
  "cursive",
  "fantasy",
  "system-ui",
]);
const LAYOUT_FONT_DESCRIPTORS = [
  { style: "normal", weight: 400 },
  { style: "italic", weight: 400 },
  { style: "normal", weight: 700 },
  { style: "italic", weight: 700 },
] as const;
const REGULAR_LAYOUT_FONT_DESCRIPTOR = LAYOUT_FONT_DESCRIPTORS[0];

export type LayoutFontFace = {
  family: string;
  style: (typeof LAYOUT_FONT_DESCRIPTORS)[number]["style"];
  weight: (typeof LAYOUT_FONT_DESCRIPTORS)[number]["weight"];
};

function waitForInitialLayoutFonts(
  documentModel: Document | null,
  pmDoc: EditorState["doc"],
): Promise<boolean> {
  const fontSet = getDocumentFontSet();
  if (!fontSet) {
    return Promise.resolve(true);
  }

  const loadChecks: string[] = [];
  for (const face of collectInitialLayoutFontFaces(documentModel, pmDoc)) {
    loadChecks.push(
      `${face.style} ${face.weight} 16px "${escapeCssFontFamily(face.family)}"`,
    );
  }

  const loadFonts = Promise.allSettled(
    loadChecks.map((check) => fontSet.load(check)),
  )
    .then(() => fontSet.ready)
    .then(() => true);
  return Promise.race([
    loadFonts,
    new Promise<boolean>((resolve) => {
      window.setTimeout(() => resolve(false), INITIAL_LAYOUT_FONT_TIMEOUT_MS);
    }),
  ]);
}

export function collectInitialLayoutFontFamilies(
  documentModel: Document | null,
  pmDoc: EditorState["doc"],
): Set<string> {
  return new Set(
    collectInitialLayoutFontFaces(documentModel, pmDoc).map(
      ({ family }) => family,
    ),
  );
}

export function collectInitialLayoutFontFaces(
  documentModel: Document | null,
  pmDoc: EditorState["doc"],
): LayoutFontFace[] {
  const faces = new Map<string, LayoutFontFace>();
  addLayoutFontFamilyFace(
    faces,
    DEFAULT_LAYOUT_FONT_FAMILY,
    REGULAR_LAYOUT_FONT_DESCRIPTOR,
  );

  for (const family of documentModel?.requiredFonts ?? []) {
    addLayoutFontFamilyFace(faces, family, REGULAR_LAYOUT_FONT_DESCRIPTOR);
  }

  addLayoutFontFamilyFace(
    faces,
    documentModel?.package.theme?.fontScheme?.majorFont?.latin,
    REGULAR_LAYOUT_FONT_DESCRIPTOR,
  );
  addLayoutFontFamilyFace(
    faces,
    documentModel?.package.theme?.fontScheme?.minorFont?.latin,
    REGULAR_LAYOUT_FONT_DESCRIPTOR,
  );
  addTextFormattingFontFaces(
    faces,
    documentModel?.package.styles?.docDefaults?.rPr,
  );
  for (const style of documentModel?.package.styles?.styles ?? []) {
    addTextFormattingFontFaces(faces, style.rPr);
  }

  collectProseMirrorFontFaces(faces, pmDoc, undefined);

  return Array.from(faces.values());
}

function addTextFormattingFontFaces(
  faces: Map<string, LayoutFontFace>,
  formatting: TextFormatting | undefined,
): void {
  addLayoutFontFamilyFace(
    faces,
    formatting?.fontFamily,
    layoutDescriptorFromFormatting(formatting),
  );
}

function collectProseMirrorFontFaces(
  faces: Map<string, LayoutFontFace>,
  node: PMNode,
  inheritedTextFormatting: TextFormatting | undefined,
): void {
  const paragraphDefaults = readParagraphDefaultTextFormatting(node);
  const textFormatting = paragraphDefaults ?? inheritedTextFormatting;
  if (paragraphDefaults) {
    addTextFormattingFontFaces(faces, paragraphDefaults);
  }

  if (node.attrs["listMarkerFontFamily"]) {
    addLayoutFontFamilyFace(
      faces,
      node.attrs["listMarkerFontFamily"],
      REGULAR_LAYOUT_FONT_DESCRIPTOR,
    );
  }

  if (node.isText) {
    const descriptor = layoutDescriptorFromFormattingAndMarks(
      textFormatting,
      node.marks,
    );
    const markFontFamily = readFontFamilyMarkAttrs(node.marks);
    addLayoutFontFamilyFace(
      faces,
      markFontFamily ??
        textFormatting?.fontFamily ??
        DEFAULT_LAYOUT_FONT_FAMILY,
      descriptor,
    );
  }

  // oxlint-disable-next-line unicorn/no-array-for-each -- ProseMirror Node.forEach
  node.forEach((child) => {
    collectProseMirrorFontFaces(faces, child, textFormatting);
  });
}

function readParagraphDefaultTextFormatting(
  node: PMNode,
): TextFormatting | undefined {
  const value = node.attrs["defaultTextFormatting"];
  if (!value || typeof value !== "object") {
    return undefined;
  }
  return value as TextFormatting;
}

function readFontFamilyMarkAttrs(marks: readonly Mark[]): unknown {
  for (const mark of marks) {
    if (mark.type.name === "fontFamily") {
      return expectFontFamilyMarkAttrs(mark);
    }
  }
  return undefined;
}

function layoutDescriptorFromFormatting(
  formatting: Pick<TextFormatting, "bold" | "italic"> | undefined,
): Omit<LayoutFontFace, "family"> {
  return {
    style: formatting?.italic ? "italic" : "normal",
    weight: formatting?.bold ? 700 : 400,
  };
}

function layoutDescriptorFromFormattingAndMarks(
  formatting: Pick<TextFormatting, "bold" | "italic"> | undefined,
  marks: readonly Mark[],
): Omit<LayoutFontFace, "family"> {
  let bold = formatting?.bold === true;
  let italic = formatting?.italic === true;

  for (const mark of marks) {
    if (mark.type.name === "bold") {
      bold = true;
    }
    if (mark.type.name === "italic") {
      italic = true;
    }
  }

  return {
    style: italic ? "italic" : "normal",
    weight: bold ? 700 : 400,
  };
}

function addLayoutFontFamilyFace(
  faces: Map<string, LayoutFontFace>,
  value: unknown,
  descriptor: Omit<LayoutFontFace, "family">,
): void {
  if (typeof value === "string") {
    addLayoutFontFamilyNameFace(faces, value, descriptor);
    return;
  }

  if (!value || typeof value !== "object") {
    return;
  }

  const fontFamily = value as { ascii?: unknown; hAnsi?: unknown };
  addLayoutFontFamilyFace(faces, fontFamily.ascii, descriptor);
  addLayoutFontFamilyFace(faces, fontFamily.hAnsi, descriptor);
}

function addLayoutFontFamilyNameFace(
  faces: Map<string, LayoutFontFace>,
  family: string,
  descriptor: Omit<LayoutFontFace, "family">,
): void {
  const normalized = family.trim();
  if (!normalized || CSS_GENERIC_FONT_FAMILIES.has(normalized)) {
    return;
  }

  addLayoutFontFace(faces, normalized, descriptor);
  const mappedFamily = OFFICE_FONT_FAMILY_MAP[normalized];
  if (mappedFamily) {
    addLayoutFontFace(faces, mappedFamily, descriptor);
  }
}

function addLayoutFontFace(
  faces: Map<string, LayoutFontFace>,
  family: string,
  descriptor: Omit<LayoutFontFace, "family">,
): void {
  faces.set(`${family}|${descriptor.style}|${descriptor.weight}`, {
    family,
    ...descriptor,
  });
}

function escapeCssFontFamily(family: string): string {
  return family.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"');
}

function describeInvalidHighlightMarks(doc: EditorState["doc"]): string {
  const invalidHighlights: string[] = [];
  const validHighlightColors = new Set([
    "black",
    "blue",
    "cyan",
    "darkBlue",
    "darkCyan",
    "darkGray",
    "darkGreen",
    "darkMagenta",
    "darkRed",
    "darkYellow",
    "green",
    "lightGray",
    "magenta",
    "none",
    "red",
    "white",
    "yellow",
  ]);

  const visit = (node: EditorState["doc"], path: string): void => {
    for (const [index, mark] of node.marks.entries()) {
      if (
        mark.type.name === "highlight" &&
        !validHighlightColors.has(String(mark.attrs["color"]))
      ) {
        invalidHighlights.push(
          `${path}.marks[${index}]=${JSON.stringify(mark.attrs)}`,
        );
      }
    }

    // oxlint-disable-next-line unicorn/no-array-for-each -- ProseMirror Node.forEach
    node.forEach((child, _offset, index) => {
      visit(child, `${path}.content[${index}]`);
    });
  };

  visit(doc, "doc");
  return invalidHighlights.join("; ");
}

const RemoteSelectionOverlay = ({
  blocks,
  layout,
  measures,
  pagesContainer,
  remoteSelection,
  zoom,
}: RemoteSelectionOverlayProps) => {
  const [geometry, setGeometry] = useState<{
    caretPosition: CaretPosition | null;
    selectionRects: SelectionRect[];
  } | null>(null);

  useEffect(() => {
    if (!pagesContainer) {
      setGeometry(null);
      return undefined;
    }

    const offset = getPageOverlayOffset(pagesContainer, zoom);
    if (!offset) {
      setGeometry(null);
      return undefined;
    }

    let cancelled = false;
    void loadSelectionGeometry().then(
      ({ getCaretPosition, selectionToRects }) => {
        if (cancelled) {
          return undefined;
        }

        const from = Math.min(remoteSelection.anchor, remoteSelection.head);
        const to = Math.max(remoteSelection.anchor, remoteSelection.head);
        const nextSelectionRects = selectionToRects(
          layout,
          blocks,
          measures,
          from,
          to,
        ).map((rect) => ({
          height: rect.height,
          pageIndex: rect.pageIndex,
          width: rect.width,
          x: rect.x + offset.x,
          y: rect.y + offset.y,
        }));
        const caretBase = getCaretPosition(
          layout,
          blocks,
          measures,
          remoteSelection.head,
        );
        const caretPosition = caretBase
          ? {
              ...caretBase,
              x: caretBase.x + offset.x,
              y: caretBase.y + offset.y,
            }
          : null;

        setGeometry({
          caretPosition,
          selectionRects: nextSelectionRects,
        });
        return undefined;
      },
      () => {
        if (!cancelled) {
          setGeometry(null);
        }
        return undefined;
      },
    );

    return () => {
      cancelled = true;
    };
  }, [
    blocks,
    layout,
    measures,
    pagesContainer,
    remoteSelection.anchor,
    remoteSelection.head,
    zoom,
  ]);

  if (!geometry) {
    return null;
  }

  const { caretPosition, selectionRects } = geometry;

  return (
    <>
      <SelectionOverlay
        blinkInterval={0}
        caretColor={remoteSelection.color}
        caretPosition={caretPosition}
        caretWidth={2}
        isFocused
        selectionColor={`color-mix(in srgb, ${remoteSelection.color} 24%, transparent)`}
        selectionRects={selectionRects}
      />
      {caretPosition && (
        <div
          className="pointer-events-none absolute z-20 rounded-sm px-1 py-0.5 text-[10px] leading-none shadow-sm"
          style={{
            backgroundColor: remoteSelection.color,
            color: "var(--background)",
            left: caretPosition.x,
            top: Math.max(0, caretPosition.y - 18),
          }}
        >
          {remoteSelection.name}
        </div>
      )}
    </>
  );
};

const pagesContainerStyles: CSSProperties = {
  position: "relative",
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
};

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Compute anchor Y positions for comments/tracked-changes sidebar.
 * Uses getCaretPosition for paragraphs/images; for table content, finds
 * the containing fragment and drills into rows for exact Y offset.
 * Returns a Map of "comment-{id}" / "revision-{revisionId}" → scroll-container Y.
 */
function computeAnchorPositions(
  state: EditorState | null,
  layout: Layout,
  blocks: FlowBlock[],
  measures: Measure[],
  _renderedPageGap: number,
  options: { includeRevisions: boolean },
  getCaretPosition: SelectionGeometryModule["getCaretPosition"],
): Map<string, number> {
  const positions = new Map<string, number>();
  if (!state) {
    return positions;
  }

  const { doc: pmDoc, schema } = state;
  const commentType = schema.marks["comment"];
  const insertionType = options.includeRevisions
    ? schema.marks["insertion"]
    : undefined;
  const deletionType = options.includeRevisions
    ? schema.marks["deletion"]
    : undefined;
  if (!commentType && !insertionType && !deletionType) {
    return positions;
  }

  const seen = new Set<string>();
  const contentOffset = VIEWPORT_PADDING_TOP;

  pmDoc.descendants((node, pos) => {
    if (!node.isText) {
      return;
    }
    for (const mark of node.marks) {
      let key: string | null = null;
      if (commentType && mark.type === commentType) {
        key = `comment-${mark.attrs["commentId"]}`;
      } else if (
        (insertionType && mark.type === insertionType) ||
        (deletionType && mark.type === deletionType)
      ) {
        key = `revision-${mark.attrs["revisionId"]}`;
      }
      if (!key || seen.has(key)) {
        continue;
      }
      seen.add(key);

      // Try exact position (paragraphs/images)
      const caret = getCaretPosition(layout, blocks, measures, pos);
      if (caret) {
        positions.set(key, caret.y + contentOffset);
        continue;
      }

      // Fallback: find containing fragment (tables, etc.) by PM position
      for (let pi = 0; pi < layout.pages.length; pi++) {
        const page = layout.pages[pi]!; // SAFETY: pi < layout.pages.length
        let found = false;
        for (const frag of page.fragments) {
          const fStart = frag.pmStart ?? 0;
          const fEnd = (frag as { pmEnd?: number }).pmEnd ?? fStart;
          if (pos < fStart || pos > fEnd) {
            continue;
          }

          const rowOffsetY =
            frag.kind === "table"
              ? getTableRowOffset(blocks, measures, frag, pos)
              : 0;
          positions.set(
            key,
            frag.y + rowOffsetY + getPageTop(layout, pi) + contentOffset,
          );
          found = true;
          break;
        }
        if (found) {
          break;
        }
      }
    }
  });

  return positions;
}

/**
 * Find the Y offset within a table fragment to the row containing a PM position.
 * Sums row heights until finding the row that contains the given position.
 */
function getTableRowOffset(
  blocks: FlowBlock[],
  measures: Measure[],
  frag: { blockId: string | number; fromRow: number; toRow: number },
  pmPos: number,
): number {
  const blockIdx = blocks.findIndex((b) => b.id === frag.blockId);
  if (blockIdx === -1) {
    return 0;
  }
  const tBlock = blocks[blockIdx]!; // SAFETY: blockIdx from findIndex, checked !== -1 above
  const tMeasure = measures[blockIdx]!; // SAFETY: same index, blocks and measures have equal length
  if (tBlock.kind !== "table" || tMeasure.kind !== "table") {
    return 0;
  }

  let offsetY = 0;
  for (let ri = frag.fromRow; ri < frag.toRow; ri++) {
    const row = (tBlock as TableBlock).rows[ri];
    if (!row) {
      break;
    }
    const posInRow = row.cells.some((cell) =>
      cell.blocks.some((b) => {
        const s = (b as { pmStart?: number }).pmStart ?? 0;
        const e = (b as { pmEnd?: number }).pmEnd ?? s;
        return pmPos >= s && pmPos <= e;
      }),
    );
    if (posInRow) {
      break;
    }
    offsetY += (tMeasure as TableMeasure).rows[ri]?.height ?? 0;
  }
  return offsetY;
}

/**
 * Convert twips to pixels (1 twip = 1/20 point, 96 pixels per inch).
 */
function twipsToPixels(twips: number): number {
  return Math.round((twips / 1440) * 96);
}

/**
 * Extract page size from section properties or use defaults.
 */
function getPageSize(sectionProps: SectionProperties | null | undefined): {
  w: number;
  h: number;
} {
  return {
    w: sectionProps?.pageWidth
      ? twipsToPixels(sectionProps.pageWidth)
      : DEFAULT_PAGE_WIDTH,
    h: sectionProps?.pageHeight
      ? twipsToPixels(sectionProps.pageHeight)
      : DEFAULT_PAGE_HEIGHT,
  };
}

/**
 * Extract margins from section properties or use defaults.
 */
function getMargins(
  sectionProps: SectionProperties | null | undefined,
): PageMargins {
  const top = sectionProps?.marginTop
    ? twipsToPixels(sectionProps.marginTop)
    : DEFAULT_MARGINS.top;
  const bottom = sectionProps?.marginBottom
    ? twipsToPixels(sectionProps.marginBottom)
    : DEFAULT_MARGINS.bottom;

  return {
    top,
    right: sectionProps?.marginRight
      ? twipsToPixels(sectionProps.marginRight)
      : DEFAULT_MARGINS.right,
    bottom,
    left: sectionProps?.marginLeft
      ? twipsToPixels(sectionProps.marginLeft)
      : DEFAULT_MARGINS.left,
    // Header/footer distances - where the header/footer content starts
    // Default to 0.5 inch (48px at 96 DPI) if not specified
    header: sectionProps?.headerDistance
      ? twipsToPixels(sectionProps.headerDistance)
      : 48,
    footer: sectionProps?.footerDistance
      ? twipsToPixels(sectionProps.footerDistance)
      : 48,
  };
}

/**
 * Extract column layout from section properties.
 * Returns undefined for single-column (default) to avoid unnecessary paginator overhead.
 */
function getColumns(
  sectionProps: SectionProperties | null | undefined,
): ColumnLayout | undefined {
  const count = sectionProps?.columnCount ?? 1;
  if (count <= 1) {
    return undefined;
  }
  // Default column spacing: 720 twips (0.5 inch) per OOXML spec
  const gap = twipsToPixels(sectionProps?.columnSpace ?? 720);
  const cols: ColumnLayout = {
    count,
    gap,
    equalWidth: sectionProps?.equalWidth ?? true,
  };
  if (sectionProps?.separator !== undefined) {
    cols.separator = sectionProps.separator;
  }
  return cols;
}

/**
 * Check if an image run is a *text-wrapping* floating image — it
 * occupies an exclusion zone the body text should flow around.
 *
 * `wrapType: "behind"` and `wrapType: "inFront"` are anchored
 * (out-of-flow) but Word's wrapNone semantics put them behind /
 * over the text without shrinking the body. They render as
 * `displayMode: "float"` in the prose model so the painter knows
 * they're out of normal flow, but `extractFloatingZones` must skip
 * them — including them here would make the line breaker wrap text
 * around a background letterhead or a foreground overlay (Codex
 * PR #258 review).
 */
function isFloatingImageRun(run: ImageRun): boolean {
  const wrapType = run.wrapType;
  const displayMode = run.displayMode;

  // wrapNone (behind / inFront): never an exclusion zone, regardless
  // of displayMode.
  if (wrapType === "behind" || wrapType === "inFront") {
    return false;
  }

  // Floating images have specific wrap types that allow text to flow around them
  if (wrapType && ["square", "tight", "through"].includes(wrapType)) {
    return true;
  }

  // Or explicit float display mode (only when no wrapNone semantics —
  // already filtered above).
  if (displayMode === "float") {
    return true;
  }

  return false;
}

/**
 * EMU to pixels conversion
 */
function emuToPixels(emu: number | undefined): number {
  if (emu === undefined) {
    return 0;
  }
  return Math.round((emu * 96) / 914_400);
}

function resolveTableWidthPx(
  width: number | undefined,
  widthType: string | undefined,
  contentWidth: number,
): number | undefined {
  if (!width) {
    return undefined;
  }
  if (widthType === "pct") {
    // width is in 50ths of a percent (5000 = 100%)
    return (contentWidth * width) / 5000;
  }
  if (widthType === "dxa" || !widthType || widthType === "auto") {
    return Math.round((width / 20) * 1.333);
  }
  return undefined;
}

function isInlineFlowImageRun(run: ImageRun): boolean {
  if (run.displayMode === "float") {
    return false;
  }

  if (
    run.wrapType === "square" ||
    run.wrapType === "tight" ||
    run.wrapType === "through" ||
    run.wrapType === "behind" ||
    run.wrapType === "inFront"
  ) {
    return false;
  }

  if (run.displayMode === "block" || run.wrapType === "topAndBottom") {
    return false;
  }

  return true;
}

export function measureTableCellBlockVisualHeight(
  block: FlowBlock,
  blockMeasure: Measure,
): number {
  if (block.kind !== "paragraph" || blockMeasure.kind !== "paragraph") {
    if ("totalHeight" in blockMeasure) {
      return blockMeasure.totalHeight;
    }
    if ("height" in blockMeasure) {
      return blockMeasure.height;
    }
    return 0;
  }

  const paragraphBlock = block;
  const paragraphMeasure = blockMeasure;
  const nonEmptyRuns = paragraphBlock.runs.filter(
    (run) =>
      run.kind !== "text" ||
      run.text.replace(/\u00a0/gu, " ").trim().length > 0,
  );
  if (paragraphMeasure.lines.length !== 1 || nonEmptyRuns.length === 0) {
    return paragraphMeasure.totalHeight;
  }

  const inlineImageRuns: ImageRun[] = [];
  for (const run of nonEmptyRuns) {
    if (run.kind !== "image" || !isInlineFlowImageRun(run)) {
      return paragraphMeasure.totalHeight;
    }
    inlineImageRuns.push(run);
  }

  let maxImageHeight = 0;
  for (const run of inlineImageRuns) {
    maxImageHeight = Math.max(maxImageHeight, run.height);
  }
  const spacingBefore = paragraphBlock.attrs?.spacing?.before ?? 0;
  const spacingAfter = paragraphBlock.attrs?.spacing?.after ?? 0;

  return spacingBefore + maxImageHeight + spacingAfter;
}

function getTableCellVerticalBorderHeight(cell: TableCell | undefined): number {
  const top = cell?.borders?.top?.width ?? 0;
  const bottom = cell?.borders?.bottom?.width ?? 0;
  return top + bottom;
}

export function measureTableBlock(
  tableBlock: TableBlock,
  contentWidth: number,
): TableMeasure {
  const DEFAULT_CELL_PADDING_X = 7; // Word default: 108 twips ≈ 7px
  const DEFAULT_CELL_PADDING_Y = 0; // OOXML/TableNormal default: top=0, bottom=0

  // columnWidths are already in pixels (converted in toFlowBlocks)
  let columnWidths = tableBlock.columnWidths ?? [];
  const explicitWidthPx = resolveTableWidthPx(
    tableBlock.width,
    tableBlock.widthType,
    contentWidth,
  );

  if (columnWidths.length === 0 && tableBlock.rows.length > 0) {
    // Determine total columns from first row's colSpans
    const colCount = tableBlock.rows[0]!.cells.reduce(
      // SAFETY: rows.length > 0
      (sum, cell) => sum + (cell.colSpan ?? 1),
      0,
    );
    const totalWidth = explicitWidthPx ?? contentWidth;
    const equalWidth = totalWidth / Math.max(1, colCount);
    columnWidths = Array.from({ length: colCount }, () => equalWidth);
  } else if (columnWidths.length > 0 && explicitWidthPx) {
    const totalWidth = columnWidths.reduce((sum, w) => sum + w, 0);
    if (totalWidth > 0 && Math.abs(totalWidth - explicitWidthPx) > 1) {
      const scale = explicitWidthPx / totalWidth;
      columnWidths = columnWidths.map((w) => w * scale);
    }
  }

  // Build a map of columns occupied by spanning cells from previous rows.
  // Without this, cells in rows with vertical merges get the wrong column width.
  const occupiedColumnsPerRow = new Map<number, Set<number>>();
  for (let rowIdx = 0; rowIdx < tableBlock.rows.length; rowIdx++) {
    const row = tableBlock.rows[rowIdx];
    if (!row) {
      continue;
    }
    let colIdx = 0;
    const occupied = occupiedColumnsPerRow.get(rowIdx) ?? new Set<number>();
    while (occupied.has(colIdx)) {
      colIdx++;
    }

    for (const cell of row.cells) {
      const colSpan = cell.colSpan ?? 1;
      const rowSpan = cell.rowSpan ?? 1;

      if (rowSpan > 1) {
        for (let r = rowIdx + 1; r < rowIdx + rowSpan; r++) {
          if (!occupiedColumnsPerRow.has(r)) {
            occupiedColumnsPerRow.set(r, new Set());
          }
          const occSet = occupiedColumnsPerRow.get(r)!;
          for (let c = 0; c < colSpan; c++) {
            occSet.add(colIdx + c);
          }
        }
      }

      colIdx += colSpan;
      while (occupied.has(colIdx)) {
        colIdx++;
      }
    }
  }

  // Calculate cell widths based on colSpan and columnWidths,
  // skipping columns occupied by spanning cells from previous rows.
  const rows = tableBlock.rows.map((row, rowIdx) => {
    let columnIndex = 0;
    const occupied = occupiedColumnsPerRow.get(rowIdx) ?? new Set<number>();
    while (occupied.has(columnIndex)) {
      columnIndex++;
    }

    return {
      cells: row.cells.map((cell) => {
        const colSpan = cell.colSpan ?? 1;
        // Calculate cell width as sum of spanned columns
        let cellWidth = 0;
        for (
          let c = 0;
          c < colSpan && columnIndex + c < columnWidths.length;
          c++
        ) {
          cellWidth += columnWidths[columnIndex + c] ?? 0;
        }
        // Fallback to cell.width or default if columnWidths not available
        if (cellWidth === 0) {
          cellWidth = cell.width ?? 100;
        }
        columnIndex += colSpan;
        while (occupied.has(columnIndex)) {
          columnIndex++;
        }

        const padLeft = cell.padding?.left ?? DEFAULT_CELL_PADDING_X;
        const padRight = cell.padding?.right ?? DEFAULT_CELL_PADDING_X;
        const cellContentWidth = Math.max(1, cellWidth - padLeft - padRight);
        const cellMeasure: TableCellMeasure = {
          blocks: cell.blocks.map((b) => measureBlock(b, cellContentWidth)),
          width: cellWidth,
          height: 0, // Calculated below
        };
        if (cell.colSpan !== undefined) {
          cellMeasure.colSpan = cell.colSpan;
        }
        if (cell.rowSpan !== undefined) {
          cellMeasure.rowSpan = cell.rowSpan;
        }
        return cellMeasure;
      }),
      height: 0,
    };
  });

  // Calculate cell heights, respecting explicit row height rules
  for (let rowIdx = 0; rowIdx < rows.length; rowIdx++) {
    const row = rows[rowIdx]!; // SAFETY: rowIdx < rows.length
    const sourceRowCells = tableBlock.rows[rowIdx]?.cells;
    let maxHeight = 0;
    let maxVerticalBorderHeight = 0;
    for (let cellIdx = 0; cellIdx < row.cells.length; cellIdx++) {
      const cell = row.cells[cellIdx]!; // SAFETY: cellIdx < row.cells.length
      const sourceCell = sourceRowCells?.[cellIdx];
      cell.height = 0;
      for (let blockIdx = 0; blockIdx < cell.blocks.length; blockIdx++) {
        const sourceBlock = sourceCell?.blocks[blockIdx];
        const blockMeasure = cell.blocks[blockIdx];
        if (!sourceBlock || !blockMeasure) {
          continue;
        }
        cell.height += measureTableCellBlockVisualHeight(
          sourceBlock,
          blockMeasure,
        );
      }
      const padTop = sourceCell?.padding?.top ?? DEFAULT_CELL_PADDING_Y;
      const padBottom = sourceCell?.padding?.bottom ?? DEFAULT_CELL_PADDING_Y;
      cell.height += padTop + padBottom;
      maxHeight = Math.max(maxHeight, cell.height);
      maxVerticalBorderHeight = Math.max(
        maxVerticalBorderHeight,
        getTableCellVerticalBorderHeight(sourceCell),
      );
    }

    // Apply heightRule from the source row
    const sourceRow = tableBlock.rows[rowIdx];
    const explicitHeight = sourceRow?.height;
    const heightRule = sourceRow?.heightRule;

    if (explicitHeight && heightRule === "exact") {
      row.height = explicitHeight;
    } else if (explicitHeight) {
      // Both 'atLeast' and 'auto' (OOXML default) treat the value as minimum height.
      // ECMA-376 §17.4.81: when hRule is absent or "auto", val is the minimum row height.
      row.height = Math.max(
        maxHeight + maxVerticalBorderHeight,
        explicitHeight,
      );
    } else {
      // No explicit height — use content height directly.
      row.height = maxHeight + maxVerticalBorderHeight;
    }
  }

  const totalHeight = rows.reduce((h, r) => h + r.height, 0);
  const totalWidth =
    columnWidths.reduce((w, cw) => w + cw, 0) ||
    explicitWidthPx ||
    contentWidth;

  return {
    kind: "table",
    rows,
    columnWidths,
    totalWidth,
    totalHeight,
  };
}

/**
 * Extract floating image exclusion zones from all blocks.
 * Called before measurement to determine line width reductions.
 *
 * For images with vertical align="top" relative to margin, they're at Y=0.
 * The exclusion zones define the areas where text lines need reduced widths.
 */
/**
 * Extended floating zone info that includes anchor block index
 */
type FloatingZoneWithAnchor = {
  /** Block index where this floating image is anchored */
  anchorBlockIndex: number;
  /** If true, zone is positioned relative to margin/page and applies to all blocks */
  isMarginRelative?: boolean;
} & FloatingImageZone;

function extractFloatingZones(
  blocks: FlowBlock[],
  contentWidth: number,
): FloatingZoneWithAnchor[] {
  const zones: FloatingZoneWithAnchor[] = [];

  for (let blockIndex = 0; blockIndex < blocks.length; blockIndex++) {
    const block = blocks[blockIndex]!; // SAFETY: blockIndex < blocks.length
    if (block.kind !== "paragraph") {
      continue;
    }

    const paragraphBlock = block as ParagraphBlock;

    for (const run of paragraphBlock.runs) {
      if (run.kind !== "image") {
        continue;
      }
      const imgRun = run as ImageRun;

      if (!isFloatingImageRun(imgRun)) {
        continue;
      }

      // Calculate Y position based on vertical alignment
      let topY = 0;
      const position = imgRun.position;
      const distTop = imgRun.distTop ?? 0;
      const distBottom = imgRun.distBottom ?? 0;
      const distLeft = imgRun.distLeft ?? 12;
      const distRight = imgRun.distRight ?? 12;

      if (position?.vertical) {
        const v = position.vertical;
        if (v.align === "top" && v.relativeTo === "margin") {
          // Image at top of content area
          topY = 0;
        } else if (v.posOffset !== undefined) {
          topY = emuToPixels(v.posOffset);
        }
        // Other cases (paragraph-relative) are harder to handle without knowing paragraph positions
      }

      const bottomY = topY + imgRun.height;

      // Calculate margins based on horizontal position
      let leftMargin = 0;
      let rightMargin = 0;

      if (position?.horizontal) {
        const h = position.horizontal;
        if (h.align === "left") {
          // Image on left - text needs left margin
          leftMargin = imgRun.width + distRight;
        } else if (h.align === "right") {
          // Image on right - text needs right margin
          rightMargin = imgRun.width + distLeft;
        } else if (h.posOffset !== undefined) {
          const x = emuToPixels(h.posOffset);
          if (x < contentWidth / 2) {
            leftMargin = x + imgRun.width + distRight;
          } else {
            rightMargin = contentWidth - x + distLeft;
          }
        }
      } else if (imgRun.cssFloat === "left") {
        leftMargin = imgRun.width + distRight;
      } else if (imgRun.cssFloat === "right") {
        rightMargin = imgRun.width + distLeft;
      }

      if (leftMargin > 0 || rightMargin > 0) {
        // Images positioned relative to margin/page apply globally (before their anchor paragraph)
        const isMarginRelative =
          position?.vertical?.relativeTo === "margin" ||
          position?.vertical?.relativeTo === "page";
        zones.push({
          leftMargin,
          rightMargin,
          topY: topY - distTop,
          bottomY: bottomY + distBottom,
          anchorBlockIndex: blockIndex,
          isMarginRelative,
        });
      }
    }
  }

  // Floating tables (block-level) - treat them as exclusion zones for subsequent text
  for (let blockIndex = 0; blockIndex < blocks.length; blockIndex++) {
    const block = blocks[blockIndex]!; // SAFETY: blockIndex < blocks.length
    if (block.kind !== "table") {
      continue;
    }

    const tableBlock = block as TableBlock;
    const floating = tableBlock.floating;
    if (!floating) {
      continue;
    }

    const tableMeasure = measureTableBlock(tableBlock, contentWidth);
    const tableWidth = tableMeasure.totalWidth;
    const tableHeight = tableMeasure.totalHeight;

    const distLeft = floating.leftFromText ?? 12;
    const distRight = floating.rightFromText ?? 12;
    const distTop = floating.topFromText ?? 0;
    const distBottom = floating.bottomFromText ?? 0;

    let leftMargin = 0;
    let rightMargin = 0;

    // Determine horizontal position relative to content area
    let x = 0;
    if (floating.tblpX !== undefined) {
      x = floating.tblpX;
    } else if (floating.tblpXSpec) {
      if (floating.tblpXSpec === "left" || floating.tblpXSpec === "inside") {
        x = 0;
      } else if (
        floating.tblpXSpec === "right" ||
        floating.tblpXSpec === "outside"
      ) {
        x = contentWidth - tableWidth;
      } else {
        x = (contentWidth - tableWidth) / 2;
      }
    } else if (tableBlock.justification === "center") {
      x = (contentWidth - tableWidth) / 2;
    } else if (tableBlock.justification === "right") {
      x = contentWidth - tableWidth;
    }

    if (x < contentWidth / 2) {
      leftMargin = x + tableWidth + distRight;
    } else {
      rightMargin = contentWidth - x + distLeft;
    }

    const topY = floating.tblpY ?? 0;
    const bottomY = topY + tableHeight;

    zones.push({
      leftMargin,
      rightMargin,
      topY: topY - distTop,
      bottomY: bottomY + distBottom,
      anchorBlockIndex: blockIndex,
    });
  }

  return zones;
}

/**
 * Measure a block based on its type.
 */
function measureBlock(
  block: FlowBlock,
  contentWidth: number,
  floatingZones?: FloatingImageZone[],
  cumulativeY?: number,
): Measure {
  switch (block.kind) {
    case "paragraph": {
      const pBlock = block as ParagraphBlock;

      // Cache paragraph measurements when no floating zones affect this block.
      // Safe because without floating zones the result depends only on content
      // and contentWidth (both captured in the cache key). When floating zones
      // ARE present, we always measure fresh since zones depend on inter-block
      // layout context (cumulative Y, neighboring floating tables/images).
      if (!floatingZones || floatingZones.length === 0) {
        const cached = getCachedParagraphMeasure(pBlock, contentWidth);
        if (cached) {
          return cached;
        }
      }

      const measureOpts: Parameters<typeof measureParagraph>[2] = {
        paragraphYOffset: cumulativeY ?? 0,
      };
      if (floatingZones) {
        measureOpts.floatingZones = floatingZones;
      }
      const result = measureParagraph(pBlock, contentWidth, measureOpts);

      if (!floatingZones || floatingZones.length === 0) {
        setCachedParagraphMeasure(pBlock, contentWidth, result);
      }

      return result;
    }

    case "table": {
      return measureTableBlock(block as TableBlock, contentWidth);
    }

    case "image": {
      const imageBlock = block as ImageBlock;
      return {
        kind: "image",
        width: imageBlock.width,
        height: imageBlock.height,
      };
    }

    case "textBox": {
      const tb = block as TextBoxBlock;
      const margins = tb.margins ?? DEFAULT_TEXTBOX_MARGINS;
      const innerWidth = tb.width - margins.left - margins.right;
      const innerMeasures = tb.content.map((p) =>
        measureParagraph(p, innerWidth),
      );
      const contentHeight = innerMeasures.reduce(
        (sum, m) => sum + m.totalHeight,
        0,
      );
      const totalHeight =
        tb.height ?? contentHeight + margins.top + margins.bottom;
      return {
        kind: "textBox" as const,
        width: tb.width,
        height: totalHeight,
        innerMeasures,
      };
    }

    case "pageBreak":
      return { kind: "pageBreak" };

    case "columnBreak":
      return { kind: "columnBreak" };

    case "sectionBreak":
      return { kind: "sectionBreak" };

    default:
      // Unknown block type - return empty paragraph measure
      return {
        kind: "paragraph",
        lines: [],
        totalHeight: 0,
      };
  }
}

/**
 * Measure all blocks with floating image support.
 *
 * Pre-scans all blocks to find floating images and creates exclusion zones.
 * Then measures each block, passing the zones so paragraphs can calculate
 * per-line widths based on vertical overlap with floating images.
 */
function measureBlocks(
  blocks: FlowBlock[],
  contentWidth: number | number[],
): Measure[] {
  const defaultWidth = Array.isArray(contentWidth)
    ? (contentWidth[0] ?? 0)
    : contentWidth;
  // Pre-extract floating image exclusion zones with anchor block indices
  const floatingZonesWithAnchors = extractFloatingZones(blocks, defaultWidth);

  // Margin-relative zones (positioned relative to page/margin) on the same vertical
  // position are likely on the same page. Group them and activate all from the earliest
  // anchor so text wraps around ALL images from the first paragraph onward.
  // e.g. left-aligned and right-aligned images at margin top should both affect text
  // starting from the first anchor paragraph, not just the one containing each image.
  const marginRelative = floatingZonesWithAnchors.filter(
    (z) => z.isMarginRelative,
  );
  const paragraphRelative = floatingZonesWithAnchors.filter(
    (z) => !z.isMarginRelative,
  );

  // Group margin-relative zones by topY and move all to earliest anchor in group
  const marginByTopY = new Map<number, FloatingZoneWithAnchor[]>();
  for (const z of marginRelative) {
    const group = marginByTopY.get(z.topY) ?? [];
    group.push(z);
    marginByTopY.set(z.topY, group);
  }

  const adjustedZones: FloatingZoneWithAnchor[] = [...paragraphRelative];
  for (const group of marginByTopY.values()) {
    const minAnchor = Math.min(...group.map((z) => z.anchorBlockIndex));
    for (const z of group) {
      adjustedZones.push({ ...z, anchorBlockIndex: minAnchor });
    }
  }

  // Group zones by effective anchor block index
  const zonesByAnchor = new Map<number, FloatingImageZone[]>();
  for (const z of adjustedZones) {
    const existing = zonesByAnchor.get(z.anchorBlockIndex) ?? [];
    existing.push({
      leftMargin: z.leftMargin,
      rightMargin: z.rightMargin,
      topY: z.topY,
      bottomY: z.bottomY,
    });
    zonesByAnchor.set(z.anchorBlockIndex, existing);
  }

  const anchorIndices = new Set(adjustedZones.map((z) => z.anchorBlockIndex));

  // Track cumulative Y position for floating zone overlap calculation
  // Resets when we reach a block with floating images (establishing local page coords)
  let cumulativeY = 0;
  let activeZones: FloatingImageZone[] = [];

  return blocks.map((block, blockIndex) => {
    recordMeasureBlock(blockIndex, block);

    // Check if this block is an anchor for floating images
    // If so, reset cumulative Y and replace active zones (old zones from previous
    // anchors are invalid after the Y reset since their topY/bottomY are in the old
    // coordinate system)
    if (anchorIndices.has(blockIndex)) {
      cumulativeY = 0;
      activeZones = zonesByAnchor.get(blockIndex) ?? [];
    }

    const zones = activeZones.length > 0 ? activeZones : undefined;

    try {
      const blockWidth = Array.isArray(contentWidth)
        ? (contentWidth[blockIndex] ?? defaultWidth)
        : contentWidth;
      const measure = measureBlock(block, blockWidth, zones, cumulativeY);

      // Update cumulative Y for next block
      if (
        "totalHeight" in measure &&
        !(block.kind === "table" && (block as TableBlock).floating)
      ) {
        cumulativeY += measure.totalHeight;
      }

      return measure;
    } catch {
      // Return a minimal real measure so layout doesn't crash; the original
      // measureBlock failure is swallowed here (downstream layout treats this
      // as a single-line paragraph of fixed height).
      const fallback: ParagraphMeasure = {
        kind: "paragraph",
        lines: [],
        totalHeight: 20,
      };
      return fallback;
    }
  });
}

function measureSingleBlockWithoutFloatingZones(
  block: FlowBlock,
  blockWidth: number,
  blockIndex: number,
): Measure {
  recordMeasureBlock(blockIndex, block);
  return measureBlock(block, blockWidth);
}

// =============================================================================
// FOOTNOTE HELPERS
// =============================================================================

/**
 * Build per-page footnote render items from page footnote mapping.
 */
function buildFootnoteRenderItems(
  pageFootnoteMap: Map<number, number[]>,
  footnoteContentMap: Map<number, FootnoteContent>,
  doc: Document | null,
): Map<number, FootnoteRenderItem[]> {
  const result = new Map<number, FootnoteRenderItem[]>();
  if (!doc || !doc.package.footnotes) {
    return result;
  }

  // Build lookup for footnote text
  const fnLookup = new Map<number, Footnote>();
  for (const fn of doc.package.footnotes) {
    if (fn.noteType && fn.noteType !== "normal") {
      continue;
    }
    fnLookup.set(fn.id, fn);
  }

  for (const [pageNumber, footnoteIds] of pageFootnoteMap) {
    const items: FootnoteRenderItem[] = [];

    for (const fnId of footnoteIds) {
      const fn = fnLookup.get(fnId);
      if (!fn) {
        continue;
      }

      const content = footnoteContentMap.get(fnId);
      const displayNum = content?.displayNumber ?? 0;
      const text = getFootnoteText(fn);

      items.push({
        displayNumber: String(displayNum),
        text,
        ...(content
          ? {
              content: {
                blocks: content.blocks,
                measures: content.measures,
                height: content.height,
              },
            }
          : {}),
      });
    }

    if (items.length > 0) {
      result.set(pageNumber, items);
    }
  }

  return result;
}

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * PagedEditor - Main paginated editing component.
 */
export function PagedEditor(
  props: PagedEditorProps & { ref?: Ref<PagedEditorRef> },
) {
  const {
    ref,
    document,
    styles,
    theme: _theme,
    sectionProperties,
    headerContent,
    footerContent,
    firstPageHeaderContent,
    firstPageFooterContent,
    headerContentRId,
    footerContentRId,
    firstPageHeaderContentRId,
    firstPageFooterContentRId,
    readOnly = false,
    pageGap = DEFAULT_PAGE_GAP,
    zoom = 1,
    onDocumentChange,
    onReadOnlyEditAttempt,
    onSelectionChange,
    onSelectionTextChange,
    externalPlugins = EMPTY_PLUGINS,
    collaboration,
    extensionManager,
    onHeaderFooterDoubleClick,
    hfEditMode,
    onBodyClick,
    className,
    style,
    commentsSidebarOpen = false,
    sidebarOverlay,
    scrollContainerRef: scrollContainerRefProp,
    onHyperlinkClick,
    onContextMenu,
    onAnchorPositionsChange,
    onTotalPagesChange,
    anchorPositionMode = "comments-and-revisions",
    onAnonymizationTermClick,
    selectedAnonymizationCanonical = null,
    anonymizationSelectionSeq,
  } = props;

  // Resolve the scroll container: prefer parent-provided ref, fallback to own container
  const getScrollContainer = useCallback((): HTMLDivElement | null => {
    if (scrollContainerRefProp && typeof scrollContainerRefProp === "object") {
      return (scrollContainerRefProp as React.RefObject<HTMLDivElement | null>)
        .current;
    }
    return containerRef.current;
  }, [scrollContainerRefProp]);

  // Refs
  const containerRef = useRef<HTMLDivElement>(null);
  const pagesContainerRef = useRef<HTMLDivElement>(null);
  const hiddenPMRef = useRef<HiddenProseMirrorRef>(null);
  const hfPMsRef = useRef<HiddenHeaderFooterPMsRef>(null);
  const painterRef = useRef<LayoutPainter | null>(null);

  // Visual line navigation (ArrowUp/ArrowDown with sticky X)
  const { handlePMKeyDown } = useVisualLineNavigation({ pagesContainerRef });

  // Stable ref for drag-extend callback (avoids circular deps with getPositionFromMouse)
  // oxlint-disable-next-line eslint/no-empty-function
  const dragExtendRef = useRef<(cx: number, cy: number) => void>(() => {});

  // Store callbacks in refs to avoid infinite re-render loops
  // when parent passes unstable callback references
  const onSelectionChangeRef = useRef(onSelectionChange);
  const onSelectionTextChangeRef = useRef(onSelectionTextChange);
  const onDocumentChangeRef = useRef(onDocumentChange);
  const onTotalPagesChangeRef = useRef(onTotalPagesChange);
  const lastTotalPagesRef = useRef<number | null>(null);

  // Keep refs in sync with latest props
  onSelectionChangeRef.current = onSelectionChange;
  onSelectionTextChangeRef.current = onSelectionTextChange;
  onDocumentChangeRef.current = onDocumentChange;
  onTotalPagesChangeRef.current = onTotalPagesChange;

  // State
  const [layout, setLayout] = useState<Layout | null>(null);
  const [blocks, setBlocks] = useState<FlowBlock[]>([]);
  const [measures, setMeasures] = useState<Measure[]>([]);
  const [shouldCreateHiddenEditorView, setShouldCreateHiddenEditorView] =
    useState(() => collaboration !== undefined);
  const shouldFocusHiddenEditorOnReadyRef = useRef(collaboration !== undefined);
  const [precomputedInitialState, setPrecomputedInitialState] =
    useState<EditorState | null>(null);
  const layoutArtifactsRef = useRef<{
    blocks: FlowBlock[];
    blockWidths: number[];
    measures: Measure[];
  } | null>(null);
  const precomputedInitialStateRef = useRef<EditorState | null>(null);
  const precomputedInitialDocumentRef = useRef<Document | null>(null);
  const preHiddenInitialLayoutDoneRef = useRef(false);
  const pendingHiddenEditorSelectionRef =
    useRef<PendingHiddenEditorSelection | null>(null);
  const queuedInputBeforeHiddenEditorRef = useRef<QueuedHiddenEditorInput[]>(
    [],
  );
  const lastLayoutEditorStateRef = useRef<EditorState | null>(null);
  const lastLaidOutPmDocRef = useRef<EditorState["doc"] | null>(null);
  const lastLayoutUsedLoadedFontsRef = useRef(false);
  const pendingInitialFontReadyLayoutRef = useRef(false);
  const suppressFontReadyUntilRef = useRef(0);
  const [isFocused, setIsFocused] = useState(false);
  const [selectionRects, setSelectionRects] = useState<SelectionRect[]>([]);
  const [caretPosition, setCaretPosition] = useState<CaretPosition | null>(
    null,
  );
  const [anonymizationRectGroups, setAnonymizationRectGroups] = useState<
    AnonymizationRectGroup[]
  >([]);
  // Plain ref to the latest match list so the recompute effect
  // doesn't depend on a state setter callback that would trigger
  // its own re-run.
  const anonymizationMatchesRef = useRef<readonly AnonymizationMatch[]>([]);
  const anonymizationOverlayRequestSeqRef = useRef(0);
  const [remoteSelections, setRemoteSelections] = useState<
    HiddenProseMirrorRemoteSelection[]
  >([]);
  const suppressSelectionOverlayRef = useRef(false);
  const revealSelectionOverlayTimerRef = useRef<number | null>(null);
  const selectionOverlayRequestSeqRef = useRef(0);

  const validPrecomputedInitialState =
    precomputedInitialDocumentRef.current === document
      ? precomputedInitialState
      : null;
  precomputedInitialStateRef.current = validPrecomputedInitialState;

  // Image selection state
  const [selectedImageInfo, setSelectedImageInfo] =
    useState<ImageSelectionInfo | null>(null);
  const isImageInteractingRef = useRef(false);

  /** Build ImageSelectionInfo from a DOM element with data-pm-start */
  const buildImageSelectionInfo = useCallback(
    (el: HTMLElement, pmPos: number): ImageSelectionInfo => {
      const imgTagCandidate =
        el.tagName === "IMG" ? el : el.querySelector("img");
      const imgTag =
        imgTagCandidate instanceof HTMLElement ? imgTagCandidate : null;
      const element = imgTag ?? el;
      const rect = element.getBoundingClientRect();
      return {
        element,
        pmPos,
        width: Math.round(rect.width / zoom),
        height: Math.round(rect.height / zoom),
      };
    },
    [zoom],
  );

  // Drag selection state
  const isDraggingRef = useRef(false);
  const dragAnchorRef = useRef<number | null>(null);
  // When the drag originated inside a painted HF slot, the anchor lives in
  // that slot's PM (`hfPMsRef.current.getView(rId)`), not the body PM. The
  // pointer pipeline reads this on every mousemove + on shift-click extend
  // so drag-select / shift-extend dispatch on the right surface.
  const activeHfDragSurfaceRef = useRef<{
    rId: string;
    kind: "header" | "footer";
  } | null>(null);
  // Same idea for table resize: when the resize handle lives inside an HF
  // table the commit must dispatch setNodeMarkup on that slot's PM, not on
  // the body PM. Captured at mousedown, cleared on mouseup.
  const resizingHfSurfaceRef = useRef<{
    rId: string;
    kind: "header" | "footer";
  } | null>(null);

  const ensureHiddenEditorView = useCallback(
    ({ focus = true, sync = false }: EnsureHiddenEditorViewOptions = {}) => {
      if (focus) {
        shouldFocusHiddenEditorOnReadyRef.current = true;
      } else if (
        !shouldCreateHiddenEditorView &&
        !hiddenPMRef.current?.getView()
      ) {
        shouldFocusHiddenEditorOnReadyRef.current = false;
      }

      if (sync) {
        flushSync(() => {
          setShouldCreateHiddenEditorView(true);
        });
        return;
      }

      setShouldCreateHiddenEditorView(true);
    },
    [shouldCreateHiddenEditorView],
  );

  const queueHiddenEditorSelection = useCallback(
    (selection: PendingHiddenEditorSelection) => {
      pendingHiddenEditorSelectionRef.current = selection;
      ensureHiddenEditorView();
    },
    [ensureHiddenEditorView],
  );

  const queueHiddenEditorTextInput = useCallback((text: string) => {
    queuedInputBeforeHiddenEditorRef.current.push({ type: "text", text });
  }, []);

  const queueHiddenEditorKeyDown = useCallback((event: React.KeyboardEvent) => {
    queuedInputBeforeHiddenEditorRef.current.push({
      type: "keydown",
      eventInit: toDeferredKeyboardEventInit(event),
    });
  }, []);

  const applyPendingHiddenEditorInput = useCallback((view: EditorView) => {
    const pendingSelection = pendingHiddenEditorSelectionRef.current;
    pendingHiddenEditorSelectionRef.current = null;

    if (pendingSelection?.type === "node") {
      try {
        view.dispatch(
          view.state.tr.setSelection(
            NodeSelection.create(view.state.doc, pendingSelection.pos),
          ),
        );
      } catch {
        // Fall through to queued text insertion at the current selection.
      }
    }

    if (pendingSelection?.type === "text") {
      const docEnd = view.state.doc.content.size;
      const anchor = Math.max(0, Math.min(pendingSelection.anchor, docEnd));
      const head =
        pendingSelection.head === undefined
          ? anchor
          : Math.max(0, Math.min(pendingSelection.head, docEnd));
      try {
        const selection = TextSelection.between(
          view.state.doc.resolve(anchor),
          view.state.doc.resolve(head),
        );
        view.dispatch(view.state.tr.setSelection(selection));
      } catch {
        // Keep the default selection if the cached visual position went stale.
      }
    }

    const queuedInput = queuedInputBeforeHiddenEditorRef.current;
    if (queuedInput.length === 0) {
      return;
    }

    queuedInputBeforeHiddenEditorRef.current = [];
    for (const input of queuedInput) {
      if (input.type === "text") {
        dispatchEditorTextInput(view, input.text);
        continue;
      }

      replayDeferredKeyDown(view, input.eventInit);
    }
  }, []);

  useEffect(() => {
    if (collaboration !== undefined) {
      ensureHiddenEditorView();
    }
  }, [collaboration, ensureHiddenEditorView]);

  // Column resize state
  const isResizingColumnRef = useRef(false);
  const resizeStartXRef = useRef(0);
  const resizeColumnIndexRef = useRef(0);
  const resizeTablePmStartRef = useRef(0);
  const resizeOrigWidthsRef = useRef({
    left: 0,
    right: 0,
  });
  const resizeHandleRef = useRef<HTMLElement | null>(null);

  // Row resize state
  const isResizingRowRef = useRef(false);
  const resizeStartYRef = useRef(0);
  const resizeRowIndexRef = useRef(0);
  const resizeRowTablePmStartRef = useRef(0);
  const resizeRowOrigHeightRef = useRef(0); // twips
  const resizeRowHandleRef = useRef<HTMLElement | null>(null);
  const resizeRowIsEdgeRef = useRef(false);

  // Right edge resize state (grows last column only)
  const isResizingRightEdgeRef = useRef(false);
  const resizeRightEdgeStartXRef = useRef(0);
  const resizeRightEdgeColIndexRef = useRef(0);
  const resizeRightEdgePmStartRef = useRef(0);
  const resizeRightEdgeOrigWidthRef = useRef(0); // twips
  const resizeRightEdgeHandleRef = useRef<HTMLElement | null>(null);

  // Cell selection drag state
  const isCellDraggingRef = useRef(false);
  const cellDragAnchorPosRef = useRef<number | null>(null);
  const cellDragLastPmPosRef = useRef<number | null>(null);
  const cellDragOverflowXRef = useRef<number | null>(null);
  const CELL_SELECT_OVERFLOW_PX = 5; // px of continued drag after text selection maxes out

  // Table quick action insert button state
  type TableInsertButtonState = {
    type: "row" | "column";
    /** Pixel position relative to viewport container */
    x: number;
    y: number;
    /** PM position inside target cell (to set selection before dispatching) */
    cellPmPos: number;
  };
  const [tableInsertButton, setTableInsertButton] =
    useState<TableInsertButtonState | null>(null);
  const tableInsertHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );

  const clearTableInsertTimer = useCallback(() => {
    if (tableInsertHideTimerRef.current) {
      clearTimeout(tableInsertHideTimerRef.current);
      tableInsertHideTimerRef.current = null;
    }
  }, []);

  // Cleanup timer on unmount
  useEffect(
    () => () => {
      if (tableInsertHideTimerRef.current) {
        clearTimeout(tableInsertHideTimerRef.current);
      }
    },
    [],
  );

  // Selection gate - ensures selection renders only when layout is current
  const syncCoordinator = useMemo(() => new LayoutSelectionGate(), []);

  // Compute page size and margins
  const pageSize = useMemo(
    () => getPageSize(sectionProperties),
    [sectionProperties],
  );
  const margins = useMemo(
    () => getMargins(sectionProperties),
    [sectionProperties],
  );
  const columns = useMemo(
    () => getColumns(sectionProperties),
    [sectionProperties],
  );
  const contentWidth = pageSize.w - margins.left - margins.right;
  const defaultTabStop = document?.package.settings?.defaultTabStop;
  const layoutInputSignature = useMemo(
    () =>
      buildLayoutInputSignature({
        columns,
        contentWidth,
        defaultTabStop,
        firstPageFooterContent,
        firstPageHeaderContent,
        footerContent,
        headerContent,
        margins,
        pageGap,
        pageSize,
        sectionProperties,
        styles,
        theme: _theme,
      }),
    [
      columns,
      contentWidth,
      defaultTabStop,
      firstPageFooterContent,
      firstPageHeaderContent,
      footerContent,
      headerContent,
      margins,
      pageGap,
      pageSize,
      sectionProperties,
      styles,
      _theme,
    ],
  );

  // Initialize painter using useMemo to ensure it's ready before first render callbacks
  const painter = useMemo(
    () =>
      new LayoutPainter({
        pageGap,
        showShadow: false,
      }),
    [pageGap],
  );

  // Keep ref in sync with memoized painter
  painterRef.current = painter;

  // =========================================================================
  // Layout Pipeline
  // =========================================================================

  /**
   * Run the full layout pipeline:
   * 1. Convert PM doc to blocks
   * 2. Measure blocks
   * 3. Layout blocks onto pages
   * 4. Paint pages to DOM
   */
  const runLayoutPipeline = useCallback(
    (
      state: EditorState,
      options: {
        dirtyRange?: DirtyRange;
        forceFull?: boolean;
        reason?: LayoutRunReason;
      } = {},
    ) => {
      const reason = options.reason ?? "manual";
      const recordPhaseDuration = (
        phase: LayoutPhase,
        startedAt: number,
      ): void => {
        recordLayoutPhase(reason, phase, performance.now() - startedAt);
      };

      // Capture current state sequence for this layout run
      const currentEpoch = syncCoordinator.getStateSeq();

      // Signal layout is starting
      syncCoordinator.onLayoutStart();

      try {
        // Step 1: Convert PM doc to flow blocks
        let phaseStartedAt = performance.now();
        const pageContentHeight = pageSize.h - margins.top - margins.bottom;
        const flowOpts: ToFlowBlocksOptions = {
          pageContentHeight,
        };
        if (_theme !== undefined) {
          flowOpts.theme = _theme;
        }
        // Stamp the document's `w:defaultTabStop` onto every paragraph so
        // list-marker tab-stop math (renderParagraph + measureParagraph)
        // uses the right grid. Absent settings.xml falls back to the
        // OOXML default inside `getListMarkerInlineWidth`.
        if (defaultTabStop !== undefined) {
          flowOpts.defaultTabStopTwips = defaultTabStop;
        }
        const newBlocks = toFlowBlocks(state.doc, flowOpts);
        setBlocks(newBlocks);
        recordPhaseDuration("flow-blocks", phaseStartedAt);

        // Compute per-block widths accounting for section breaks with different column configs
        phaseStartedAt = performance.now();
        const bodyLayoutConfig: SectionLayoutConfig = {
          pageSize,
          margins,
        };
        if (columns !== undefined) {
          bodyLayoutConfig.columns = columns;
        }
        const blockWidths = computePerBlockWidths({
          blocks: newBlocks,
          bodyConfig: bodyLayoutConfig,
          finalConfig: bodyLayoutConfig,
        });
        const incrementalResult =
          options.dirtyRange && !options.forceFull && layoutArtifactsRef.current
            ? tryBuildIncrementalMeasures({
                previousBlocks: layoutArtifactsRef.current.blocks,
                previousMeasures: layoutArtifactsRef.current.measures,
                previousBlockWidths: layoutArtifactsRef.current.blockWidths,
                nextBlocks: newBlocks,
                nextBlockWidths: blockWidths,
                dirtyRange: options.dirtyRange,
                measureBlock: measureSingleBlockWithoutFloatingZones,
              })
            : null;
        const newMeasures =
          incrementalResult?.measures ?? measureBlocks(newBlocks, blockWidths);
        layoutArtifactsRef.current = {
          blocks: newBlocks,
          blockWidths,
          measures: newMeasures,
        };
        setMeasures(newMeasures);
        recordPhaseDuration("measure-blocks", phaseStartedAt);

        // Step 2.5: Collect footnote references from blocks
        phaseStartedAt = performance.now();
        const footnoteRefs = collectFootnoteRefs(newBlocks);
        const hasFootnotes =
          footnoteRefs.length > 0 && document?.package.footnotes;

        // Step 2.75: Prepare header/footer content for rendering (needed before layout
        // to compute effective margins when header content exceeds available space)
        const hfMetricsHeader: HeaderFooterMetrics = {
          section: "header",
          pageSize,
          margins,
        };
        const hfMetricsFooter: HeaderFooterMetrics = {
          section: "footer",
          pageSize,
          margins,
        };
        const hfOptions = {
          ...(styles ? { styles } : {}),
          ...(_theme !== undefined ? { theme: _theme } : {}),
          measureBlocks,
          ...(defaultTabStop !== undefined
            ? { defaultTabStopTwips: defaultTabStop }
            : {}),
        };
        const headerContentForRender = renderHfFromContentOrPm(
          headerContent,
          headerContentRId,
          hfPMsRef.current,
          contentWidth,
          hfMetricsHeader,
          hfOptions,
        );
        const footerContentForRender = renderHfFromContentOrPm(
          footerContent,
          footerContentRId,
          hfPMsRef.current,
          contentWidth,
          hfMetricsFooter,
          hfOptions,
        );
        const hasTitlePg = sectionProperties?.titlePg === true;
        const firstPageHeaderForRender = hasTitlePg
          ? renderHfFromContentOrPm(
              firstPageHeaderContent,
              firstPageHeaderContentRId,
              hfPMsRef.current,
              contentWidth,
              hfMetricsHeader,
              hfOptions,
            )
          : undefined;
        const firstPageFooterForRender = hasTitlePg
          ? renderHfFromContentOrPm(
              firstPageFooterContent,
              firstPageFooterContentRId,
              hfPMsRef.current,
              contentWidth,
              hfMetricsFooter,
              hfOptions,
            )
          : undefined;

        // Default extender — applied to pages 2+ of every section. It
        // ignores firstPage H/F so a `<w:titlePg/>` section's
        // overflowing first-page header doesn't push body content down
        // on every subsequent page.
        const extendForHfOverflow = computeHeaderFooterMarginExtender({
          headerContent: headerContentForRender,
          footerContent: footerContentForRender,
          firstPageHeaderContent: firstPageHeaderForRender,
          firstPageFooterContent: firstPageFooterForRender,
        });
        // First-page extender — used only for page 1 of a titlePg
        // section so the title page's larger header reservation is
        // honored without leaking onto pages 2+.
        const extendForFirstPage = computeFirstPageHeaderFooterMarginExtender({
          headerContent: headerContentForRender,
          footerContent: footerContentForRender,
          firstPageHeaderContent: firstPageHeaderForRender,
          firstPageFooterContent: firstPageFooterForRender,
        });
        const effectiveMargins = extendForHfOverflow(margins);
        const effectiveFirstPageMargins = hasTitlePg
          ? extendForFirstPage(margins)
          : undefined;
        // Section-break blocks carry their own `sb.margins` from
        // `<w:sectPr>` and the layout engine prefers those over the
        // body-level fallback. Apply the extension to each one too,
        // otherwise a footer that overflows on one section silently
        // re-overlaps body text on the next. (Eigenpal #400.)
        for (const block of newBlocks) {
          if (block.kind !== "sectionBreak") {
            continue;
          }
          const sb = block as SectionBreakBlock;
          if (sb.margins) {
            sb.margins = extendForHfOverflow(sb.margins);
          }
        }
        recordPhaseDuration("header-footer", phaseStartedAt);

        // Step 3: Layout blocks onto pages (two-pass if footnotes exist)
        phaseStartedAt = performance.now();
        let newLayout: Layout;
        let pageFootnoteMap = new Map<number, number[]>();
        let footnoteContentMap = new Map<number, FootnoteContent>();

        // Common layout options for all passes
        const bodyBreakType = sectionProperties?.sectionStart as
          | "continuous"
          | "nextPage"
          | "evenPage"
          | "oddPage"
          | undefined;
        const layoutOpts: Parameters<typeof layoutDocument>[2] = {
          pageSize,
          margins: effectiveMargins,
          pageGap,
        };
        if (effectiveFirstPageMargins !== undefined) {
          layoutOpts.firstPageMargins = effectiveFirstPageMargins;
        }
        if (columns !== undefined) {
          layoutOpts.columns = columns;
        }
        if (bodyBreakType !== undefined) {
          layoutOpts.bodyBreakType = bodyBreakType;
        }

        if (hasFootnotes) {
          // Build footnote content and measure heights up front. The
          // per-fn height table feeds into the layout engine so each
          // body line carrying an fn ref reserves space for that fn
          // on its host page in a single pass — no convergence loop.
          footnoteContentMap = buildFootnoteContentMap(
            document!.package.footnotes!,
            footnoteRefs,
            contentWidth,
            (() => {
              const footnoteOptions: Parameters<
                typeof buildFootnoteContentMap
              >[3] = { measureBlocks };
              if (styles) {
                footnoteOptions.styles = styles;
              }
              if (_theme !== undefined) {
                footnoteOptions.theme = _theme;
              }
              if (defaultTabStop !== undefined) {
                footnoteOptions.defaultTabStopTwips = defaultTabStop;
              }
              return footnoteOptions;
            })(),
          );

          const footnoteHeightById = new Map<number, number>();
          // Per-fn vertical margin applied by the painter
          // (`renderFootnoteArea` sets `marginBottom: 4px` on each
          // fn entry). Reserved alongside content height so the page
          // accounts for inter-fn whitespace.
          const FOOTNOTE_ENTRY_MARGIN = 4;
          for (const [id, content] of footnoteContentMap) {
            footnoteHeightById.set(id, content.height + FOOTNOTE_ENTRY_MARGIN);
          }
          // Note: the layout engine adds the divider's height once
          // per fn-bearing page (in paginator.addFootnoteHeight); we
          // pass per-fn (content + entry margin) here.

          newLayout = layoutDocument(newBlocks, newMeasures, {
            ...layoutOpts,
            footnoteHeightById,
          });

          // The layout engine assigned `page.footnoteIds` line-by-
          // line via `paginator.addFootnoteHeight(_, ids)`, so a fn
          // ref in a continuation fragment of a split paragraph
          // lands on the page where the ref-bearing line actually
          // is. Build pageFootnoteMap from those page records (not
          // from `mapFootnotesToPages`'s pmRange scan, which can't
          // disambiguate split-paragraph halves; Codex PR #258).
          pageFootnoteMap = new Map<number, number[]>();
          for (const page of newLayout.pages) {
            if (page.footnoteIds && page.footnoteIds.length > 0) {
              pageFootnoteMap.set(page.number, page.footnoteIds);
            }
          }
        } else {
          // No footnotes — single pass
          newLayout = layoutDocument(newBlocks, newMeasures, layoutOpts);
        }

        setLayout(newLayout);
        lastLayoutEditorStateRef.current = state;
        lastLaidOutPmDocRef.current = state.doc;
        lastLayoutUsedLoadedFontsRef.current = documentFontsAreLoaded();
        recordLayoutComplete(reason);
        recordPhaseDuration("layout-document", phaseStartedAt);

        // Step 4: Paint to DOM
        if (pagesContainerRef.current && painterRef.current) {
          phaseStartedAt = performance.now();
          // Build block lookup
          const blockLookup: BlockLookup = new Map();
          for (let i = 0; i < newBlocks.length; i++) {
            const block = newBlocks[i];
            const measure = newMeasures[i];
            if (block && measure) {
              blockLookup.set(String(block.id), { block, measure });
            }
          }
          painterRef.current.setBlockLookup(blockLookup);

          // Build per-page footnote render items
          const footnotesByPage = hasFootnotes
            ? buildFootnoteRenderItems(
                pageFootnoteMap,
                footnoteContentMap,
                document,
              )
            : undefined;

          // Render pages to container.
          // Built incrementally so optional fields are only present when
          // defined (RenderPageOptions has `exactOptionalPropertyTypes`).
          const renderOpts: RenderPageOptions & {
            pageGap?: number;
            footnotesByPage?: Map<number, FootnoteRenderItem[]>;
          } = {
            pageGap,
            showShadow: true,
            blockLookup,
            titlePg: hasTitlePg,
          };
          if (headerContentForRender) {
            renderOpts.headerContent = headerContentForRender;
          }
          if (footerContentForRender) {
            renderOpts.footerContent = footerContentForRender;
          }
          if (firstPageHeaderForRender) {
            renderOpts.firstPageHeaderContent = firstPageHeaderForRender;
          }
          if (firstPageFooterForRender) {
            renderOpts.firstPageFooterContent = firstPageFooterForRender;
          }
          if (sectionProperties?.headerDistance) {
            renderOpts.headerDistance = twipsToPixels(
              sectionProperties.headerDistance,
            );
          }
          if (sectionProperties?.footerDistance) {
            renderOpts.footerDistance = twipsToPixels(
              sectionProperties.footerDistance,
            );
          }
          if (sectionProperties?.pageBorders) {
            renderOpts.pageBorders = sectionProperties.pageBorders;
          }
          if (_theme) {
            renderOpts.theme = _theme;
          }
          if (footnotesByPage?.size) {
            renderOpts.footnotesByPage = footnotesByPage;
          }
          renderPages(newLayout.pages, pagesContainerRef.current, renderOpts);
          recordPhaseDuration("render-pages", phaseStartedAt);
        }
      } catch (error) {
        const invalidHighlights = describeInvalidHighlightMarks(state.doc);
        recordLayoutError(
          reason,
          invalidHighlights
            ? new Error(
                `${String(error)} Invalid highlights: ${invalidHighlights}`,
              )
            : error,
        );
        // Keep the previous visible layout if measurement or painting fails.
      }

      // Signal layout is complete for this sequence
      syncCoordinator.onLayoutComplete(currentEpoch);
    },
    // oxlint-disable-next-line react-hooks/exhaustive-deps
    [
      contentWidth,
      columns,
      pageSize,
      margins,
      pageGap,
      zoom,
      syncCoordinator,
      headerContent,
      footerContent,
      firstPageHeaderContent,
      firstPageFooterContent,
      _theme,
      sectionProperties,
      document,
      defaultTabStop,
      styles,
    ],
  );
  const runLayoutPipelineRef = useRef(runLayoutPipeline);
  runLayoutPipelineRef.current = runLayoutPipeline;

  // =========================================================================
  // Coalesced Layout (rAF throttle)
  // =========================================================================

  /**
   * Ref holding the latest pending transaction layout request. Rapid typing
   * updates this request in place so only the final state in the short
   * coalescing window triggers an interactive layout pass.
   */
  const pendingLayoutRef = useRef<PendingLayoutRequest | null>(null);
  const documentChangeNotifyTimerRef = useRef<number | null>(null);

  const flushDocumentChangeNotification = useCallback(() => {
    if (documentChangeNotifyTimerRef.current !== null) {
      window.clearTimeout(documentChangeNotifyTimerRef.current);
      documentChangeNotifyTimerRef.current = null;
    }

    const newDoc = hiddenPMRef.current?.getDocument();
    if (newDoc) {
      onDocumentChangeRef.current?.(newDoc);
    }
  }, []);

  const scheduleDocumentChangeNotification = useCallback(() => {
    if (documentChangeNotifyTimerRef.current !== null) {
      window.clearTimeout(documentChangeNotifyTimerRef.current);
    }

    documentChangeNotifyTimerRef.current = window.setTimeout(() => {
      documentChangeNotifyTimerRef.current = null;
      flushDocumentChangeNotification();
    }, DOCUMENT_CHANGE_NOTIFY_DELAY);
  }, [flushDocumentChangeNotification]);

  const flushPendingLayout = useCallback(() => {
    const pending = pendingLayoutRef.current;
    if (!pending || pending.rafId !== null) {
      return;
    }

    pending.timerId = null;
    pending.rafId = requestAnimationFrame(() => {
      const latest = pendingLayoutRef.current;
      pendingLayoutRef.current = null;
      if (!latest) {
        return;
      }

      const layoutOptions: {
        dirtyRange?: DirtyRange;
        forceFull?: boolean;
        reason: LayoutRunReason;
      } = { reason: "transaction" };
      if (latest.dirtyRange) {
        layoutOptions.dirtyRange = latest.dirtyRange;
      }
      runLayoutPipeline(latest.state, layoutOptions);
    });
  }, [runLayoutPipeline]);

  const armPendingLayoutTimer = useCallback(
    (pending: PendingLayoutRequest) => {
      if (pending.rafId !== null) {
        return;
      }
      if (pending.timerId !== null) {
        window.clearTimeout(pending.timerId);
      }

      const elapsedMs = performance.now() - pending.firstScheduledAt;
      const delayMs =
        elapsedMs >= TRANSACTION_LAYOUT_MAX_DELAY_MS
          ? 0
          : Math.min(
              TRANSACTION_LAYOUT_DEBOUNCE_MS,
              TRANSACTION_LAYOUT_MAX_DELAY_MS - elapsedMs,
            );

      pending.timerId = window.setTimeout(flushPendingLayout, delayMs);
    },
    [flushPendingLayout],
  );

  /**
   * Schedule a layout pipeline run after a short coalescing window.
   * If more transactions arrive before the timer fires, the pending state
   * is replaced so rapid typing paints once for the burst while still
   * enforcing a max latency from the first edit.
   */
  const scheduleLayout = useCallback(
    (state: EditorState, dirtyRange: DirtyRange | null) => {
      const pending = pendingLayoutRef.current;
      if (pending) {
        pending.state = state;
        pending.dirtyRange = mergeDirtyRanges(pending.dirtyRange, dirtyRange);
        armPendingLayoutTimer(pending);
        return;
      }

      const nextPending: PendingLayoutRequest = {
        dirtyRange,
        firstScheduledAt: performance.now(),
        rafId: null,
        state,
        timerId: null,
      };
      pendingLayoutRef.current = nextPending;
      armPendingLayoutTimer(nextPending);
    },
    [armPendingLayoutTimer],
  );

  // Clean up pending rAF on unmount
  useEffect(
    () => () => {
      if (pendingLayoutRef.current) {
        if (pendingLayoutRef.current.timerId !== null) {
          window.clearTimeout(pendingLayoutRef.current.timerId);
        }
        if (pendingLayoutRef.current.rafId !== null) {
          cancelAnimationFrame(pendingLayoutRef.current.rafId);
        }
        pendingLayoutRef.current = null;
      }
      if (documentChangeNotifyTimerRef.current !== null) {
        window.clearTimeout(documentChangeNotifyTimerRef.current);
        documentChangeNotifyTimerRef.current = null;
      }
    },
    [],
  );

  /**
   * Get caret position using DOM-based measurement.
   * This uses the browser's text rendering to get precise pixel positions.
   */
  const getCaretFromDom = useCallback(
    (pmPos: number, currentZoom: number = 1): CaretPosition | null => {
      if (!pagesContainerRef.current) {
        return null;
      }

      const overlay = pagesContainerRef.current.parentElement?.querySelector(
        '[data-testid="selection-overlay"]',
      );
      if (!overlay) {
        return null;
      }

      const overlayRect = overlay.getBoundingClientRect();

      // Find spans with PM position data
      const spans = findBodyPmSpans(pagesContainerRef.current);

      for (const spanEl of spans) {
        const pmStart = Number(spanEl.dataset["pmStart"]);
        const pmEnd = Number(spanEl.dataset["pmEnd"]);

        // Special handling for tab spans - use exclusive end to avoid boundary conflicts
        // Tab at [5,6) means position 6 belongs to the next run, not the tab
        if (spanEl.classList.contains("layout-run-tab")) {
          if (pmPos >= pmStart && pmPos < pmEnd) {
            const spanRect = spanEl.getBoundingClientRect();
            return {
              x: (spanRect.left - overlayRect.left) / currentZoom,
              y: (spanRect.top - overlayRect.top) / currentZoom,
              height: getLineHeight(spanEl),
              pageIndex: getPageIndex(spanEl),
            };
          }
          continue; // Skip to next span
        }

        if (
          spanEl.classList.contains("layout-empty-run") &&
          pmPos >= pmStart &&
          pmPos <= pmEnd
        ) {
          const spanRect = spanEl.getBoundingClientRect();
          return {
            x: (spanRect.left - overlayRect.left) / currentZoom,
            y: (spanRect.top - overlayRect.top) / currentZoom,
            height: getLineHeight(spanEl, Math.max(16, spanRect.height)),
            pageIndex: getPageIndex(spanEl),
          };
        }

        // For text runs, use inclusive range
        if (
          pmPos >= pmStart &&
          pmPos <= pmEnd &&
          spanEl.firstChild?.nodeType === Node.TEXT_NODE
        ) {
          const textNode = spanEl.firstChild as Text;
          const charIndex = Math.min(pmPos - pmStart, textNode.length);

          // Create a range at the exact character position
          const ownerDoc = spanEl.ownerDocument;
          const range = ownerDoc.createRange();
          range.setStart(textNode, charIndex);
          range.setEnd(textNode, charIndex);

          const rangeRect = range.getBoundingClientRect();
          const spanRect = spanEl.getBoundingClientRect();
          const useSpanStart =
            charIndex === 0 ||
            (rangeRect.width === 0 && rangeRect.left < spanRect.left);
          const caretLeft = useSpanStart ? spanRect.left : rangeRect.left;
          const caretTop =
            rangeRect.height > 0 && !useSpanStart
              ? rangeRect.top
              : spanRect.top;

          return {
            x: (caretLeft - overlayRect.left) / currentZoom,
            y: (caretTop - overlayRect.top) / currentZoom,
            height: getLineHeight(spanEl),
            pageIndex: getPageIndex(spanEl),
          };
        }

        if (pmPos >= pmStart && pmPos <= pmEnd) {
          const spanRect = spanEl.getBoundingClientRect();
          return {
            x: (spanRect.left - overlayRect.left) / currentZoom,
            y: (spanRect.top - overlayRect.top) / currentZoom,
            height: getLineHeight(spanEl, Math.max(16, spanRect.height)),
            pageIndex: getPageIndex(spanEl),
          };
        }
      }

      // Fallback: try to find position in empty paragraphs (they have empty runs)
      const emptyRuns = findBodyEmptyRuns(pagesContainerRef.current);
      for (const emptyRun of emptyRuns) {
        const paragraph = closestHtmlElement(emptyRun, ".layout-paragraph");
        if (!paragraph) {
          continue;
        }
        const pmStart = Number(paragraph.dataset["pmStart"]);
        const pmEnd = Number(paragraph.dataset["pmEnd"]);

        if (pmPos >= pmStart && pmPos <= pmEnd) {
          const runRect = emptyRun.getBoundingClientRect();
          return {
            x: (runRect.left - overlayRect.left) / currentZoom,
            y: (runRect.top - overlayRect.top) / currentZoom,
            height: getLineHeight(emptyRun),
            pageIndex: getPageIndex(paragraph),
          };
        }
      }

      return null;
    },
    [],
  );

  /**
   * Update selection overlay from PM selection.
   */
  const updateSelectionOverlay = useCallback(
    (state: EditorState) => {
      const { from, to } = state.selection;
      const requestSeq = selectionOverlayRequestSeqRef.current + 1;
      selectionOverlayRequestSeqRef.current = requestSeq;
      const isCurrentRequest = () =>
        selectionOverlayRequestSeqRef.current === requestSeq;

      // Always notify selection change (for toolbar sync) even if layout not ready
      // Use ref to avoid infinite loops when callback is unstable
      onSelectionChangeRef.current?.(from, to);
      // `onSelectionTextChange` carries the resolved text
      // alongside the range so consumers (anonymisation
      // term prefill, etc.) don't need to hold a reference
      // to the editor view themselves. `textBetween` with
      // a single space for both leaf-block and block
      // separators collapses table cells, paragraphs, and
      // inline atoms into a single-line phrase.
      if (onSelectionTextChangeRef.current) {
        const text =
          from === to ? "" : state.doc.textBetween(from, to, " ", " ");
        onSelectionTextChangeRef.current({ from, to, text });
      }

      if (suppressSelectionOverlayRef.current) {
        setCaretPosition(null);
        setSelectionRects([]);
        return;
      }

      // Update visual cell selection highlighting on visible layout table cells
      if (pagesContainerRef.current) {
        // Clear previous cell highlighting
        const prevSelected = pagesContainerRef.current.querySelectorAll(
          ".layout-table-cell-selected",
        );
        for (const el of Array.from(prevSelected)) {
          el.classList.remove("layout-table-cell-selected");
        }

        // If CellSelection, highlight the corresponding visible cells
        // Use duck-typing ($anchorCell) instead of instanceof to avoid bundling issues
        const sel = state.selection as CellSelection;
        const isCellSel =
          "$anchorCell" in sel && typeof sel.forEachCell === "function";
        if (isCellSel) {
          // Collect ranges [cellStart, cellEnd) for each selected cell
          const selectedRanges: [number, number][] = [];
          sel.forEachCell((node, pos) => {
            selectedRanges.push([pos, pos + node.nodeSize]);
          });

          // Find visible layout cells whose pmStart falls inside a selected cell range
          const allCells = htmlQueryAll(
            pagesContainerRef.current,
            ".layout-table-cell",
          );
          for (const cellEl of allCells) {
            const pmStartAttr = cellEl.dataset["pmStart"];
            if (pmStartAttr !== undefined) {
              const pmPos = Number(pmStartAttr);
              for (const [start, end] of selectedRanges) {
                if (pmPos >= start && pmPos < end) {
                  cellEl.classList.add("layout-table-cell-selected");
                  break;
                }
              }
            }
          }
        }
      }

      if (!layout || blocks.length === 0) {
        return;
      }

      // Collapsed selection - show caret
      if (from === to) {
        // Use DOM-based caret positioning for accuracy
        const domCaret = getCaretFromDom(from, zoom);
        if (domCaret) {
          setCaretPosition(domCaret);
        } else {
          // Fallback to layout-based calculation if DOM not ready
          const overlay =
            pagesContainerRef.current?.parentElement?.querySelector(
              '[data-testid="selection-overlay"]',
            );
          const firstPage =
            pagesContainerRef.current?.querySelector(".layout-page");

          if (overlay && firstPage) {
            const overlayRect = overlay.getBoundingClientRect();
            const pageRect = firstPage.getBoundingClientRect();
            setCaretPosition(null);
            void loadSelectionGeometry().then(
              ({ getCaretPosition }) => {
                if (!isCurrentRequest()) {
                  return undefined;
                }

                const caret = getCaretPosition(layout, blocks, measures, from);
                if (caret) {
                  setCaretPosition({
                    ...caret,
                    x: caret.x + (pageRect.left - overlayRect.left) / zoom,
                    y: caret.y + (pageRect.top - overlayRect.top) / zoom,
                  });
                } else {
                  setCaretPosition(null);
                }
                return undefined;
              },
              () => {
                if (isCurrentRequest()) {
                  setCaretPosition(null);
                }
                return undefined;
              },
            );
          } else {
            setCaretPosition(null);
          }
        }
        setSelectionRects([]);
      } else {
        // Range selection - show highlight rectangles using DOM-based approach
        const overlay = pagesContainerRef.current?.parentElement?.querySelector(
          '[data-testid="selection-overlay"]',
        );

        if (overlay && pagesContainerRef.current) {
          const overlayRect = overlay.getBoundingClientRect();
          const domRects: SelectionRect[] = [];

          // Find spans that intersect with the selection range
          const spans = findBodyPmSpans(pagesContainerRef.current);

          for (const spanEl of spans) {
            const pmStart = Number(spanEl.dataset["pmStart"]);
            const pmEnd = Number(spanEl.dataset["pmEnd"]);

            // Check if this span overlaps with selection
            if (pmEnd > from && pmStart < to) {
              // Special handling for tab spans - highlight the full visual width
              if (spanEl.classList.contains("layout-run-tab")) {
                const spanRect = spanEl.getBoundingClientRect();
                domRects.push({
                  x: (spanRect.left - overlayRect.left) / zoom,
                  y: (spanRect.top - overlayRect.top) / zoom,
                  width: spanRect.width / zoom,
                  height: spanRect.height / zoom,
                  pageIndex: getPageIndex(spanEl),
                });
                continue;
              }

              // Find the text node — may be a direct child or inside an <a> for hyperlinks
              let textNode: Text | null = null;
              if (spanEl.firstChild?.nodeType === Node.TEXT_NODE) {
                textNode = spanEl.firstChild as Text;
              } else if (
                spanEl.firstChild instanceof HTMLElement &&
                spanEl.firstChild.tagName === "A" &&
                spanEl.firstChild.firstChild?.nodeType === Node.TEXT_NODE
              ) {
                textNode = spanEl.firstChild.firstChild as Text;
              }
              if (!textNode) {
                continue;
              }
              const ownerDoc = spanEl.ownerDocument;

              // Calculate the character range within this span
              const startChar = Math.max(0, from - pmStart);
              const endChar = Math.min(textNode.length, to - pmStart);

              if (startChar < endChar) {
                const range = ownerDoc.createRange();
                range.setStart(textNode, startChar);
                range.setEnd(textNode, endChar);

                // Get all client rects for this range (handles line wraps)
                const clientRects = range.getClientRects();
                const pageIndex = getPageIndex(spanEl);
                for (const rect of Array.from(clientRects)) {
                  domRects.push({
                    x: (rect.left - overlayRect.left) / zoom,
                    y: (rect.top - overlayRect.top) / zoom,
                    width: rect.width / zoom,
                    height: rect.height / zoom,
                    pageIndex,
                  });
                }
              }
            }
          }

          if (domRects.length > 0) {
            setSelectionRects(domRects);
          } else {
            // Fallback to layout-based calculation
            const firstPage =
              pagesContainerRef.current.querySelector(".layout-page");
            if (firstPage) {
              const pageRect = firstPage.getBoundingClientRect();
              const pageOffsetX = (pageRect.left - overlayRect.left) / zoom;
              const pageOffsetY = (pageRect.top - overlayRect.top) / zoom;
              setSelectionRects([]);
              void loadSelectionGeometry().then(
                ({ selectionToRects }) => {
                  if (!isCurrentRequest()) {
                    return undefined;
                  }

                  const rects = selectionToRects(
                    layout,
                    blocks,
                    measures,
                    from,
                    to,
                  );
                  const adjustedRects = rects.map((rect) => ({
                    height: rect.height,
                    pageIndex: rect.pageIndex,
                    width: rect.width,
                    x: rect.x + pageOffsetX,
                    y: rect.y + pageOffsetY,
                  }));
                  setSelectionRects(adjustedRects);
                  return undefined;
                },
                () => {
                  if (isCurrentRequest()) {
                    setSelectionRects([]);
                  }
                  return undefined;
                },
              );
            } else {
              setSelectionRects([]);
            }
          }
        } else {
          setSelectionRects([]);
        }
        setCaretPosition(null);
      }
    },
    [layout, blocks, measures, getCaretFromDom, zoom],
    // NOTE: onSelectionChange removed from dependencies - accessed via ref to prevent infinite loops
  );
  const updateSelectionOverlayRef = useRef(updateSelectionOverlay);
  updateSelectionOverlayRef.current = updateSelectionOverlay;

  // Project anonymization match ranges onto container-space
  // rectangles. Mirrors the SelectionOverlay flow: prefer real
  // DOM rects from the painted page spans (correct for indents,
  // tabs, justified text, line wraps) and fall back to the
  // layout-coord projection only when the DOM spans aren't
  // mounted yet (initial paint, off-screen pages). The hidden
  // ProseMirror's spans are not used — they sit at -9999px and
  // would yield bogus coordinates.
  const updateAnonymizationOverlay = useCallback(() => {
    const requestSeq = anonymizationOverlayRequestSeqRef.current + 1;
    anonymizationOverlayRequestSeqRef.current = requestSeq;
    const isCurrentRequest = () =>
      anonymizationOverlayRequestSeqRef.current === requestSeq;
    const matches = anonymizationMatchesRef.current;
    if (matches.length === 0) {
      setAnonymizationRectGroups([]);
      return;
    }
    const pagesContainer = pagesContainerRef.current;
    if (!pagesContainer) {
      setAnonymizationRectGroups([]);
      return;
    }
    const overlay = pagesContainer.parentElement?.querySelector(
      '[data-testid="selection-overlay"]',
    );
    const firstPage = pagesContainer.querySelector(".layout-page");
    if (!overlay || !firstPage) {
      setAnonymizationRectGroups([]);
      return;
    }
    const overlayRect = overlay.getBoundingClientRect();
    const pageRect = firstPage.getBoundingClientRect();
    const pageOffsetX = (pageRect.left - overlayRect.left) / zoom;
    const pageOffsetY = (pageRect.top - overlayRect.top) / zoom;
    const pmSpans = findBodyPmSpans(pagesContainer);
    const layoutFallbackMatches: AnonymizationMatch[] = [];

    const rectsForMatch = (
      match: AnonymizationMatch,
      from: number,
      to: number,
    ): AnonymizationRectGroup["rects"] => {
      const domRects: AnonymizationRectGroup["rects"] = [];
      for (const spanEl of pmSpans) {
        const pmStart = Number(spanEl.dataset["pmStart"]);
        const pmEnd = Number(spanEl.dataset["pmEnd"]);
        if (!(pmEnd > from && pmStart < to)) {
          continue;
        }
        if (spanEl.classList.contains("layout-run-tab")) {
          const spanRect = spanEl.getBoundingClientRect();
          domRects.push({
            x: (spanRect.left - overlayRect.left) / zoom,
            y: (spanRect.top - overlayRect.top) / zoom,
            width: spanRect.width / zoom,
            height: spanRect.height / zoom,
            pageIndex: getPageIndex(spanEl),
          });
          continue;
        }
        let textNode: Text | null = null;
        if (spanEl.firstChild?.nodeType === Node.TEXT_NODE) {
          textNode = spanEl.firstChild as Text;
        } else if (
          spanEl.firstChild instanceof HTMLElement &&
          spanEl.firstChild.tagName === "A" &&
          spanEl.firstChild.firstChild?.nodeType === Node.TEXT_NODE
        ) {
          textNode = spanEl.firstChild.firstChild as Text;
        }
        if (!textNode) {
          continue;
        }
        const ownerDoc = spanEl.ownerDocument;
        const startChar = Math.max(0, from - pmStart);
        const endChar = Math.min(textNode.length, to - pmStart);
        if (startChar >= endChar) {
          continue;
        }
        const range = ownerDoc.createRange();
        range.setStart(textNode, startChar);
        range.setEnd(textNode, endChar);
        const pageIndex = getPageIndex(spanEl);
        for (const rect of Array.from(range.getClientRects())) {
          domRects.push({
            x: (rect.left - overlayRect.left) / zoom,
            y: (rect.top - overlayRect.top) / zoom,
            width: rect.width / zoom,
            height: rect.height / zoom,
            pageIndex,
          });
        }
      }
      if (domRects.length > 0) {
        return domRects;
      }
      if (!layout || blocks.length === 0) {
        return [];
      }
      layoutFallbackMatches.push(match);
      return [];
    };

    const groups: AnonymizationRectGroup[] = [];
    for (const match of matches) {
      const rects = rectsForMatch(match, match.from, match.to);
      if (rects.length > 0) {
        groups.push({
          rects,
          label: match.label,
          canonical: match.canonical,
        });
      }
    }
    setAnonymizationRectGroups(groups);

    if (layoutFallbackMatches.length === 0 || !layout || blocks.length === 0) {
      return;
    }

    void loadSelectionGeometry().then(
      ({ selectionToRects }) => {
        if (!isCurrentRequest()) {
          return undefined;
        }

        const fallbackGroups: AnonymizationRectGroup[] = [];
        for (const match of layoutFallbackMatches) {
          const rects = selectionToRects(
            layout,
            blocks,
            measures,
            match.from,
            match.to,
          ).map((rect) => ({
            height: rect.height,
            pageIndex: rect.pageIndex,
            width: rect.width,
            x: rect.x + pageOffsetX,
            y: rect.y + pageOffsetY,
          }));
          if (rects.length > 0) {
            fallbackGroups.push({
              rects,
              label: match.label,
              canonical: match.canonical,
            });
          }
        }

        if (fallbackGroups.length > 0 && isCurrentRequest()) {
          setAnonymizationRectGroups([...groups, ...fallbackGroups]);
        }
        return undefined;
      },
      () => undefined,
    );
  }, [layout, blocks, measures, zoom]);

  const hideSelectionOverlayDuringInput = useCallback(
    (state: EditorState) => {
      selectionOverlayRequestSeqRef.current += 1;
      suppressSelectionOverlayRef.current = true;
      setCaretPosition(null);
      setSelectionRects([]);

      if (revealSelectionOverlayTimerRef.current !== null) {
        window.clearTimeout(revealSelectionOverlayTimerRef.current);
      }

      revealSelectionOverlayTimerRef.current = window.setTimeout(() => {
        revealSelectionOverlayTimerRef.current = null;
        suppressSelectionOverlayRef.current = false;
        updateSelectionOverlay(hiddenPMRef.current?.getState() ?? state);
      }, SELECTION_REVEAL_AFTER_INPUT_DELAY);
    },
    [updateSelectionOverlay],
  );

  useEffect(
    () => () => {
      if (revealSelectionOverlayTimerRef.current !== null) {
        window.clearTimeout(revealSelectionOverlayTimerRef.current);
        revealSelectionOverlayTimerRef.current = null;
      }
    },
    [],
  );

  // =========================================================================
  // Event Handlers
  // =========================================================================

  /**
   * Handle PM transaction - re-layout on content/selection change.
   */
  const handleTransaction = useCallback(
    (transaction: Transaction, newState: EditorState) => {
      // Keep the anonymization match list mirrored in a ref so the
      // overlay recompute reads the latest set without depending on
      // a state setter inside its useCallback closure. We pull off
      // the plugin's state on every transaction; if the matches
      // identity changes (term meta or doc edit), schedule a paint.
      const nextMatches =
        anonymizationDecorationsKey.getState(newState)?.matches ?? [];
      const matchesChanged = nextMatches !== anonymizationMatchesRef.current;
      anonymizationMatchesRef.current = nextMatches;
      if (matchesChanged) {
        updateAnonymizationOverlay();
      }

      if (transaction.docChanged) {
        // Increment state sequence to signal document changed
        syncCoordinator.incrementStateSeq();

        hideSelectionOverlayDuringInput(newState);

        // Content changed - schedule layout (coalesced via rAF)
        scheduleLayout(newState, getTransactionDirtyRange(transaction));

        // Convert back to the Folio document model off the keypress path.
        scheduleDocumentChangeNotification();
      }

      // Request selection update (will only execute when layout is current)
      syncCoordinator.requestRender();

      // Only update selection overlay immediately for non-doc-changing transactions
      // (e.g. arrow keys, clicks). For doc changes, the overlay will be updated
      // after layout completes via the useEffect([layout]) hook, avoiding cursor
      // flicker from stale DOM positions.
      if (!transaction.docChanged) {
        updateSelectionOverlay(newState);
      }
    },
    [
      scheduleLayout,
      scheduleDocumentChangeNotification,
      hideSelectionOverlayDuringInput,
      updateSelectionOverlay,
      updateAnonymizationOverlay,
      syncCoordinator,
    ],
    // NOTE: onDocumentChange removed from dependencies - accessed via ref to prevent infinite loops
  );

  /**
   * Handle a transaction on a persistent hidden HF EditorView.
   *
   * Two responsibilities:
   *   1. Mirror the PM doc back into `Document.package.headers/footers[rId].content`
   *      so the existing save path (which reads `hf.content`) ships the latest
   *      HF content. Mutating in place matches upstream's pattern and avoids
   *      churning history on every keystroke (the persistent PM is the
   *      source of truth while loaded — same model the body PM uses).
   *   2. Re-run the layout pipeline so the painter repaints with the new
   *      HF blocks. We reuse the body PM's current state as the layout
   *      input because `scheduleLayout` derives body blocks from that
   *      state; the HF blocks are pulled from the HF PM via
   *      `renderHfFromContentOrPm` on the next layout tick.
   */
  const [hfCaretSelection, setHfCaretSelection] = useState<{
    rId: string;
    kind: "header" | "footer";
    from: number;
    to: number;
  } | null>(null);

  const handleHfPmTransaction = useCallback(
    (
      rId: string,
      kind: "header" | "footer",
      view: EditorView,
      docChanged: boolean,
      selectionChanged: boolean,
    ) => {
      if (docChanged) {
        const pkg = document?.package;
        if (pkg) {
          const hf = pkg.headers?.get(rId) ?? pkg.footers?.get(rId);
          if (hf) {
            hf.content = proseDocToBlocks(view.state.doc);
          }
        }
        const bodyState = hiddenPMRef.current?.getState();
        if (bodyState) {
          scheduleLayout(bodyState, null);
        }
      }
      if (docChanged || selectionChanged) {
        const { from, to } = view.state.selection;
        setHfCaretSelection({ rId, kind, from, to });
      }
    },
    [document, scheduleLayout],
  );

  // Clear HF caret state on exit from HF edit mode.
  useEffect(() => {
    if (!hfEditMode) {
      setHfCaretSelection(null);
    }
  }, [hfEditMode]);

  /**
   * Handle selection change from PM.
   */
  const handleSelectionChange = useCallback(
    (state: EditorState) => {
      // Check if this is an image node selection - suppress text overlay if so
      const { selection } = state;
      if (
        selection instanceof NodeSelection &&
        selection.node.type.name === "image"
      ) {
        // Suppress text selection overlay for image selections
        setSelectionRects([]);
        setCaretPosition(null);
      } else if (syncCoordinator.isSafeToRender()) {
        // Only update overlay when layout is current. When doc changed,
        // layout is pending and DOM hasn't been updated yet — updating the
        // overlay now would position the cursor against stale geometry,
        // causing it to visibly jump. The overlay will be updated after
        // layout completes via the useEffect([layout]) hook.
        updateSelectionOverlay(state);
      }

      // Defer image selection check until after layout update
      requestAnimationFrame(() => {
        const view = hiddenPMRef.current?.getView();
        if (!view) {
          setSelectedImageInfo(null);
          return;
        }
        const { selection: sel } = view.state;
        if (sel instanceof NodeSelection && sel.node.type.name === "image") {
          const pmPos = sel.from;
          const imgEl = pagesContainerRef.current
            ? findBodyPmAnchor(pagesContainerRef.current, pmPos)
            : null;
          if (imgEl) {
            setSelectedImageInfo(buildImageSelectionInfo(imgEl, pmPos));
            return;
          }
        }
        if (!isImageInteractingRef.current) {
          setSelectedImageInfo(null);
        }
      });
    },
    [updateSelectionOverlay, buildImageSelectionInfo, syncCoordinator],
  );

  /**
   * Get PM position from mouse coordinates using DOM-based detection.
   * Falls back to geometry-based calculation if DOM mapping fails.
   */
  const getPositionFromMouse = useCallback(
    (clientX: number, clientY: number): number | null => {
      if (!pagesContainerRef.current || !layout) {
        return null;
      }

      // Try DOM-based click mapping first (most accurate)
      const domPos = clickToPositionDom(
        pagesContainerRef.current,
        clientX,
        clientY,
        zoom,
      );
      if (domPos !== null) {
        return domPos;
      }

      // Fallback to geometry-based mapping
      const pageElements =
        pagesContainerRef.current.querySelectorAll(".layout-page");
      let clickedPageIndex = -1;
      let pageRect: DOMRect | null = null;

      for (let i = 0; i < pageElements.length; i++) {
        const pageEl = pageElements[i]!; // SAFETY: i < pageElements.length
        const rect = pageEl.getBoundingClientRect();
        if (
          clientX >= rect.left &&
          clientX <= rect.right &&
          clientY >= rect.top &&
          clientY <= rect.bottom
        ) {
          clickedPageIndex = i;
          pageRect = rect;
          break;
        }
      }

      if (clickedPageIndex < 0 || !pageRect) {
        return null;
      }

      const pageX = (clientX - pageRect.left) / zoom;
      const pageY = (clientY - pageRect.top) / zoom;

      const page = layout.pages[clickedPageIndex];
      if (!page) {
        return null;
      }

      const pageHit = {
        pageIndex: clickedPageIndex,
        page,
        pageY,
      };

      const fragmentHit = hitTestFragment(pageHit, blocks, measures, {
        x: pageX,
        y: pageY,
      });

      if (!fragmentHit) {
        return null;
      }

      // For table fragments, do cell-level hit testing
      if (fragmentHit.fragment.kind === "table") {
        const tableCellHit = hitTestTableCell(pageHit, blocks, measures, {
          x: pageX,
          y: pageY,
        });
        return clickToPosition(fragmentHit, tableCellHit);
      }

      return clickToPosition(fragmentHit);
    },
    [layout, blocks, measures, zoom],
  );

  /**
   * Find the table cell position in ProseMirror doc for a given PM position.
   * Returns the position just inside the cell node, suitable for CellSelection.create().
   */
  const findCellPosInDoc = useCallback(
    (doc: PMNode, pmPos: number): number | null => {
      try {
        const $pos = doc.resolve(pmPos);
        for (let d = $pos.depth; d > 0; d--) {
          const node = $pos.node(d);
          if (
            node.type.name === "tableCell" ||
            node.type.name === "tableHeader"
          ) {
            return $pos.before(d);
          }
        }
      } catch {
        // Position resolution failed
      }
      return null;
    },
    [],
  );

  const findCellPosFromPmPos = useCallback(
    (pmPos: number): number | null => {
      const view = hiddenPMRef.current?.getView();
      if (!view) {
        return null;
      }
      return findCellPosInDoc(view.state.doc, pmPos);
    },
    [findCellPosInDoc],
  );

  /**
   * Find the closest image element from a click target.
   * Returns the element with data-pm-start if it's an image, or null.
   */
  const findImageElement = useCallback(
    (target: HTMLElement): HTMLElement | null => {
      const IMAGE_CONTAINER_CLASSES = [
        "layout-block-image",
        "layout-image",
        "layout-page-floating-image",
      ];
      const isImageContainer = (el: HTMLElement) =>
        !!el.dataset["pmStart"] &&
        IMAGE_CONTAINER_CLASSES.some((c) => el.classList.contains(c));

      // Inline images: <img class="layout-run layout-run-image" data-pm-start="X">
      if (
        target.tagName === "IMG" &&
        target.classList.contains("layout-run-image")
      ) {
        return target;
      }
      // Click on <img> inside a container div, or directly on the container
      if (
        target.tagName === "IMG" &&
        target.parentElement &&
        isImageContainer(target.parentElement)
      ) {
        return target.parentElement;
      }
      if (isImageContainer(target)) {
        return target;
      }
      return null;
    },
    [],
  );

  /** Scroll visible pages to a ProseMirror position. */
  const scrollToPositionImpl = useCallback((pmPos: number) => {
    if (!isValidPmScrollPosition(pmPos)) {
      return;
    }

    const pageContainer = pagesContainerRef.current;
    if (!pageContainer) {
      return;
    }
    // Phase 1: locate the target via per-run DOM if it's already
    // rendered, otherwise via the page shell (always present
    // under virtualization). The shell-based path was added to
    // fix the "many clicks to arrive" bug — a per-run query on a
    // virtualized doc only sees runs in the currently-rendered
    // buffer, so each click stepped one buffer-width forward
    // instead of jumping straight to the target.
    const exact = findBodyPmAnchor(pageContainer, pmPos);
    if (exact) {
      exact.scrollIntoView({
        behavior: prefersReducedMotionBehavior(),
        block: "center",
      });
      return;
    }

    // Walk all currently-rendered runs to see if pmPos falls
    // inside one of them (block-node positions never match
    // exactly but usually live inside a known run).
    let runMatch: HTMLElement | null = null;
    for (const el of findBodyPmAnchors(pageContainer)) {
      const start = Number(el.dataset["pmStart"]);
      if (Number.isNaN(start)) {
        continue;
      }
      const endAttr = el.dataset["pmEnd"];
      const end = endAttr === undefined ? start : Number(endAttr);
      if (start <= pmPos && pmPos <= end) {
        runMatch = el;
        break;
      }
    }
    if (runMatch) {
      runMatch.scrollIntoView({
        behavior: prefersReducedMotionBehavior(),
        block: "center",
      });
      return;
    }

    // Target lives outside the rendered buffer. Scroll to its
    // page shell (which exists with correct dimensions even when
    // empty), then refine to the exact run once the
    // IntersectionObserver populates the page content.
    //
    // TODO: when the AI review session opens, pre-warm the page
    // shells that contain pending suggestions (one-shot
    // populate of ~30 pages instead of 200). Lets this scroll
    // become single-phase again — no rAF refine — and makes
    // navigation feel instant for long documents.
    const shellHit = findPageShellForPmPos(pageContainer, pmPos);
    if (!shellHit) {
      return;
    }
    const { element: shell } = shellHit;
    shell.scrollIntoView({
      behavior: prefersReducedMotionBehavior(),
      block: "center",
    });

    let attempts = 0;
    const refine = () => {
      attempts++;
      const exactInShell = findBodyPmAnchor(shell, pmPos);
      if (exactInShell) {
        exactInShell.scrollIntoView({
          behavior: prefersReducedMotionBehavior(),
          block: "center",
        });
        return;
      }
      let bestEl: HTMLElement | null = null;
      let bestStart = Number.NEGATIVE_INFINITY;
      for (const el of findBodyPmAnchors(shell)) {
        const start = Number(el.dataset["pmStart"]);
        if (Number.isNaN(start)) {
          continue;
        }
        const endAttr = el.dataset["pmEnd"];
        const end = endAttr === undefined ? start : Number(endAttr);
        if (start <= pmPos && pmPos <= end) {
          bestEl = el;
          break;
        }
        if (start <= pmPos && start > bestStart) {
          bestStart = start;
          bestEl = el;
        }
      }
      if (bestEl) {
        bestEl.scrollIntoView({
          behavior: prefersReducedMotionBehavior(),
          block: "center",
        });
        return;
      }
      // IntersectionObserver populates on the next tick; give it
      // a few frames before giving up. ~20 frames covers slow
      // initial paint on long pages without spinning indefinitely
      // if the page genuinely has no run at this position.
      if (attempts < 20) {
        requestAnimationFrame(refine);
      }
    };
    requestAnimationFrame(refine);
  }, []);

  const scrollToPageImpl = useCallback(
    (pageNumber: number) => {
      const target = getPageScrollTarget(layout, pageNumber);
      if (!target) {
        return;
      }

      if (target.type === "position") {
        scrollToPositionImpl(target.pmPos);
        return;
      }

      const pageContainer = pagesContainerRef.current;
      const shell = pageContainer?.querySelector<HTMLElement>(
        `[data-page-number="${String(target.pageIndex + 1)}"]`,
      );
      shell?.scrollIntoView({ block: "center", inline: "nearest" });
    },
    [layout, scrollToPositionImpl],
  );

  const focusHiddenEditor = useCallback(() => {
    if (readOnly) {
      containerRef.current?.focus({ preventScroll: true });
      setIsFocused(true);
      return;
    }

    if (!hiddenPMRef.current?.getView()) {
      ensureHiddenEditorView();
    }
    hiddenPMRef.current?.focus();
    setIsFocused(true);
  }, [ensureHiddenEditorView, readOnly]);

  const startPointerTextSelection = useCallback(
    (clientX: number, clientY: number) => {
      const pmPos = getPositionFromMouse(clientX, clientY);

      if (pmPos !== null) {
        const cellPos = findCellPosFromPmPos(pmPos);
        cellDragAnchorPosRef.current = cellPos;
        isCellDraggingRef.current = false;
        cellDragLastPmPosRef.current = null;
        cellDragOverflowXRef.current = null;

        isDraggingRef.current = true;
        dragAnchorRef.current = pmPos;
        if (hiddenPMRef.current?.getView()) {
          hiddenPMRef.current.setSelection(pmPos);
        } else {
          queueHiddenEditorSelection({ type: "text", anchor: pmPos });
        }
      } else {
        cellDragAnchorPosRef.current = null;
        isCellDraggingRef.current = false;
        const view = hiddenPMRef.current?.getView();
        if (view) {
          const endPos = Math.max(0, view.state.doc.content.size - 1);
          hiddenPMRef.current?.setSelection(endPos);
          dragAnchorRef.current = endPos;
          isDraggingRef.current = true;
        } else {
          const docEnd = Math.max(
            0,
            (precomputedInitialStateRef.current?.doc.content.size ?? 1) - 1,
          );
          queueHiddenEditorSelection({ type: "text", anchor: docEnd });
          dragAnchorRef.current = docEnd;
          isDraggingRef.current = true;
        }
      }

      focusHiddenEditor();
    },
    [
      findCellPosFromPmPos,
      focusHiddenEditor,
      getPositionFromMouse,
      queueHiddenEditorSelection,
    ],
  );

  const copySelectionText = useCallback(() => {
    const view = hiddenPMRef.current?.getView();
    if (!view) {
      return false;
    }

    const { from, to } = view.state.selection;
    if (from === to) {
      return false;
    }

    const text = view.state.doc.textBetween(from, to, "\n");
    if (!text) {
      return false;
    }

    // eslint-disable-next-line typescript/no-unnecessary-condition -- Clipboard API may be unavailable in older browsers or insecure contexts.
    if (navigator.clipboard === undefined) {
      return false;
    }

    void navigator.clipboard.writeText(text).catch(() => undefined);
    return false;
  }, []);

  /**
   * Handle mousedown on pages - start selection or drag.
   */
  const handlePagesMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (!hiddenPMRef.current) {
        return;
      }

      // Right-click: prevent default to stop Firefox from resetting selection,
      // but don't process our selection logic
      if (e.button === 2) {
        e.preventDefault();
        return;
      }

      if (e.button !== 0) {
        return;
      } // Only handle left click

      // Hide table insert button on any mousedown
      setTableInsertButton(null);
      clearTableInsertTimer();

      const target = e.target instanceof HTMLElement ? e.target : null;
      if (!target) {
        return;
      }

      // Prevent default browser navigation for hyperlink clicks,
      // but let the rest of the handler run for cursor placement and drag selection.
      // The popup is shown in handlePagesClick (on mouseup) instead.
      const anchorClosest = target.closest("a[href]");
      const anchorEl =
        anchorClosest instanceof HTMLAnchorElement ? anchorClosest : null;
      if (anchorEl) {
        e.preventDefault(); // Prevent navigation only
      }

      // When in HF edit mode, clicks outside header/footer area close the HF editor
      if (!readOnly && hfEditMode && onBodyClick) {
        const isInHfArea =
          target.closest(".layout-page-header") ||
          target.closest(".layout-page-footer") ||
          target.closest(".hf-inline-editor");
        if (!isInHfArea) {
          e.preventDefault();
          e.stopPropagation();
          onBodyClick();
          return;
        }
      }

      // Resize handles must be intercepted BEFORE the HF text-routing
      // branch — otherwise the table-edge handles painted inside an HF
      // slot would be treated as a regular HF click and the user could
      // never start a resize. The resize blocks below resolve the
      // active surface (body or HF) and read the source columnWidths /
      // row height from the matching PM.
      const isResizeHandleTarget =
        !readOnly &&
        (target.classList.contains("layout-table-resize-handle") ||
          target.classList.contains("layout-table-row-resize-handle") ||
          target.classList.contains("layout-table-edge-handle-bottom") ||
          target.classList.contains("layout-table-edge-handle-right"));
      const resizeHfSlot = isResizeHandleTarget
        ? findHfSlotForTarget(target)
        : null;
      const resizeViewForRead: EditorView | null = resizeHfSlot
        ? (hfPMsRef.current?.getView(resizeHfSlot.rId) ?? null)
        : hiddenPMRef.current.getView();

      // HF edit mode + click inside a painted HF slot → route to the persistent
      // hidden HF EditorView. The painter (not PM) is the visible HF renderer,
      // so we translate the click via clickToPositionDom (which inspects the
      // painted span's data-pm-start/end markers) and dispatch the resulting
      // PM position on the matching hidden view. The drag-extend / shift-click
      // refs are populated here too so subsequent mousemove + handlePagesClick
      // dispatch on the same surface. Cell drag inside an HF table seeds
      // cellDragAnchorPosRef with the HF cell position; the mousemove path
      // dispatches CellSelection on the HF view.
      if (!readOnly && hfEditMode && !isResizeHandleTarget) {
        const slot = findHfSlotForTarget(target);
        if (slot) {
          const hfView = hfPMsRef.current?.getView(slot.rId);
          if (hfView) {
            e.preventDefault();
            const pos = clickToPositionDom(
              pagesContainerRef.current ?? slot.element,
              e.clientX,
              e.clientY,
              zoom,
            );
            if (pos !== null) {
              const docEnd = hfView.state.doc.content.size;
              const clamped = Math.max(0, Math.min(pos, docEnd));
              if (e.shiftKey && dragAnchorRef.current !== null) {
                const $anchor = hfView.state.doc.resolve(
                  Math.max(0, Math.min(dragAnchorRef.current, docEnd)),
                );
                const $head = hfView.state.doc.resolve(clamped);
                hfView.dispatch(
                  hfView.state.tr.setSelection(
                    TextSelection.between($anchor, $head),
                  ),
                );
              } else {
                const $pos = hfView.state.doc.resolve(clamped);
                hfView.dispatch(
                  hfView.state.tr.setSelection(TextSelection.near($pos)),
                );
                dragAnchorRef.current = clamped;
              }
              const cellPos = findCellPosInDoc(hfView.state.doc, clamped);
              cellDragAnchorPosRef.current = cellPos;
              isDraggingRef.current = true;
              activeHfDragSurfaceRef.current = {
                rId: slot.rId,
                kind: slot.kind,
              };
            }
            hfView.focus();
            return;
          }
        }
      }

      // In normal mode, clicks in header/footer area should place cursor at
      // start of body content, not inside header/footer (matches Word/Google Docs)
      if (!readOnly && !hfEditMode) {
        const isInHfArea =
          target.closest(".layout-page-header") ||
          target.closest(".layout-page-footer");
        if (isInHfArea) {
          e.preventDefault();
          // Place cursor at start of body content
          hiddenPMRef.current.setSelection(0);
          hiddenPMRef.current.focus();
          setIsFocused(true);
          return;
        }
      }

      // Column resize: intercept clicks on resize handles
      if (
        !readOnly &&
        target.classList.contains("layout-table-resize-handle")
      ) {
        e.preventDefault();
        e.stopPropagation();
        isResizingColumnRef.current = true;
        resizingHfSurfaceRef.current = resizeHfSlot
          ? { rId: resizeHfSlot.rId, kind: resizeHfSlot.kind }
          : null;
        resizeStartXRef.current = e.clientX;
        resizeHandleRef.current = target;
        target.classList.add("dragging");

        const colIndex = Number.parseInt(
          target.dataset["columnIndex"] ?? "0",
          10,
        );
        resizeColumnIndexRef.current = colIndex;
        resizeTablePmStartRef.current = Number.parseInt(
          target.dataset["tablePmStart"] ?? "0",
          10,
        );

        const view = resizeViewForRead;
        if (view) {
          const $pos = view.state.doc.resolve(
            resizeTablePmStartRef.current + 1,
          );
          for (let d = $pos.depth; d >= 0; d--) {
            const node = $pos.node(d);
            if (node.type.name === "table") {
              const widths = node.attrs["columnWidths"] as number[] | null;
              if (
                widths &&
                widths[colIndex] !== undefined &&
                widths[colIndex + 1] !== undefined
              ) {
                resizeOrigWidthsRef.current = {
                  left: widths[colIndex]!, // SAFETY: guarded by widths[colIndex] !== undefined check above
                  right: widths[colIndex + 1]!, // SAFETY: guarded by widths[colIndex + 1] !== undefined check above
                };
              }
              break;
            }
          }
        }
        return;
      }

      // Row resize: intercept clicks on row resize handles or bottom edge handle
      if (
        !readOnly &&
        (target.classList.contains("layout-table-row-resize-handle") ||
          target.classList.contains("layout-table-edge-handle-bottom"))
      ) {
        e.preventDefault();
        e.stopPropagation();
        isResizingRowRef.current = true;
        resizingHfSurfaceRef.current = resizeHfSlot
          ? { rId: resizeHfSlot.rId, kind: resizeHfSlot.kind }
          : null;
        resizeStartYRef.current = e.clientY;
        resizeRowHandleRef.current = target;
        resizeRowIsEdgeRef.current = target.dataset["isEdge"] === "bottom";
        target.classList.add("dragging");

        const rowIndex = Number.parseInt(target.dataset["rowIndex"] ?? "0", 10);
        resizeRowIndexRef.current = rowIndex;
        resizeRowTablePmStartRef.current = Number.parseInt(
          target.dataset["tablePmStart"] ?? "0",
          10,
        );

        const view = resizeViewForRead;
        if (view) {
          const $pos = view.state.doc.resolve(
            resizeRowTablePmStartRef.current + 1,
          );
          for (let d = $pos.depth; d >= 0; d--) {
            const node = $pos.node(d);
            if (node.type.name === "table") {
              if (rowIndex < node.childCount) {
                const rowNode = node.child(rowIndex);
                const height = rowNode.attrs["height"] as number | null;
                if (height) {
                  resizeRowOrigHeightRef.current = height;
                } else {
                  // Estimate from rendered height: find the row element
                  const tableEl = target.closest(".layout-table");
                  const rowEl = tableEl?.querySelector(
                    `[data-row-index="${rowIndex}"]`,
                  );
                  const renderedHeight =
                    rowEl instanceof HTMLElement
                      ? rowEl.getBoundingClientRect().height
                      : 30;
                  resizeRowOrigHeightRef.current = Math.round(
                    renderedHeight * 15,
                  );
                }
              }
              break;
            }
          }
        }
        return;
      }

      // Right edge resize: intercept clicks on right edge handle
      if (
        !readOnly &&
        target.classList.contains("layout-table-edge-handle-right")
      ) {
        e.preventDefault();
        e.stopPropagation();
        isResizingRightEdgeRef.current = true;
        resizingHfSurfaceRef.current = resizeHfSlot
          ? { rId: resizeHfSlot.rId, kind: resizeHfSlot.kind }
          : null;
        resizeRightEdgeStartXRef.current = e.clientX;
        resizeRightEdgeHandleRef.current = target;
        target.classList.add("dragging");

        const colIndex = Number.parseInt(
          target.dataset["columnIndex"] ?? "0",
          10,
        );
        resizeRightEdgeColIndexRef.current = colIndex;
        resizeRightEdgePmStartRef.current = Number.parseInt(
          target.dataset["tablePmStart"] ?? "0",
          10,
        );

        // Get current last column width from ProseMirror doc
        const view = resizeViewForRead;
        if (view) {
          const $pos = view.state.doc.resolve(
            resizeRightEdgePmStartRef.current + 1,
          );
          for (let d = $pos.depth; d >= 0; d--) {
            const node = $pos.node(d);
            if (node.type.name === "table") {
              const widths = node.attrs["columnWidths"] as number[] | null;
              if (widths && widths[colIndex] !== undefined) {
                resizeRightEdgeOrigWidthRef.current = widths[colIndex];
              }
              break;
            }
          }
        }
        return;
      }

      // Check if the click target is an image element
      const imageEl = findImageElement(target);
      if (!readOnly && imageEl) {
        e.preventDefault();
        e.stopPropagation();

        const pmStart = imageEl.dataset["pmStart"];
        if (pmStart !== undefined) {
          const pos = Number.parseInt(pmStart, 10);
          // HF edit mode + image inside an HF slot: NodeSelect on the
          // matching HF PM. Otherwise selection would land on body at
          // an HF-doc position, which doesn't address a valid node and
          // silently no-ops (or worse, picks an unrelated body node).
          const hfSlot = hfEditMode ? findHfSlotForTarget(imageEl) : null;
          const hfView = hfSlot ? hfPMsRef.current?.getView(hfSlot.rId) : null;
          if (hfView) {
            try {
              hfView.dispatch(
                hfView.state.tr.setSelection(
                  NodeSelection.create(hfView.state.doc, pos),
                ),
              );
            } catch {
              // Pos didn't address a selectable node — fall back to a
              // near text selection so the user still gets focus.
              const $pos = hfView.state.doc.resolve(
                Math.min(pos, hfView.state.doc.content.size),
              );
              hfView.dispatch(
                hfView.state.tr.setSelection(TextSelection.near($pos)),
              );
            }
            hfView.focus();
            // Image selection chrome is body-only today; HF image select
            // shows browser-default selection ring. Tracked for follow-up.
          } else {
            if (hiddenPMRef.current.getView()) {
              hiddenPMRef.current.setNodeSelection(pos);
            } else {
              queueHiddenEditorSelection({ type: "node", pos });
            }
            setSelectedImageInfo(buildImageSelectionInfo(imageEl, pos));
            setSelectionRects([]);
            setCaretPosition(null);
            focusHiddenEditor();
          }
        }
        return;
      }

      // Clicking outside an image clears image selection
      setSelectedImageInfo(null);

      e.preventDefault(); // Prevent native text selection

      startPointerTextSelection(e.clientX, e.clientY);
    },
    // oxlint-disable-next-line react-hooks/exhaustive-deps
    [
      getPositionFromMouse,
      findCellPosFromPmPos,
      readOnly,
      hfEditMode,
      onBodyClick,
      zoom,
      onHyperlinkClick,
      clearTableInsertTimer,
      focusHiddenEditor,
      startPointerTextSelection,
      queueHiddenEditorSelection,
    ],
  );

  // Drag auto-scroll: scrolls when dragging near viewport edges
  const dragAutoScrollCallbackRef = useCallback((cx: number, cy: number) => {
    dragExtendRef.current(cx, cy);
  }, []);
  const {
    updateMousePosition: updateDragScroll,
    stopAutoScroll: stopDragAutoScroll,
  } = useDragAutoScroll({
    pagesContainerRef,
    onScrollExtendSelection: dragAutoScrollCallbackRef,
  });

  // Wire up the drag-extend callback after getPositionFromMouse is available
  dragExtendRef.current = (cx: number, cy: number) => {
    if (!isDraggingRef.current || dragAnchorRef.current === null) {
      return;
    }
    const hfSurface = activeHfDragSurfaceRef.current;
    if (hfSurface) {
      const hfView = hfPMsRef.current?.getView(hfSurface.rId);
      if (!hfView) {
        return;
      }
      const pmPos = clickToPositionDom(
        pagesContainerRef.current ?? hfView.dom,
        cx,
        cy,
        zoom,
      );
      if (pmPos === null) {
        return;
      }
      const docEnd = hfView.state.doc.content.size;
      const anchor = Math.max(0, Math.min(dragAnchorRef.current, docEnd));
      const head = Math.max(0, Math.min(pmPos, docEnd));
      const $anchor = hfView.state.doc.resolve(anchor);
      const $head = hfView.state.doc.resolve(head);
      hfView.dispatch(
        hfView.state.tr.setSelection(TextSelection.between($anchor, $head)),
      );
      return;
    }
    if (!hiddenPMRef.current) {
      return;
    }
    const pmPos = getPositionFromMouse(cx, cy);
    if (pmPos === null) {
      return;
    }
    hiddenPMRef.current.setSelection(dragAnchorRef.current, pmPos);
  };

  /**
   * Handle mousemove - extend selection during drag.
   */
  const handleMouseMove = useCallback(
    (e: MouseEvent) => {
      // Column resize drag
      if (isResizingColumnRef.current) {
        e.preventDefault();
        const delta = e.clientX - resizeStartXRef.current;
        // Move the handle visually
        if (resizeHandleRef.current) {
          const origLeft = Number.parseFloat(
            resizeHandleRef.current.style.left,
          );
          resizeHandleRef.current.style.left = `${origLeft + delta}px`;
          resizeStartXRef.current = e.clientX;

          // Update stored widths (convert pixel delta to twips: 1px ≈ 15 twips at 96dpi)
          const deltaTwips = Math.round(delta * 15);
          const minWidth = 300; // ~0.2 inches minimum
          const newLeft = resizeOrigWidthsRef.current.left + deltaTwips;
          const newRight = resizeOrigWidthsRef.current.right - deltaTwips;
          if (newLeft >= minWidth && newRight >= minWidth) {
            resizeOrigWidthsRef.current = { left: newLeft, right: newRight };
          }
        }
        return;
      }

      // Row resize drag
      if (isResizingRowRef.current) {
        e.preventDefault();
        const delta = e.clientY - resizeStartYRef.current;
        if (resizeRowHandleRef.current) {
          const origTop = Number.parseFloat(
            resizeRowHandleRef.current.style.top,
          );
          resizeRowHandleRef.current.style.top = `${origTop + delta}px`;
          resizeStartYRef.current = e.clientY;

          // Update stored height (convert pixel delta to twips)
          const deltaTwips = Math.round(delta * 15);
          const minHeight = 200; // ~0.14 inches minimum
          const newHeight = resizeRowOrigHeightRef.current + deltaTwips;
          if (newHeight >= minHeight) {
            resizeRowOrigHeightRef.current = newHeight;
          }
        }
        return;
      }

      // Right edge resize drag
      if (isResizingRightEdgeRef.current) {
        e.preventDefault();
        const delta = e.clientX - resizeRightEdgeStartXRef.current;
        if (resizeRightEdgeHandleRef.current) {
          const origLeft = Number.parseFloat(
            resizeRightEdgeHandleRef.current.style.left,
          );
          resizeRightEdgeHandleRef.current.style.left = `${origLeft + delta}px`;
          resizeRightEdgeStartXRef.current = e.clientX;

          // Update stored width (convert pixel delta to twips)
          const deltaTwips = Math.round(delta * 15);
          const minWidth = 300; // ~0.2 inches minimum
          const newWidth = resizeRightEdgeOrigWidthRef.current + deltaTwips;
          if (newWidth >= minWidth) {
            resizeRightEdgeOrigWidthRef.current = newWidth;
          }
        }
        return;
      }

      if (!isDraggingRef.current || dragAnchorRef.current === null) {
        return;
      }
      if (!hiddenPMRef.current || !pagesContainerRef.current) {
        return;
      }

      // Auto-scroll when dragging near viewport edges
      updateDragScroll(e.clientX, e.clientY);

      // HF drag: route the rest of the mousemove through the active HF PM.
      // If the drag started inside an HF table cell, dispatch CellSelection
      // on the HF view; otherwise dragExtendRef handles text selection.
      // The painter repaints via the HF caret overlay either way.
      if (activeHfDragSurfaceRef.current) {
        const hfSurface = activeHfDragSurfaceRef.current;
        const hfView = hfPMsRef.current?.getView(hfSurface.rId);
        if (hfView && cellDragAnchorPosRef.current !== null) {
          const hfPos = clickToPositionDom(
            pagesContainerRef.current,
            e.clientX,
            e.clientY,
            zoom,
          );
          if (hfPos !== null) {
            const currentCellPos = findCellPosInDoc(hfView.state.doc, hfPos);
            if (currentCellPos !== null) {
              try {
                hfView.dispatch(
                  hfView.state.tr.setSelection(
                    CellSelection.create(
                      hfView.state.doc,
                      cellDragAnchorPosRef.current,
                      currentCellPos,
                    ),
                  ),
                );
                isCellDraggingRef.current = true;
                return;
              } catch {
                // Cell positions weren't valid for CellSelection; fall
                // through to text drag.
              }
            }
          }
        }
        dragExtendRef.current(e.clientX, e.clientY);
        return;
      }

      const pmPos = getPositionFromMouse(e.clientX, e.clientY);
      if (pmPos === null) {
        return;
      }

      // Dragging in table cells: text selection first, cell selection when crossing boundary
      if (cellDragAnchorPosRef.current !== null) {
        // If already in cell-drag mode, continue updating cell selection
        if (isCellDraggingRef.current) {
          const currentCellPos = findCellPosFromPmPos(pmPos);
          if (currentCellPos !== null) {
            hiddenPMRef.current.setCellSelection(
              cellDragAnchorPosRef.current,
              currentCellPos,
            );
            return;
          }
        }

        // Switch to cell selection when drag crosses into a different cell
        const currentCellPos = findCellPosFromPmPos(pmPos);
        if (
          currentCellPos !== null &&
          currentCellPos !== cellDragAnchorPosRef.current
        ) {
          isCellDraggingRef.current = true;
          hiddenPMRef.current.setCellSelection(
            cellDragAnchorPosRef.current,
            currentCellPos,
          );
          cellDragOverflowXRef.current = null;
          return;
        }

        // Detect when text selection has maxed out within the cell:
        // If pmPos stops changing but mouse keeps moving, user has dragged past text content
        if (
          cellDragLastPmPosRef.current !== null &&
          pmPos === cellDragLastPmPosRef.current
        ) {
          if (cellDragOverflowXRef.current === null) {
            cellDragOverflowXRef.current = e.clientX;
          } else if (
            Math.abs(e.clientX - cellDragOverflowXRef.current) >=
            CELL_SELECT_OVERFLOW_PX
          ) {
            // Overflow threshold reached — select the entire cell
            isCellDraggingRef.current = true;
            hiddenPMRef.current.setCellSelection(
              cellDragAnchorPosRef.current,
              cellDragAnchorPosRef.current,
            );
            cellDragOverflowXRef.current = null;
            return;
          }
        } else {
          // Position is still advancing — reset overflow tracking
          cellDragOverflowXRef.current = null;
          cellDragLastPmPosRef.current = pmPos;
        }
      }

      // Regular text selection drag (within cell or outside tables)
      const anchor = dragAnchorRef.current;
      hiddenPMRef.current.setSelection(anchor, pmPos);
    },
    [
      getPositionFromMouse,
      findCellPosFromPmPos,
      findCellPosInDoc,
      updateDragScroll,
      zoom,
    ],
  );

  /**
   * Handle mouseup - end drag selection.
   */
  const handleMouseUp = useCallback(() => {
    // Commit column resize
    if (isResizingColumnRef.current) {
      isResizingColumnRef.current = false;
      if (resizeHandleRef.current) {
        resizeHandleRef.current.classList.remove("dragging");
        resizeHandleRef.current = null;
      }

      // Update ProseMirror document with new column widths. Commit on the
      // HF view if the resize started inside an HF slot, else body.
      const view =
        (resizingHfSurfaceRef.current
          ? hfPMsRef.current?.getView(resizingHfSurfaceRef.current.rId)
          : hiddenPMRef.current?.getView()) ?? null;
      resizingHfSurfaceRef.current = null;
      if (view) {
        const pmStart = resizeTablePmStartRef.current;
        const colIdx = resizeColumnIndexRef.current;
        const { left: newLeft, right: newRight } = resizeOrigWidthsRef.current;

        // Find the table node and update columnWidths + cell widths
        const $pos = view.state.doc.resolve(pmStart + 1);
        for (let d = $pos.depth; d >= 0; d--) {
          const node = $pos.node(d);
          if (node.type.name === "table") {
            const tablePos = $pos.before(d);
            const tr = view.state.tr;
            const tableAttrs = expectTableAttrs(node);
            if (!tableAttrs.columnWidths) {
              break;
            }
            const widths = [...tableAttrs.columnWidths];
            widths[colIdx] = newLeft;
            widths[colIdx + 1] = newRight;

            // Update table columnWidths attr
            tr.setNodeMarkup(
              tablePos,
              undefined,
              mergeTableAttrs(node, { columnWidths: widths }),
            );

            // Update cell width attrs in each row
            let rowOffset = tablePos + 1;
            // oxlint-disable-next-line unicorn/no-array-for-each -- ProseMirror Node API
            node.forEach((row) => {
              let cellOffset = rowOffset + 1;
              let cellColIdx = 0;
              // oxlint-disable-next-line unicorn/no-array-for-each -- ProseMirror Node API
              row.forEach((cell) => {
                const cellAttrs = expectTableCellAttrs(cell);
                const colspan = cellAttrs.colspan || 1;
                if (cellColIdx === colIdx || cellColIdx === colIdx + 1) {
                  const newWidth = cellColIdx === colIdx ? newLeft : newRight;
                  tr.setNodeMarkup(
                    tr.mapping.map(cellOffset),
                    undefined,
                    mergeTableCellAttrs(cell, {
                      width: newWidth,
                      widthType: "dxa",
                      colwidth: null,
                    }),
                  );
                }
                cellOffset += cell.nodeSize;
                cellColIdx += colspan;
              });
              rowOffset += row.nodeSize;
            });

            view.dispatch(tr);
            break;
          }
        }
      }
      return;
    }

    // Commit row resize
    if (isResizingRowRef.current) {
      isResizingRowRef.current = false;
      if (resizeRowHandleRef.current) {
        resizeRowHandleRef.current.classList.remove("dragging");
        resizeRowHandleRef.current = null;
      }

      const view =
        (resizingHfSurfaceRef.current
          ? hfPMsRef.current?.getView(resizingHfSurfaceRef.current.rId)
          : hiddenPMRef.current?.getView()) ?? null;
      resizingHfSurfaceRef.current = null;
      if (view) {
        const pmStart = resizeRowTablePmStartRef.current;
        const rowIdx = resizeRowIndexRef.current;
        const newHeight = resizeRowOrigHeightRef.current;

        const $pos = view.state.doc.resolve(pmStart + 1);
        for (let d = $pos.depth; d >= 0; d--) {
          const node = $pos.node(d);
          if (node.type.name === "table") {
            const tablePos = $pos.before(d);
            const tr = view.state.tr;

            // Walk to the target row
            let rowOffset = tablePos + 1;
            let idx = 0;
            // oxlint-disable-next-line unicorn/no-array-for-each -- ProseMirror Node API
            node.forEach((row) => {
              if (idx === rowIdx) {
                tr.setNodeMarkup(
                  tr.mapping.map(rowOffset),
                  undefined,
                  mergeTableRowAttrs(row, {
                    height: newHeight,
                    heightRule: "atLeast",
                  }),
                );
              }
              rowOffset += row.nodeSize;
              idx++;
            });

            view.dispatch(tr);
            break;
          }
        }
      }
      return;
    }

    // Commit right edge resize
    if (isResizingRightEdgeRef.current) {
      isResizingRightEdgeRef.current = false;
      if (resizeRightEdgeHandleRef.current) {
        resizeRightEdgeHandleRef.current.classList.remove("dragging");
        resizeRightEdgeHandleRef.current = null;
      }

      const view =
        (resizingHfSurfaceRef.current
          ? hfPMsRef.current?.getView(resizingHfSurfaceRef.current.rId)
          : hiddenPMRef.current?.getView()) ?? null;
      resizingHfSurfaceRef.current = null;
      if (view) {
        const pmStart = resizeRightEdgePmStartRef.current;
        const colIdx = resizeRightEdgeColIndexRef.current;
        const newWidth = resizeRightEdgeOrigWidthRef.current;

        const $pos = view.state.doc.resolve(pmStart + 1);
        for (let d = $pos.depth; d >= 0; d--) {
          const node = $pos.node(d);
          if (node.type.name === "table") {
            const tablePos = $pos.before(d);
            const tr = view.state.tr;

            // Update columnWidths — only change last column
            const tableAttrs = expectTableAttrs(node);
            if (!tableAttrs.columnWidths) {
              break;
            }
            const widths = [...tableAttrs.columnWidths];
            widths[colIdx] = newWidth;

            tr.setNodeMarkup(
              tablePos,
              undefined,
              mergeTableAttrs(node, { columnWidths: widths }),
            );

            // Update cell width attrs in the last column of each row
            let rowOffset = tablePos + 1;
            // oxlint-disable-next-line unicorn/no-array-for-each -- ProseMirror Node API
            node.forEach((row) => {
              let cellOffset = rowOffset + 1;
              let cellColIdx = 0;
              // oxlint-disable-next-line unicorn/no-array-for-each -- ProseMirror Node API
              row.forEach((cell) => {
                const cellAttrs = expectTableCellAttrs(cell);
                const colspan = cellAttrs.colspan || 1;
                if (cellColIdx === colIdx) {
                  tr.setNodeMarkup(
                    tr.mapping.map(cellOffset),
                    undefined,
                    mergeTableCellAttrs(cell, {
                      width: newWidth,
                      widthType: "dxa",
                      colwidth: null,
                    }),
                  );
                }
                cellOffset += cell.nodeSize;
                cellColIdx += colspan;
              });
              rowOffset += row.nodeSize;
            });

            view.dispatch(tr);
            break;
          }
        }
      }
      return;
    }

    isDraggingRef.current = false;
    isCellDraggingRef.current = false;
    cellDragLastPmPosRef.current = null;
    cellDragOverflowXRef.current = null;
    activeHfDragSurfaceRef.current = null;
    stopDragAutoScroll();
    // Keep dragAnchorRef for potential shift-click extension
  }, [stopDragAutoScroll]);

  // Add global mouse event listeners for drag selection
  useEffect(() => {
    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);

    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [handleMouseMove, handleMouseUp]);

  /**
   * Handle mousemove on pages to show table row/column insert buttons.
   * Detects proximity to table row/column boundaries and shows a floating "+" button.
   */
  const handlePagesMouseMove = useCallback(
    (e: React.MouseEvent) => {
      // Skip during drags / resizes
      if (
        readOnly ||
        isDraggingRef.current ||
        isResizingColumnRef.current ||
        isResizingRowRef.current ||
        isResizingRightEdgeRef.current ||
        isCellDraggingRef.current
      ) {
        return;
      }

      const pagesEl = pagesContainerRef.current;
      if (!pagesEl) {
        return;
      }

      const mouseX = e.clientX;
      const mouseY = e.clientY;

      // Find the table — either directly under the cursor or nearby (for edge hover)
      const eventTarget = e.target instanceof HTMLElement ? e.target : null;
      let tableEl = eventTarget
        ? closestHtmlElement(eventTarget, ".layout-table")
        : null;
      if (!tableEl) {
        // Mouse may be in the margin area near a table — check all tables
        const tables = htmlQueryAll(pagesEl, ".layout-table");
        for (const t of tables) {
          const r = t.getBoundingClientRect();
          const nearLeft =
            mouseX >= r.left - TABLE_INSERT_EDGE_PROXIMITY && mouseX < r.left;
          const nearTop =
            mouseY >= r.top - TABLE_INSERT_EDGE_PROXIMITY && mouseY < r.top;
          const withinX =
            mouseX >= r.left - TABLE_INSERT_EDGE_PROXIMITY && mouseX <= r.right;
          const withinY =
            mouseY >= r.top - TABLE_INSERT_EDGE_PROXIMITY && mouseY <= r.bottom;
          if ((nearLeft && withinY) || (nearTop && withinX)) {
            tableEl = t;
            break;
          }
        }
      }

      if (!tableEl) {
        setTableInsertButton(null);
        return;
      }

      const tableRect = tableEl.getBoundingClientRect();

      const nearLeftEdge =
        mouseX < tableRect.left + TABLE_INSERT_EDGE_PROXIMITY &&
        mouseX >= tableRect.left - TABLE_INSERT_EDGE_PROXIMITY;
      const nearTopEdge =
        mouseY < tableRect.top + TABLE_INSERT_EDGE_PROXIMITY &&
        mouseY >= tableRect.top - TABLE_INSERT_EDGE_PROXIMITY;

      if (!nearLeftEdge && !nearTopEdge) {
        setTableInsertButton(null);
        return;
      }

      const rows = tableEl.querySelectorAll(":scope > .layout-table-row");
      if (rows.length === 0) {
        setTableInsertButton(null);
        return;
      }

      const viewportEl = pagesEl.parentElement;
      if (!viewportEl) {
        return;
      }
      const viewportRect = viewportEl.getBoundingClientRect();

      /** Extract PM position from a cell element */
      const getCellPmPos = (el: HTMLElement | null): number =>
        el ? Number(el.dataset["pmStart"]) || 0 : 0;

      // Show button centered on the hovered row (left edge hover)
      if (nearLeftEdge) {
        for (const row of rows) {
          const rowRect = row.getBoundingClientRect();
          if (mouseY >= rowRect.top && mouseY <= rowRect.bottom) {
            const cell = queryHtmlElement(row, ".layout-table-cell");
            const pmPos = getCellPmPos(cell);
            if (!pmPos) {
              break;
            }
            const rowCenterY = rowRect.top + rowRect.height / 2;
            setTableInsertButton({
              type: "row",
              x: tableRect.left - viewportRect.left - 24,
              y: rowCenterY - viewportRect.top - 10,
              cellPmPos: pmPos,
            });
            clearTableInsertTimer();
            return;
          }
        }
      }

      // Show button centered on the hovered column (top edge hover)
      if (nearTopEdge && rows[0]) {
        const cells = htmlQueryAll(rows[0], ":scope > .layout-table-cell");
        for (const cellEl of cells) {
          const cellRect = cellEl.getBoundingClientRect();
          if (mouseX >= cellRect.left && mouseX <= cellRect.right) {
            const pmPos = getCellPmPos(cellEl);
            if (!pmPos) {
              break;
            }
            const cellCenterX = cellRect.left + cellRect.width / 2;
            setTableInsertButton({
              type: "column",
              x: cellCenterX - viewportRect.left - 10,
              y: tableRect.top - viewportRect.top - 24,
              cellPmPos: pmPos,
            });
            clearTableInsertTimer();
            return;
          }
        }
      }

      // Not over any row/column — schedule hide with a small delay
      if (!tableInsertHideTimerRef.current) {
        tableInsertHideTimerRef.current = setTimeout(() => {
          setTableInsertButton(null);
          tableInsertHideTimerRef.current = null;
        }, TABLE_INSERT_HIDE_DELAY);
      }
    },
    [readOnly, clearTableInsertTimer],
  );

  /**
   * Handle table insert button click — set selection to target cell, then insert.
   */
  const handleTableInsertClick = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (!tableInsertButton || !hiddenPMRef.current) {
        return;
      }

      const view = hiddenPMRef.current.getView();
      if (!view) {
        return;
      }

      const { type, cellPmPos } = tableInsertButton;

      // Set selection inside the target cell
      const tr = view.state.tr.setSelection(
        TextSelection.create(view.state.doc, cellPmPos + 1),
      );
      view.dispatch(tr);

      // Dispatch the appropriate insert command
      if (type === "row") {
        addRowBelow(view.state, view.dispatch);
      } else {
        addColumnRight(view.state, view.dispatch);
      }

      setTableInsertButton(null);
      hiddenPMRef.current.focus();
    },
    [tableInsertButton],
  );

  /**
   * Handle click on pages container (for double-click word selection).
   */
  const handlePagesClick = useCallback(
    (e: React.MouseEvent) => {
      const target = e.target instanceof HTMLElement ? e.target : null;
      if (!target) {
        return;
      }
      // Handle hyperlink clicks (single-click only, not drag-to-select)
      const anchorClosest = target.closest("a[href]");
      const anchorEl =
        anchorClosest instanceof HTMLAnchorElement ? anchorClosest : null;
      if (anchorEl) {
        e.preventDefault();
        const href = anchorEl.getAttribute("href") || "";
        if (href.startsWith("#")) {
          // Internal bookmark — navigate within document
          const bookmarkName = href.slice(1);
          if (bookmarkName && hiddenPMRef.current) {
            const view = hiddenPMRef.current.getView();
            if (view) {
              const targetPos = { value: null as number | null };
              view.state.doc.descendants((node, pos) => {
                if (targetPos.value !== null) {
                  return false;
                }
                if (node.type.name === "paragraph") {
                  const bookmarks = node.attrs["bookmarks"] as
                    | { id: number; name: string }[]
                    | undefined;
                  if (bookmarks?.some((b) => b.name === bookmarkName)) {
                    targetPos.value = pos;
                    return false;
                  }
                }
                return undefined;
              });
              if (targetPos.value !== null) {
                const tp = targetPos.value;
                scrollToPositionImpl(tp);
                hiddenPMRef.current.setSelection(tp + 1);
              }
            }
          }
        } else if (onHyperlinkClick) {
          // External hyperlink — show popup only if not a drag-to-select.
          // Check the active surface's selection: when the user is editing
          // an HF and clicks a link inside that slot, we read HF PM
          // selection state, not body. Without this fix, a single-click
          // on an HF hyperlink while a body range was selected would
          // incorrectly suppress the popup.
          const hfSlot = hfEditMode ? findHfSlotForTarget(target) : null;
          const surfaceView =
            (hfSlot ? hfPMsRef.current?.getView(hfSlot.rId) : null) ??
            hiddenPMRef.current?.getView();
          const hasRangeSelection =
            surfaceView &&
            surfaceView.state.selection.from !== surfaceView.state.selection.to;
          if (!hasRangeSelection) {
            const displayText = anchorEl.textContent || "";
            const tooltip = anchorEl.getAttribute("title") || undefined;
            const clickData: Parameters<
              NonNullable<typeof onHyperlinkClick>
            >[0] = { href, displayText, anchorEl };
            if (tooltip) {
              clickData.tooltip = tooltip;
            }
            onHyperlinkClick(clickData);
          }
        }
        // External links: already handled by mousedown, just prevent default
        return;
      }

      // Double-click on header/footer area triggers editing mode
      if (!readOnly && e.detail === 2 && onHeaderFooterDoubleClick) {
        const headerEl = target.closest(".layout-page-header");
        const footerEl = target.closest(".layout-page-footer");
        if (headerEl || footerEl) {
          const pageEl = closestHtmlElement(target, "[data-page-number]");
          const pageNum = pageEl ? Number(pageEl.dataset["pageNumber"]) : 1;
          if (headerEl) {
            e.preventDefault();
            e.stopPropagation();
            onHeaderFooterDoubleClick("header", pageNum);
            return;
          }
          if (footerEl) {
            e.preventDefault();
            e.stopPropagation();
            onHeaderFooterDoubleClick("footer", pageNum);
            return;
          }
        }
      }

      // Double / triple-click inside an active HF slot routes word /
      // paragraph selection to the matching hidden HF EditorView instead of
      // the body PM. We re-resolve the slot from the target so the
      // selection lands on the right surface even when this handler fires
      // before any prior HF click set drag state.
      if (
        !readOnly &&
        hfEditMode &&
        (e.detail === 2 || e.detail === 3) &&
        hfPMsRef.current
      ) {
        const slot = findHfSlotForTarget(target);
        if (slot) {
          const hfView = hfPMsRef.current.getView(slot.rId);
          if (hfView) {
            const pos = clickToPositionDom(
              pagesContainerRef.current ?? slot.element,
              e.clientX,
              e.clientY,
              zoom,
            );
            if (pos !== null) {
              const docEnd = hfView.state.doc.content.size;
              const clamped = Math.max(0, Math.min(pos, docEnd));
              const $pos = hfView.state.doc.resolve(clamped);
              const parent = $pos.parent;
              if (e.detail === 3) {
                const start = $pos.start($pos.depth);
                const end = $pos.end($pos.depth);
                hfView.dispatch(
                  hfView.state.tr.setSelection(
                    TextSelection.create(hfView.state.doc, start, end),
                  ),
                );
              } else if (parent.isTextblock) {
                const pmAlignedParts: string[] = [];
                for (let i = 0; i < parent.content.childCount; i++) {
                  const node = parent.content.child(i);
                  pmAlignedParts.push(
                    node.isText ? (node.text ?? "") : " ".repeat(node.nodeSize),
                  );
                }
                const pmAlignedText = pmAlignedParts.join("");
                const offset = $pos.parentOffset;
                let start = offset;
                while (
                  start > 0 &&
                  /\w/u.test(pmAlignedText[start - 1]!) // SAFETY: start > 0
                ) {
                  start--;
                }
                let end = offset;
                while (
                  end < pmAlignedText.length &&
                  /\w/u.test(pmAlignedText[end]!) // SAFETY: end < pmAlignedText.length
                ) {
                  end++;
                }
                const absStart = $pos.start() + start;
                const absEnd = $pos.start() + end;
                if (absStart < absEnd) {
                  hfView.dispatch(
                    hfView.state.tr.setSelection(
                      TextSelection.create(hfView.state.doc, absStart, absEnd),
                    ),
                  );
                }
              }
              hfView.focus();
              e.preventDefault();
              e.stopPropagation();
            }
            return;
          }
        }
      }

      // Double-click: select entire cell (CellSelection) if in table, otherwise word selection
      if (e.detail === 2 && hiddenPMRef.current) {
        const pmPos = getPositionFromMouse(e.clientX, e.clientY);
        if (pmPos !== null) {
          // If inside a table cell, select the entire cell
          const cellPos = findCellPosFromPmPos(pmPos);
          if (cellPos !== null) {
            e.preventDefault();
            e.stopPropagation();
            hiddenPMRef.current.setCellSelection(cellPos, cellPos);
            return;
          }

          const view = hiddenPMRef.current.getView();
          if (view) {
            const { doc } = view.state;
            const $pos = doc.resolve(pmPos);
            const parent = $pos.parent;

            // Find word boundaries.
            if (parent.isTextblock) {
              // Build a string aligned 1-to-1 with PM
              // offsets inside the parent. Atom inline
              // nodes (tab, hard_break, image) take 1 PM
              // position but don't appear in
              // `textContent`, so a tab at offset 0 +
              // text "(a)" + tab at offset 4 + text
              // "Equity Financing" has parentSize 21
              // but textContent length 19. Walking
              // word boundaries on `textContent` and
              // then writing back via `$pos.start() +
              // offset` shifts the resulting selection
              // by one PM position per atom skipped —
              // double-clicking "Financing" in such a
              // paragraph selected "y Financin"
              // instead. Padding atom nodes with a
              // non-word character keeps every offset
              // in PM-position space.
              const pmAlignedParts: string[] = [];
              for (let i = 0; i < parent.content.childCount; i++) {
                const node = parent.content.child(i);
                pmAlignedParts.push(
                  node.isText ? (node.text ?? "") : " ".repeat(node.nodeSize),
                );
              }
              const pmAlignedText = pmAlignedParts.join("");
              const offset = $pos.parentOffset;

              // Find word start (go back until whitespace/punctuation)
              let start = offset;
              while (start > 0 && /\w/u.test(pmAlignedText[start - 1]!)) {
                // SAFETY: start > 0
                start--;
              }

              // Find word end (go forward until whitespace/punctuation)
              let end = offset;
              while (
                end < pmAlignedText.length &&
                /\w/u.test(pmAlignedText[end]!)
              ) {
                // SAFETY: end < pmAlignedText.length
                end++;
              }

              // Convert to absolute positions
              const absStart = $pos.start() + start;
              const absEnd = $pos.start() + end;

              if (absStart < absEnd) {
                hiddenPMRef.current.setSelection(absStart, absEnd);
              }
            }
          }
        }
      }
      // Triple-click for paragraph selection
      if (e.detail === 3 && hiddenPMRef.current) {
        const pmPos = getPositionFromMouse(e.clientX, e.clientY);
        if (pmPos !== null) {
          const view = hiddenPMRef.current.getView();
          if (view) {
            const { doc } = view.state;
            const $pos = doc.resolve(pmPos);

            // Find paragraph start and end
            const paragraphStart = $pos.start($pos.depth);
            const paragraphEnd = $pos.end($pos.depth);

            hiddenPMRef.current.setSelection(paragraphStart, paragraphEnd);
          }
        }
      }
    },
    // oxlint-disable-next-line react-hooks/exhaustive-deps
    [
      getPositionFromMouse,
      onHeaderFooterDoubleClick,
      onHyperlinkClick,
      readOnly,
    ],
  );

  /**
   * Handle right-click on pages — set/preserve selection and show context menu.
   */
  const handlePagesContextMenu = useCallback(
    (e: React.MouseEvent) => {
      if (!onContextMenu) {
        return;
      } // No handler, let browser default

      e.preventDefault();

      // HF edit mode: route the right-click to the matching HF PM so the
      // context menu reads HF selection state. Without this the menu would
      // act on body PM state — wrong "has selection" flag and any caret
      // move on right-click would land in the body.
      const target = e.target instanceof HTMLElement ? e.target : null;
      if (!readOnly && hfEditMode && target) {
        const slot = findHfSlotForTarget(target);
        if (slot) {
          const hfView = hfPMsRef.current?.getView(slot.rId);
          if (hfView) {
            const { from, to } = hfView.state.selection;
            const pmPos = clickToPositionDom(
              pagesContainerRef.current ?? slot.element,
              e.clientX,
              e.clientY,
              zoom,
            );
            if (pmPos !== null && (from === to || pmPos < from || pmPos > to)) {
              const docEnd = hfView.state.doc.content.size;
              const clamped = Math.max(0, Math.min(pmPos, docEnd));
              const $pos = hfView.state.doc.resolve(clamped);
              hfView.dispatch(
                hfView.state.tr.setSelection(TextSelection.near($pos)),
              );
              hfView.focus();
            }
            const after = hfView.state.selection;
            onContextMenu({
              x: e.clientX,
              y: e.clientY,
              hasSelection: after.from !== after.to,
            });
            return;
          }
        }
      }

      const view = hiddenPMRef.current?.getView();
      if (!view) {
        return;
      }

      const { from, to } = view.state.selection;
      const pmPos = getPositionFromMouse(e.clientX, e.clientY);

      if (pmPos !== null && (from === to || pmPos < from || pmPos > to)) {
        hiddenPMRef.current?.setSelection(pmPos);
        hiddenPMRef.current?.focus();
        setIsFocused(true);
      }

      const updatedState = hiddenPMRef.current?.getState();
      const hasSelection = updatedState
        ? updatedState.selection.from !== updatedState.selection.to
        : false;

      onContextMenu({ x: e.clientX, y: e.clientY, hasSelection });
    },
    [hfEditMode, onContextMenu, getPositionFromMouse, readOnly, zoom],
  );

  /**
   * Handle focus on container - redirect to hidden PM.
   */
  const handleContainerFocus = useCallback(
    (e: React.FocusEvent) => {
      // Don't steal focus from sidebar inputs (textareas, inputs, buttons)
      if (
        e.target instanceof HTMLElement &&
        e.target.closest(".docx-comments-sidebar")
      ) {
        return;
      }
      focusHiddenEditor();
    },
    [focusHiddenEditor],
  );

  /**
   * Handle blur from container.
   */
  const handleContainerBlur = useCallback((e: React.FocusEvent) => {
    // Check if focus is moving to hidden PM or staying within container
    const relatedTarget =
      e.relatedTarget instanceof HTMLElement ? e.relatedTarget : null;
    if (relatedTarget && containerRef.current?.contains(relatedTarget)) {
      return; // Focus staying within editor
    }
    // Keep selection visible when focus moves to the editor's own
    // formatting toolbar or dropdown portals. Use `[data-folio-toolbar]`
    // (not `[role="toolbar"]`) so the AI chat composer — which uses
    // `role="toolbar"` for accessibility — does NOT count as "still in
    // the editor" and the caret correctly hides when typing in chat.
    if (
      relatedTarget?.closest(
        '[data-folio-toolbar="true"], [data-radix-popper-content-wrapper], [data-radix-select-content], .docx-table-options-dropdown',
      )
    ) {
      return;
    }
    setIsFocused(false);
  }, []);

  /**
   * Handle image resize from the overlay.
   */
  const handleImageResize = useCallback(
    (pmPos: number, newWidth: number, newHeight: number) => {
      const view = hiddenPMRef.current?.getView();
      if (!view) {
        return;
      }

      try {
        const node = view.state.doc.nodeAt(pmPos);
        if (!node || node.type.name !== "image") {
          return;
        }

        const tr = view.state.tr.setNodeMarkup(
          pmPos,
          undefined,
          mergeImageAttrs(node, { width: newWidth, height: newHeight }),
        );
        view.dispatch(tr);

        // Re-select the image after resize
        hiddenPMRef.current?.setNodeSelection(pmPos);
      } catch {
        // Position may have changed during resize
      }
    },
    [],
  );

  /**
   * Handle image resize start - prevent text selection during resize.
   */
  const handleImageResizeStart = useCallback(() => {
    isImageInteractingRef.current = true;
  }, []);

  /**
   * Handle image resize end.
   */
  const handleImageResizeEnd = useCallback(() => {
    isImageInteractingRef.current = false;
  }, []);

  /**
   * Handle image drag-to-move: move image node from its current position
   * to the drop position determined by mouse coordinates.
   */
  const handleImageDragMove = useCallback(
    (pmPos: number, clientX: number, clientY: number) => {
      const view = hiddenPMRef.current?.getView();
      if (!view) {
        return;
      }

      try {
        const node = view.state.doc.nodeAt(pmPos);
        if (!node || node.type.name !== "image") {
          return;
        }

        const attrs = expectImageAttrs(node);
        const isFloating =
          attrs.displayMode === "float" ||
          attrs.wrapType === "square" ||
          attrs.wrapType === "tight" ||
          attrs.wrapType === "through";

        if (isFloating) {
          // For floating images: update position attributes so the image
          // moves to the drop point while staying floating.
          // Find the page under the drop point
          const pages =
            pagesContainerRef.current?.querySelectorAll(".layout-page");
          if (!pages || pages.length === 0) {
            return;
          }

          let contentEl: HTMLElement | null = null;
          for (const page of pages) {
            const rect = page.getBoundingClientRect();
            if (clientY >= rect.top && clientY <= rect.bottom) {
              contentEl = queryHtmlElement(page, ".layout-page-content");
              break;
            }
          }
          if (!contentEl) {
            // Fallback to last page if below all pages
            const lastPage = Array.from(pages).at(-1);
            contentEl = lastPage
              ? queryHtmlElement(lastPage, ".layout-page-content")
              : null;
          }
          if (!contentEl) {
            return;
          }

          const contentRect = contentEl.getBoundingClientRect();
          // Convert drop coordinates to content-area-relative pixels
          const dropX = (clientX - contentRect.left) / zoom;
          const dropY = (clientY - contentRect.top) / zoom;
          // Pixels to EMU: px * 914400 / 96
          const PIXELS_TO_EMU = 914_400 / 96;
          const hOffsetEmu = Math.round(dropX * PIXELS_TO_EMU);
          const vOffsetEmu = Math.round(dropY * PIXELS_TO_EMU);

          const newPosition: ImagePositionAttrs = {
            horizontal: { posOffset: hOffsetEmu, relativeTo: "margin" },
            vertical: { posOffset: vOffsetEmu, relativeTo: "margin" },
          };

          const tr = view.state.tr.setNodeMarkup(
            pmPos,
            undefined,
            mergeImageAttrs(node, { position: newPosition }),
          );
          view.dispatch(tr);
          hiddenPMRef.current?.setNodeSelection(pmPos);
        } else {
          // For inline images: move to the drop text position
          const dropPos = getPositionFromMouse(clientX, clientY);
          if (dropPos === null) {
            return;
          }
          if (dropPos === pmPos || dropPos === pmPos + 1) {
            return;
          }

          let tr = view.state.tr;

          if (dropPos <= pmPos) {
            tr = tr.delete(pmPos, pmPos + node.nodeSize);
            tr = tr.insert(dropPos, node);
            hiddenPMRef.current?.setNodeSelection(dropPos);
          } else {
            tr = tr.delete(pmPos, pmPos + node.nodeSize);
            const adjusted = dropPos - node.nodeSize;
            tr = tr.insert(Math.min(adjusted, tr.doc.content.size), node);
            hiddenPMRef.current?.setNodeSelection(
              Math.min(adjusted, tr.doc.content.size - 1),
            );
          }

          view.dispatch(tr);
        }
      } catch {
        // Position may be invalid
      }
    },
    [getPositionFromMouse, zoom],
  );

  const handleImageDragStart = useCallback(() => {
    isImageInteractingRef.current = true;
  }, []);

  const handleImageDragEnd = useCallback(() => {
    isImageInteractingRef.current = false;
  }, []);

  /**
   * Handle keyboard events on container.
   * Most keyboard handling is done by ProseMirror, but we intercept
   * specific keys for navigation and ensure focus stays on hidden PM.
   */
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (readOnly && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "c") {
        copySelectionText();
        return;
      }

      if (readOnly) {
        if (isReadOnlyEditKey(e)) {
          onReadOnlyEditAttempt?.();
          e.preventDefault();
        }
        return;
      }

      let view = hiddenPMRef.current?.getView();
      if (!view) {
        ensureHiddenEditorView({ sync: true });
        view = hiddenPMRef.current?.getView();

        if (view) {
          applyPendingHiddenEditorInput(view);
          if (isPlainTextInputEvent(e)) {
            e.preventDefault();
            dispatchEditorTextInput(view, e.key);
            return;
          }

          if (isDeferredEditorKeyDown(e)) {
            e.preventDefault();
            replayDeferredKeyDown(view, toDeferredKeyboardEventInit(e));
            return;
          }
        }

        if (isPlainTextInputEvent(e)) {
          queueHiddenEditorTextInput(e.key);
          e.preventDefault();
          return;
        }

        if (isDeferredEditorKeyDown(e)) {
          queueHiddenEditorKeyDown(e);
          e.preventDefault();
        }
        return;
      }

      if (
        pendingHiddenEditorSelectionRef.current ||
        queuedInputBeforeHiddenEditorRef.current.length > 0
      ) {
        applyPendingHiddenEditorInput(view);
      }

      // Ensure hidden PM is focused if user types
      if (!hiddenPMRef.current?.isFocused()) {
        focusHiddenEditor();
      }

      // Prevent space from scrolling the container - let PM handle it as text input.
      // During IME composition, let the browser handle space natively to avoid
      // duplicating the final composed character (e.g., Korean Hangul).
      if (
        e.key === " " &&
        !e.ctrlKey &&
        !e.metaKey &&
        !e.nativeEvent.isComposing
      ) {
        e.preventDefault();
        dispatchEditorTextInput(view, " ");
        return;
      }

      // PageUp/PageDown - let container handle scrolling
      if (["PageUp", "PageDown"].includes(e.key) && !e.metaKey && !e.ctrlKey) {
        // Let PM handle the cursor movement first
        // If PM doesn't handle it (at bounds), the container will scroll
      }

      // Cmd/Ctrl+Home - scroll to top and move cursor to start
      if (e.key === "Home" && (e.metaKey || e.ctrlKey)) {
        const sc = getScrollContainer();
        if (sc) {
          sc.scrollTop = 0;
        }
      }

      // Cmd/Ctrl+End - scroll to bottom and move cursor to end
      if (e.key === "End" && (e.metaKey || e.ctrlKey)) {
        const sc = getScrollContainer();
        if (sc) {
          sc.scrollTop = sc.scrollHeight;
        }
      }
    },
    [
      copySelectionText,
      applyPendingHiddenEditorInput,
      ensureHiddenEditorView,
      focusHiddenEditor,
      getScrollContainer,
      onReadOnlyEditAttempt,
      queueHiddenEditorKeyDown,
      queueHiddenEditorTextInput,
      readOnly,
    ],
  );

  /**
   * Handle mousedown on container (outside pages).
   */
  const handleContainerMouseDown = useCallback(
    (e: React.MouseEvent) => {
      // Don't steal focus from sidebar inputs
      if (
        e.target instanceof HTMLElement &&
        e.target.closest(".docx-comments-sidebar")
      ) {
        return;
      }
      // Focus hidden PM if clicking outside pages area
      if (!hiddenPMRef.current?.isFocused()) {
        focusHiddenEditor();
      }
    },
    [focusHiddenEditor],
  );

  // =========================================================================
  // Initial Layout
  // =========================================================================

  useEffect(() => {
    if (
      !shouldCreateHiddenEditorView &&
      preHiddenInitialLayoutDoneRef.current &&
      precomputedInitialDocumentRef.current !== document
    ) {
      preHiddenInitialLayoutDoneRef.current = false;
      precomputedInitialDocumentRef.current = null;
      setPrecomputedInitialState(null);
    }

    if (
      shouldCreateHiddenEditorView ||
      collaboration !== undefined ||
      preHiddenInitialLayoutDoneRef.current
    ) {
      return undefined;
    }

    if (!document) {
      ensureHiddenEditorView();
      return undefined;
    }

    const initialState = createHiddenEditorState(
      document,
      styles,
      extensionManager,
      externalPlugins,
      undefined,
      null,
      "mount",
    );
    precomputedInitialDocumentRef.current = document;
    setPrecomputedInitialState(initialState);
    anonymizationMatchesRef.current =
      anonymizationDecorationsKey.getState(initialState)?.matches ?? [];

    let cancelled = false;
    pendingInitialFontReadyLayoutRef.current = true;
    const fontWaitStartedAt = performance.now();
    const runAfterFontWait = (fontsLoaded: boolean) => {
      if (cancelled) {
        return;
      }

      pendingInitialFontReadyLayoutRef.current = false;
      preHiddenInitialLayoutDoneRef.current = true;
      recordLayoutPhase(
        "initial",
        "initial-fonts",
        performance.now() - fontWaitStartedAt,
      );
      resetCanvasContext();
      clearAllCaches();
      runLayoutPipeline(initialState, { reason: "initial" });
      updateSelectionOverlay(initialState);
      updateAnonymizationOverlay();
      if (fontsLoaded) {
        lastLayoutUsedLoadedFontsRef.current = true;
        suppressFontReadyUntilRef.current =
          performance.now() + INITIAL_FONT_READY_SUPPRESSION_MS;
      }
    };

    void waitForInitialLayoutFonts(document, initialState.doc).then(
      runAfterFontWait,
      () => runAfterFontWait(false),
    );

    return () => {
      cancelled = true;
      pendingInitialFontReadyLayoutRef.current = false;
    };
  }, [
    collaboration,
    document,
    ensureHiddenEditorView,
    extensionManager,
    externalPlugins,
    runLayoutPipeline,
    shouldCreateHiddenEditorView,
    styles,
    updateAnonymizationOverlay,
    updateSelectionOverlay,
  ]);

  /**
   * Run initial layout when document or view changes.
   */
  const handleEditorViewReady = useCallback(
    (view: EditorView) => {
      anonymizationMatchesRef.current =
        anonymizationDecorationsKey.getState(view.state)?.matches ?? [];

      const focusReadyView = () => {
        if (readOnly || !shouldFocusHiddenEditorOnReadyRef.current) {
          return;
        }

        requestAnimationFrame(() => {
          if (hiddenPMRef.current?.getView() !== view) {
            return;
          }

          applyPendingHiddenEditorInput(view);
          view.focus();
          setIsFocused(true);
        });
      };

      if (lastLaidOutPmDocRef.current?.eq(view.state.doc)) {
        updateSelectionOverlay(view.state);
        updateAnonymizationOverlay();
        focusReadyView();
        return;
      }

      const runInitialLayout = (currentView: EditorView) => {
        runLayoutPipeline(currentView.state, { reason: "initial" });
        updateSelectionOverlay(currentView.state);
        updateAnonymizationOverlay();
      };

      pendingInitialFontReadyLayoutRef.current = true;
      const fontWaitStartedAt = performance.now();
      const runAfterFontWait = (fontsLoaded: boolean) => {
        pendingInitialFontReadyLayoutRef.current = false;
        const currentView = hiddenPMRef.current?.getView();
        if (currentView !== view) {
          return;
        }
        recordLayoutPhase(
          "initial",
          "initial-fonts",
          performance.now() - fontWaitStartedAt,
        );
        resetCanvasContext();
        clearAllCaches();
        runInitialLayout(currentView);
        if (fontsLoaded) {
          lastLayoutUsedLoadedFontsRef.current = true;
          suppressFontReadyUntilRef.current =
            performance.now() + INITIAL_FONT_READY_SUPPRESSION_MS;
        }
      };
      void waitForInitialLayoutFonts(document, view.state.doc).then(
        runAfterFontWait,
        () => runAfterFontWait(false),
      );

      // Auto-focus the editor so the user can start typing immediately
      focusReadyView();
    },
    [
      applyPendingHiddenEditorInput,
      runLayoutPipeline,
      updateSelectionOverlay,
      updateAnonymizationOverlay,
      document,
      readOnly,
    ],
  );

  // Re-paint anonymization overlay whenever a fresh layout lands;
  // selectionToRects needs the latest layout/blocks/measures to
  // place rectangles correctly after a doc edit or zoom change.
  useEffect(() => {
    updateAnonymizationOverlay();
  }, [updateAnonymizationOverlay]);

  // Compute anchor Y positions for comments/revisions sidebar from the current
  // layout artifacts. Opening the sidebar or switching anchor modes does not
  // change page geometry, so this intentionally avoids a full layout pass.
  useEffect(() => {
    if (!onAnchorPositionsChange || !layout) {
      return undefined;
    }

    let cancelled = false;
    void loadSelectionGeometry().then(
      ({ getCaretPosition }) => {
        if (cancelled) {
          return undefined;
        }

        try {
          const positions = computeAnchorPositions(
            lastLayoutEditorStateRef.current,
            layout,
            blocks,
            measures,
            pageGap,
            {
              includeRevisions: anchorPositionMode === "comments-and-revisions",
            },
            getCaretPosition,
          );
          onAnchorPositionsChange(positions);
        } catch {
          // Keep the previous anchor positions if layout measurement fails.
        }
        return undefined;
      },
      () => undefined,
    );

    return () => {
      cancelled = true;
    };
  }, [
    anchorPositionMode,
    blocks,
    layout,
    measures,
    onAnchorPositionsChange,
    pageGap,
  ]);

  // Re-layout when web fonts finish loading to fix measurements that were
  // computed against fallback fonts during initial render.
  // Uses FontFaceSet.onloadingdone to detect when new fonts complete loading.
  useEffect(() => {
    const fontSet = getDocumentFontSet();
    if (!fontSet) {
      return undefined;
    }

    const handleFontsLoading = () => {
      if (performance.now() < suppressFontReadyUntilRef.current) {
        return;
      }
      lastLayoutUsedLoadedFontsRef.current = false;
    };

    const handleFontsLoaded = () => {
      if (
        pendingInitialFontReadyLayoutRef.current ||
        performance.now() < suppressFontReadyUntilRef.current ||
        lastLayoutUsedLoadedFontsRef.current
      ) {
        return;
      }

      const view = hiddenPMRef.current?.getView();
      if (view) {
        // Clear all cached measurements — font metrics have changed
        resetCanvasContext();
        clearAllCaches();
        runLayoutPipelineRef.current(view.state, { reason: "font-ready" });
        updateSelectionOverlayRef.current(view.state);
      }
    };

    // Listen for font loading completion events
    fontSet.addEventListener("loading", handleFontsLoading);
    fontSet.addEventListener("loadingdone", handleFontsLoaded);
    fontSet.addEventListener("loadingerror", handleFontsLoaded);
    return () => {
      fontSet.removeEventListener("loading", handleFontsLoading);
      fontSet.removeEventListener("loadingdone", handleFontsLoaded);
      fontSet.removeEventListener("loadingerror", handleFontsLoaded);
    };
  }, []);

  // Re-layout when non-document layout inputs change (e.g., after HF editor save
  // or parent-driven page setup/theme updates).
  // runLayoutPipeline includes these values in its deps, but it
  // only runs when explicitly called — this effect triggers it.
  const layoutInputEpochRef = useRef(0);
  const lastLayoutInputSignatureRef = useRef<string | null>(null);
  useEffect(() => {
    // Skip the initial render — handleEditorViewReady already does the first layout
    if (layoutInputEpochRef.current === 0) {
      layoutInputEpochRef.current = 1;
      lastLayoutInputSignatureRef.current = layoutInputSignature;
      return;
    }
    const view = hiddenPMRef.current?.getView();
    if (view) {
      const layoutInputsChanged =
        lastLayoutInputSignatureRef.current !== layoutInputSignature;
      lastLayoutInputSignatureRef.current = layoutInputSignature;
      if (
        !layoutInputsChanged &&
        view.state.doc === lastLaidOutPmDocRef.current
      ) {
        return;
      }
      runLayoutPipelineRef.current(view.state, { reason: "layout-input" });
    }
  }, [document, layoutInputSignature]);

  // Re-compute selection overlay when the container resizes.
  // Page elements shift during window resize (centering, scrollbar changes),
  // causing caret/selection coordinates to become stale.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    const observer = new ResizeObserver(() => {
      const state = hiddenPMRef.current?.getState();
      if (state) {
        updateSelectionOverlay(state);
      }
    });

    observer.observe(container);
    return () => observer.disconnect();
  }, [updateSelectionOverlay]);

  // =========================================================================
  // Imperative Handle
  // =========================================================================

  useImperativeHandle(
    ref,
    () => ({
      getDocument() {
        return hiddenPMRef.current?.getDocument() ?? null;
      },
      getState() {
        return hiddenPMRef.current?.getState() ?? null;
      },
      getView() {
        return hiddenPMRef.current?.getView() ?? null;
      },
      getHfView(rId: string) {
        return hfPMsRef.current?.getView(rId) ?? null;
      },
      ensureView(options?: { focus?: boolean }) {
        // Async (no flushSync) so this is safe to call from a consumer's
        // useEffect during a concurrent render — flushSync inside a
        // commit-phase effect throws "flushSync was called from inside
        // a lifecycle method". The state setter still schedules a
        // re-render that runs createView in the next layout effect;
        // callers that need the view immediately can poll.
        ensureHiddenEditorView(options);
      },
      focus() {
        hiddenPMRef.current?.focus();
        setIsFocused(true);
      },
      blur() {
        hiddenPMRef.current?.blur();
        setIsFocused(false);
      },
      isFocused() {
        return hiddenPMRef.current?.isFocused() ?? false;
      },
      dispatch(tr: Transaction) {
        hiddenPMRef.current?.dispatch(tr);
      },
      undo() {
        return hiddenPMRef.current?.undo() ?? false;
      },
      redo() {
        return hiddenPMRef.current?.redo() ?? false;
      },
      canUndo() {
        return hiddenPMRef.current?.canUndo() ?? false;
      },
      canRedo() {
        return hiddenPMRef.current?.canRedo() ?? false;
      },
      setSelection(anchor: number, head?: number) {
        hiddenPMRef.current?.setSelection(anchor, head);
      },
      getLayout() {
        return layout;
      },
      relayout() {
        const state = hiddenPMRef.current?.getState();
        if (state) {
          runLayoutPipeline(state, { reason: "manual" });
        }
      },
      scrollToPosition: scrollToPositionImpl,
      scrollToPage: scrollToPageImpl,
      getPageNumberForPmPos(pmPos) {
        const container = pagesContainerRef.current;
        if (!container) {
          return null;
        }
        // Fast path: virtualised docs keep a pm-to-shell map.
        const hit = findPageShellForPmPos(container, pmPos);
        if (hit) {
          const raw = hit.element.dataset["pageNumber"];
          const parsed = raw === undefined ? Number.NaN : Number(raw);
          if (Number.isFinite(parsed)) {
            return parsed;
          }
        }
        // Fallback for non-virtualised docs (< 8 pages): every page is in the
        // DOM eagerly, so scan shells and find the one whose pm range covers
        // the target.
        const shells =
          container.querySelectorAll<HTMLElement>("[data-page-number]");
        let bestNumber: number | null = null;
        let bestStart = Number.NEGATIVE_INFINITY;
        for (const shell of shells) {
          const anchors =
            shell.querySelectorAll<HTMLElement>("[data-pm-start]");
          if (anchors.length === 0) {
            continue;
          }
          let pageStart = Number.POSITIVE_INFINITY;
          let pageEnd = Number.NEGATIVE_INFINITY;
          for (const el of anchors) {
            const pm = Number(el.dataset["pmStart"]);
            if (!Number.isFinite(pm)) {
              continue;
            }
            if (pm < pageStart) {
              pageStart = pm;
            }
            if (pm > pageEnd) {
              pageEnd = pm;
            }
          }
          if (pageStart === Number.POSITIVE_INFINITY) {
            continue;
          }
          const raw = shell.dataset["pageNumber"];
          const parsed = raw === undefined ? Number.NaN : Number(raw);
          if (!Number.isFinite(parsed)) {
            continue;
          }
          if (pageStart <= pmPos && pmPos <= pageEnd) {
            return parsed;
          }
          if (pageStart <= pmPos && pageStart > bestStart) {
            bestStart = pageStart;
            bestNumber = parsed;
          }
        }
        return bestNumber;
      },
    }),
    [
      ensureHiddenEditorView,
      layout,
      runLayoutPipeline,
      scrollToPageImpl,
      scrollToPositionImpl,
    ],
  );

  useEffect(() => {
    if (!layout) {
      return;
    }

    const totalPages = layout.pages.length;
    if (lastTotalPagesRef.current === totalPages) {
      return;
    }

    lastTotalPagesRef.current = totalPages;
    onTotalPagesChangeRef.current?.(totalPages);
  }, [layout]);

  // Update selection overlay when layout changes
  // This is needed because handleEditorViewReady calls runLayoutPipeline which
  // sets layout asynchronously, so updateSelectionOverlay would return early
  // if layout is still null. This effect ensures we update once layout is ready.
  useEffect(() => {
    const state = hiddenPMRef.current?.getState();
    if (layout && state) {
      updateSelectionOverlay(state);
    }
  }, [layout, updateSelectionOverlay]);

  // =========================================================================
  // Render
  // =========================================================================

  // Calculate total height for scroll
  const totalHeight = useMemo(() => {
    if (!layout) {
      return DEFAULT_PAGE_HEIGHT + 48;
    }
    const numPages = layout.pages.length;
    return numPages * pageSize.h + (numPages - 1) * pageGap + 48;
  }, [layout, pageSize.h, pageGap]);
  const scaledViewportHeight = Math.max(1, totalHeight * zoom);
  const scaledViewportWidth = Math.max(
    1,
    pageSize.w * zoom +
      (commentsSidebarOpen ? COMMENTS_SIDEBAR_SCROLL_GUTTER : 0),
  );
  const viewportExtentStyle: CSSProperties = {
    position: "relative",
    width: `max(100%, ${String(scaledViewportWidth)}px)`,
    height: scaledViewportHeight,
    backgroundColor: "transparent",
  };
  const scaledViewportStyle: CSSProperties = {
    ...viewportStyles,
    position: "absolute",
    top: 0,
    left: `max(0px, calc((100% - ${String(scaledViewportWidth)}px) / 2))`,
    width: pageSize.w,
    minHeight: totalHeight,
    transform: (() => {
      const parts: string[] = [];
      if (zoom !== 1) {
        parts.push(`scale(${zoom})`);
      }
      return parts.length > 0 ? parts.join(" ") : undefined;
    })(),
    transformOrigin: "top left",
  };

  return (
    <div
      ref={containerRef}
      className={`folio-root paged-editor ${className ?? ""}`}
      style={{ ...containerStyles, ...style }}
      tabIndex={0}
      role="textbox"
      aria-multiline
      onFocus={handleContainerFocus}
      onBlur={handleContainerBlur}
      onKeyDown={handleKeyDown}
      onMouseDown={handleContainerMouseDown}
    >
      {/* Persistent off-screen ProseMirror per HF rId — the painter reads
          from these views when a slot's view exists (see HF unification port,
          eigenpal#611). Currently shadow instances: the inline overlay still
          owns user input. Switching the layout pipeline to source from these
          views is the next phase. */}
      <HiddenHeaderFooterPMs
        ref={hfPMsRef}
        document={document}
        onTransaction={handleHfPmTransaction}
        {...(styles !== undefined ? { styles } : {})}
        {...(_theme !== undefined ? { theme: _theme } : {})}
      />

      {/* Hidden ProseMirror for keyboard input */}
      <HiddenProseMirror
        ref={hiddenPMRef}
        document={document}
        widthPx={contentWidth}
        deferViewCreation={!shouldCreateHiddenEditorView}
        precomputedInitialState={validPrecomputedInitialState}
        readOnly={readOnly}
        onTransaction={handleTransaction}
        onSelectionChange={handleSelectionChange}
        onRemoteSelectionsChange={setRemoteSelections}
        onEditorViewReady={handleEditorViewReady}
        onKeyDown={handlePMKeyDown}
        {...(styles !== undefined ? { styles } : {})}
        externalPlugins={externalPlugins}
        {...(collaboration !== undefined ? { collaboration } : {})}
        {...(extensionManager !== undefined ? { extensionManager } : {})}
        {...(onReadOnlyEditAttempt !== undefined
          ? { onReadOnlyEditAttempt }
          : {})}
      />

      {/* Viewport for visible pages */}
      <div
        className="paged-editor__viewport-extent"
        style={viewportExtentStyle}
      >
        <div className="paged-editor__viewport" style={scaledViewportStyle}>
          {/* Pages container */}
          <div
            ref={pagesContainerRef}
            className={`paged-editor__pages${readOnly ? " paged-editor--readonly" : ""}${hfEditMode ? ` paged-editor--hf-editing paged-editor--editing-${hfEditMode}` : ""}`}
            style={pagesContainerStyles}
            onMouseDown={handlePagesMouseDown}
            onMouseMove={handlePagesMouseMove}
            onClick={handlePagesClick}
            onContextMenu={handlePagesContextMenu}
            aria-hidden="true" // Visual only, PM provides semantic content
          />

          {/* Anonymization highlights — paints on top of the
                rendered pages so PII spans the wasm pipeline would
                redact are visible inline. Always mounted, renders
                nothing when no terms are pushed. */}
          <AnonymizationRectsOverlay
            groups={anonymizationRectGroups}
            onTermClick={onAnonymizationTermClick}
            selectedCanonical={selectedAnonymizationCanonical}
            selectionSeq={anonymizationSelectionSeq}
          />

          {/* Selection overlay */}
          <SelectionOverlay
            selectionRects={selectionRects}
            caretPosition={caretPosition}
            isFocused={isFocused}
            pageGap={pageGap}
          />
          {/* HF caret overlay — draws the caret + selection rects for the
              focused persistent hidden HF EditorView. Painted DOM is the
              source of truth: we walk findHfPmAnchor markers under
              .layout-page-header[data-rid] / .layout-page-footer[data-rid]
              and project the rects relative to the pages container. The
              `painter:painted` and `hfCaretSelection` change events both
              re-run the lookup. */}
          {hfCaretSelection && (
            <HfCaretOverlay
              selection={hfCaretSelection}
              pagesContainer={pagesContainerRef.current}
            />
          )}
          {layout &&
            remoteSelections.map((remoteSelection) => (
              <RemoteSelectionOverlay
                key={remoteSelection.clientId}
                blocks={blocks}
                layout={layout}
                measures={measures}
                pagesContainer={pagesContainerRef.current}
                remoteSelection={remoteSelection}
                zoom={zoom}
              />
            ))}

          {/* Image selection overlay */}
          {!readOnly && (
            <ImageSelectionOverlay
              imageInfo={selectedImageInfo}
              zoom={zoom}
              isFocused={isFocused}
              onResize={handleImageResize}
              onResizeStart={handleImageResizeStart}
              onResizeEnd={handleImageResizeEnd}
              onDragMove={handleImageDragMove}
              onDragStart={handleImageDragStart}
              onDragEnd={handleImageDragEnd}
            />
          )}

          {/* Table quick action insert button */}
          {tableInsertButton && (
            <button
              type="button"
              onMouseDown={handleTableInsertClick}
              onMouseEnter={clearTableInsertTimer}
              onMouseLeave={() => setTableInsertButton(null)}
              style={{
                position: "absolute",
                left: tableInsertButton.x,
                top: tableInsertButton.y,
                width: 20,
                height: 20,
                borderRadius: "4px",
                border: "1px solid var(--doc-border, #dadce0)",
                backgroundColor: "var(--doc-bg, #f8f9fa)",
                color: "var(--doc-text-muted, #5f6368)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                cursor: "pointer",
                zIndex: 200,
                padding: 0,
                boxShadow: "none",
              }}
              title={
                tableInsertButton.type === "row"
                  ? "Insert row below"
                  : "Insert column to the right"
              }
              aria-label={
                tableInsertButton.type === "row"
                  ? "Insert row below"
                  : "Insert column to the right"
              }
            >
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                <path
                  d="M6 1v10M1 6h10"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                />
              </svg>
            </button>
          )}
        </div>
      </div>

      {/* Sidebar overlay — inside scroll container, scrolls with document */}
      {sidebarOverlay}
    </div>
  );
}
