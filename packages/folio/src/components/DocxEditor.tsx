/**
 * DocxEditor Component
 *
 * Main component integrating all editor features:
 * - Toolbar for formatting
 * - ProseMirror-based editor for content editing
 * - Zoom control
 * - Error boundary
 * - Loading states
 */

import {
  useRef,
  useCallback,
  useState,
  useEffect,
  useMemo,
  forwardRef,
  useImperativeHandle,
  lazy,
  Suspense,
} from "react";
import type { CSSProperties, ReactNode } from "react";

import {
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  EyeIcon,
  MessageSquarePlusIcon,
  PenLineIcon,
  XIcon,
} from "lucide-react";
import type { Plugin as ProseMirrorPlugin } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { useTranslations } from "use-intl";

import {
  Select as StSelect,
  SelectItem as StSelectItem,
  SelectPopup as StSelectPopup,
  SelectTrigger as StSelectTrigger,
  SelectValue as StSelectValue,
} from "@stella/ui/components/select";

import { repackDocx } from "../core/docx/rezip";
import { attemptSelectiveSave } from "../core/docx/selectiveSave";
// ProseMirror editor
import {
  TextSelection,
  extractSelectionState,
  toggleBold,
  toggleItalic,
  toggleUnderline,
  toggleStrike,
  toggleSuperscript,
  toggleSubscript,
  setTextColor,
  clearTextColor,
  setHighlight,
  setFontSize,
  setFontFamily,
  setAlignment,
  setLineSpacing,
  toggleBulletList,
  toggleNumberedList,
  increaseIndent,
  decreaseIndent,
  increaseListLevel,
  decreaseListLevel,
  clearFormatting,
  applyStyle,
  createStyleResolver,
  getHyperlinkAttrs,
  getSelectedText,
  setRtl,
  setLtr,
  isInTable,
  getTableContext,
  addRowAbove,
  addRowBelow,
  deleteRow as pmDeleteRow,
  addColumnLeft,
  addColumnRight,
  deleteColumn as pmDeleteColumn,
  deleteTable as pmDeleteTable,
  selectTable as pmSelectTable,
  selectRow as pmSelectRow,
  selectColumn as pmSelectColumn,
  mergeCells as pmMergeCells,
  splitCell as pmSplitCell,
  setCellBorder,
  setCellVerticalAlign,
  setCellMargins,
  setCellTextDirection,
  toggleNoWrap,
  setRowHeight,
  toggleHeaderRow,
  distributeColumns,
  autoFitContents,
  setTableProperties,
  applyTableStyle,
  removeTableBorders,
  setAllTableBorders,
  setOutsideTableBorders,
  setInsideTableBorders,
  setCellFillColor,
  setTableBorderColor,
  setTableBorderWidth,
} from "../core/prosemirror";
import type { SelectionState, TableContextInfo } from "../core/prosemirror";
import {
  acceptChange,
  rejectChange,
  findChangeAtPosition,
  findNextChange,
  findPreviousChange,
} from "../core/prosemirror/commands/comments";
import { ExtensionManager } from "../core/prosemirror/extensions/ExtensionManager";
import {
  getChangedParagraphIds,
  hasStructuralChanges,
  hasUntrackedChanges,
  clearTrackedChanges,
} from "../core/prosemirror/extensions/features/ParagraphChangeTrackerExtension";
// Extension system
import { createStarterKit } from "../core/prosemirror/extensions/StarterKit";
import {
  createSuggestionModePlugin,
  setSuggestionMode,
} from "../core/prosemirror/plugins/suggestionMode";
import type { Comment } from "../core/types/content";
import type {
  Document,
  Theme,
  SectionProperties,
  TabStop,
  FootnoteProperties,
  EndnoteProperties,
} from "../core/types/document";
import { resolveColor } from "../core/utils/colorResolver";
import type { DocxInput } from "../core/utils/docxInput";
import { onFontsLoaded } from "../core/utils/fontLoader";
import type { HeadingInfo } from "../core/utils/headingCollector";
import { collectHeadings } from "../core/utils/headingCollector";
import { pointsToHalfPoints } from "../core/utils/units";
import { useDocumentHistory } from "../hooks/useHistory";
import { useTableSelection } from "../hooks/useTableSelection";
// Paginated editor
import { PagedEditor } from "../paged-editor/PagedEditor";
import type { PagedEditorRef } from "../paged-editor/PagedEditor";
// Plugin API types
import type { RenderedDomContext } from "../plugin-api/types";
import { CommentsSidebar } from "./CommentsSidebar";
import type { TrackedChangeEntry } from "./CommentsSidebar";
import { useHyperlinkDialog } from "./dialogs/HyperlinkDialog";
// Dialog hooks and utilities (static imports — lightweight, no UI)
import { useFindReplace as useFindReplaceState } from "./dialogs/useFindReplace";
import {
  DefaultLoadingIndicator,
  DefaultPlaceholder,
  ParseError,
} from "./DocxEditorHelpers";
import { ErrorBoundary, ErrorProvider } from "./ErrorBoundary";
import { FormattingBar } from "./FormattingBar";
import type { DocumentLoadState } from "./hooks/useDocumentLoader";
import { useDocumentLoader } from "./hooks/useDocumentLoader";
import { useFindReplace } from "./hooks/useFindReplace";
import { useHeaderFooterEditor } from "./hooks/useHeaderFooterEditor";
import { useHyperlinkHandlers } from "./hooks/useHyperlinkHandlers";
import { useImageHandlers } from "./hooks/useImageHandlers";
import { InlineHeaderFooterEditor } from "./InlineHeaderFooterEditor";
import type { InlineHeaderFooterEditorRef } from "./InlineHeaderFooterEditor";
import { TextContextMenu } from "./TextContextMenu";
import type { TextContextAction, TextContextMenuItem } from "./TextContextMenu";
import { ToolbarButton, ToolbarSeparator } from "./Toolbar";
import type { SelectionFormatting, FormattingAction } from "./Toolbar";
import { mapHexToHighlightName } from "./toolbarUtils";
import { HyperlinkPopup } from "./ui/HyperlinkPopup";
import { getBuiltinTableStyle } from "./ui/table-styles";
import type { TableStylePreset } from "./ui/table-styles";
import type { TableAction } from "./ui/table-types";
import { Tooltip } from "./ui/Tooltip";

// Toast stub — host app provides the real toast system.
// Uses a temporary DOM banner so the user sees feedback even without
// a toast provider (e.g., in the standalone playground).
const toast = (msg: string) => {
  const existing = document.querySelector("[data-folio-toast]");
  if (existing) {
    return;
  } // debounce rapid calls (e.g., key repeat)
  const el = document.createElement("div");
  el.dataset["folioToast"] = "";
  el.textContent = msg;
  Object.assign(el.style, {
    position: "fixed",
    bottom: "24px",
    left: "50%",
    transform: "translateX(-50%)",
    padding: "10px 20px",
    borderRadius: "8px",
    background: "var(--popover, #1f1f1f)",
    color: "var(--popover-foreground, #fff)",
    fontSize: "13px",
    boxShadow: "0 4px 12px var(--doc-shadow-lg, rgba(0,0,0,0.25))",
    zIndex: "9999",
    pointerEvents: "none",
    opacity: "0",
    transition: "opacity 200ms",
  });
  document.body.append(el);
  requestAnimationFrame(() => {
    el.style.opacity = "1";
  });
  setTimeout(() => {
    el.style.opacity = "0";
    setTimeout(() => el.remove(), 200);
  }, 3000);
};

// Dialog components (lazy-loaded — only fetched when first opened)
const FindReplaceDialog = lazy(() => import("./dialogs/FindReplaceDialog"));
const HyperlinkDialog = lazy(() => import("./dialogs/HyperlinkDialog"));
const TablePropertiesDialog = lazy(() =>
  import("./dialogs/TablePropertiesDialog").then((m) => ({
    default: m.TablePropertiesDialog,
  })),
);
const ImagePositionDialog = lazy(() =>
  import("./dialogs/ImagePositionDialog").then((m) => ({
    default: m.ImagePositionDialog,
  })),
);
const ImagePropertiesDialog = lazy(() =>
  import("./dialogs/ImagePropertiesDialog").then((m) => ({
    default: m.ImagePropertiesDialog,
  })),
);
const FootnotePropertiesDialog = lazy(() =>
  import("./dialogs/FootnotePropertiesDialog").then((m) => ({
    default: m.FootnotePropertiesDialog,
  })),
);
const PageSetupDialog = lazy(() =>
  import("./dialogs/PageSetupDialog").then((m) => ({
    default: m.PageSetupDialog,
  })),
);

// ============================================================================
// TYPES
// ============================================================================

/**
 * DocxEditor props
 */
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
  /** External ProseMirror plugins (from PluginHost) */
  externalPlugins?: ProseMirrorPlugin[];
  /** Callback when editor view is ready (for PluginHost) */
  onEditorViewReady?: (view: EditorView) => void;
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
  /** Whether tracked changes should auto-open the review sidebar (default: true) */
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
  /**
   * Callback when rendered DOM context is ready (for plugin overlays).
   * Used by PluginHost to get access to the rendered page DOM for positioning.
   */
  onRenderedDomContextReady?: (context: RenderedDomContext) => void;
  /**
   * Plugin overlays to render inside the editor viewport.
   * Passed from PluginHost to render plugin-specific overlays.
   */
  pluginOverlays?: ReactNode;
};

/**
 * DocxEditor ref interface
 */
export type DocxEditorRef = {
  /** Get the current document */
  getDocument: () => Document | null;
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
};

/**
 * Editor internal state
 */
type EditorState = {
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
  pmImageContext: {
    pos: number;
    wrapType: string;
    displayMode: string;
    cssFloat: string | null;
    transform: string | null;
    alt: string | null;
    borderWidth: number | null;
    borderColor: string | null;
    borderStyle: string | null;
  } | null;
  /** Active tracked change at cursor (for contextual toolbar) */
  activeTrackedChange: {
    type: "insertion" | "deletion";
    author: string;
    date: string | null;
    from: number;
    to: number;
  } | null;
};

// ============================================================================
// EDITING MODE DROPDOWN (Google Docs-style)
// ============================================================================

export type EditorMode = "editing" | "suggesting" | "viewing";

// ============================================================================
// DISPLAY MODE DROPDOWN (uses Stella Select)
// ============================================================================

type DisplayMode = "all-markup" | "simple-markup" | "no-markup" | "original";

// ============================================================================
// MAIN COMPONENT
// ============================================================================

let nextCommentId = Date.now();
const PENDING_COMMENT_ID = -1;
const EMPTY_ANCHOR_POSITIONS = new Map<string, number>();

/**
 * Find the Y position (relative to parentEl) of the element containing the given PM position.
 * Used by both the floating comment button and the context menu comment action.
 * Queries all elements with data-pm-start (spans, divs, imgs) — not just spans,
 * since table cell content may use div fragments.
 */
function findSelectionYPosition(
  scrollContainer: HTMLElement | null,
  parentEl: HTMLElement | null,
  pmPos: number,
): number | null {
  if (!scrollContainer || !parentEl) {
    return null;
  }
  const pagesEl = scrollContainer.querySelector(".paged-editor__pages");
  if (!pagesEl) {
    return null;
  }
  const elements = pagesEl.querySelectorAll("[data-pm-start]");
  for (const node of elements) {
    const el = node as HTMLElement;
    const pmStart = Number(el.dataset["pmStart"]);
    const pmEnd = Number(el.dataset["pmEnd"]);
    if (pmPos >= pmStart && pmPos <= pmEnd) {
      return (
        el.getBoundingClientRect().top - parentEl.getBoundingClientRect().top
      );
    }
  }
  return null;
}

function createComment(
  text: string,
  authorName: string,
  parentId?: number,
): Comment {
  return {
    id: nextCommentId++,
    author: authorName,
    date: new Date().toISOString(),
    content: [
      {
        type: "paragraph",
        formatting: {},
        content: [
          { type: "run", formatting: {}, content: [{ type: "text", text }] },
        ],
      },
    ],
    ...(parentId !== undefined && { parentId }),
  };
}

/**
 * DocxEditor - Complete DOCX editor component
 */
export const DocxEditor = forwardRef<DocxEditorRef, DocxEditorProps>(
  function DocxEditor(
    {
      documentBuffer,
      document: initialDocument,
      onSave,
      author = "User",
      onChange,
      onSelectionChange,
      onError,
      onFontsLoaded: onFontsLoadedCallback,
      theme,
      showToolbar = true,
      showZoomControl = true,
      showMarginGuides: _showMarginGuides = false,
      marginGuideColor: _marginGuideColor,
      initialZoom = 1,
      readOnly: readOnlyProp = false,
      autoOpenReviewSidebar = true,
      toolbarExtra,
      className = "",
      style,
      placeholder,
      loadingIndicator,
      initialScrollTop,
      onScrollTopChange,
      showOutline: showOutlineProp = false,
      onPrint,
      onCopy: _onCopy,
      onCut: _onCut,
      onPaste: _onPaste,
      mode: modeProp,
      onModeChange,
      externalPlugins,
      onEditorViewReady,
      onRenderedDomContextReady,
      pluginOverlays,
    },
    ref,
  ) {
    const t = useTranslations("folio");

    // State
    const [state, setState] = useState<EditorState>({
      documentLoad: documentBuffer
        ? { status: "loading" }
        : { status: "ready" },
      zoom: initialZoom,
      selectionFormatting: {},
      paragraphIndentLeft: 0,
      paragraphIndentRight: 0,
      paragraphFirstLineIndent: 0,
      paragraphHangingIndent: false,
      paragraphTabs: null,
      pmTableContext: null,
      pmImageContext: null,
      activeTrackedChange: null,
    });

    // Table properties dialog state
    const [tablePropsOpen, setTablePropsOpen] = useState(false);
    // Footnote properties dialog state
    const [footnotePropsOpen, setFootnotePropsOpen] = useState(false);
    // Document outline sidebar state
    const [showOutline, setShowOutline] = useState(showOutlineProp);
    const showOutlineRef = useRef(false);
    showOutlineRef.current = showOutline;
    const [_outlineHeadings, setHeadingInfos] = useState<HeadingInfo[]>([]);

    // Comments sidebar state
    const [showCommentsSidebar, setShowCommentsSidebar] = useState(false);
    const [comments, setComments] = useState<Comment[]>([]);
    const [, setTrackedChanges] = useState<TrackedChangeEntry[]>([]);
    const [anchorPositions, setAnchorPositions] = useState<Map<string, number>>(
      EMPTY_ANCHOR_POSITIONS,
    );

    const [isAddingComment, setIsAddingComment] = useState(false);
    const [commentSelectionRange, setCommentSelectionRange] = useState<{
      from: number;
      to: number;
    } | null>(null);
    const [addCommentYPosition, setAddCommentYPosition] = useState<
      number | null
    >(null);
    const [editingModeInternal, setEditingModeInternal] = useState<EditorMode>(
      modeProp ?? "editing",
    );
    const editingMode = modeProp ?? editingModeInternal;
    const setEditingMode = useCallback(
      (mode: EditorMode) => {
        if (!modeProp) {
          setEditingModeInternal(mode);
        }
        onModeChange?.(mode);
      },
      [modeProp, onModeChange],
    );
    // 'viewing' mode acts as read-only
    const readOnly = readOnlyProp || editingMode === "viewing";

    // Track Changes display mode
    const [displayMode, setDisplayMode] = useState<DisplayMode>("all-markup");
    const trackChangesOn = editingMode === "suggesting";

    const toggleTrackChanges = useCallback(() => {
      setEditingMode(trackChangesOn ? "editing" : "suggesting");
    }, [setEditingMode, trackChangesOn]);

    // Floating "add comment" button position (relative to scroll container, null = hidden)
    const [floatingCommentBtn, setFloatingCommentBtn] = useState<{
      top: number;
      left: number;
    } | null>(null);

    // Right-click context menu state
    const [contextMenu, setContextMenu] = useState<{
      isOpen: boolean;
      position: { x: number; y: number };
      hasSelection: boolean;
      selectionRange: { from: number; to: number };
      cursorInTable: boolean;
      cursorInTrackedChange: boolean;
    }>({
      isOpen: false,
      position: { x: 0, y: 0 },
      hasSelection: false,
      selectionRange: { from: 0, to: 0 },
      cursorInTable: false,
      cursorInTrackedChange: false,
    });

    // Debounce timer for extractTrackedChanges (avoid full doc walk on every keystroke)
    const extractTrackedChangesTimerRef = useRef<ReturnType<
      typeof setTimeout
    > | null>(null);

    // Extract tracked changes from ProseMirror state
    const extractTrackedChanges = useCallback(() => {
      const view = pagedEditorRef.current?.getView();
      if (!view) {
        return;
      }
      const { doc, schema } = view.state;
      const insertionType = schema.marks["insertion"];
      const deletionType = schema.marks["deletion"];
      if (!insertionType && !deletionType) {
        return;
      }

      const raw: TrackedChangeEntry[] = [];
      doc.descendants((node, pos) => {
        if (!node.isText) {
          return;
        }
        for (const mark of node.marks) {
          if (mark.type === insertionType || mark.type === deletionType) {
            const entry: TrackedChangeEntry = {
              type: mark.type === insertionType ? "insertion" : "deletion",
              text: node.text || "",
              author: (mark.attrs["author"] as string) || "",
              from: pos,
              to: pos + node.nodeSize,
              revisionId: mark.attrs["revisionId"] as number,
            };
            if (mark.attrs["date"]) {
              entry.date = mark.attrs["date"] as string;
            }
            raw.push(entry);
          }
        }
      });

      // Merge adjacent entries with the same revisionId and type into one
      const merged: TrackedChangeEntry[] = [];
      for (const entry of raw) {
        const last = merged.at(-1);
        if (
          last &&
          last.revisionId === entry.revisionId &&
          last.type === entry.type &&
          last.to === entry.from
        ) {
          last.text += entry.text;
          last.to = entry.to;
        } else {
          merged.push({ ...entry });
        }
      }
      setTrackedChanges(merged);
    }, []);

    // Clean up debounce timer on unmount
    useEffect(
      () => () => {
        if (extractTrackedChangesTimerRef.current) {
          clearTimeout(extractTrackedChangesTimerRef.current);
        }
      },
      [],
    );

    // Sync outline visibility when prop changes
    useEffect(() => {
      setShowOutline(showOutlineProp);
      if (showOutlineProp) {
        const view = pagedEditorRef.current?.getView();
        if (view) {
          setHeadingInfos(collectHeadings(view.state.doc));
        }
      }
    }, [showOutlineProp]);

    // History hook for undo/redo - start with null document
    const history = useDocumentHistory<Document | null>(
      initialDocument || null,
      {
        maxEntries: 100,
        groupingInterval: 500,
        enableKeyboardShortcuts: true,
      },
    );

    // Extract comments from document model on initial load
    const commentsLoadedRef = useRef(false);
    useEffect(() => {
      if (commentsLoadedRef.current) {
        return;
      }
      const doc = history.state;
      if (!doc) {
        return;
      }
      const bodyComments = doc.package?.document?.comments;
      if (bodyComments && bodyComments.length > 0) {
        setComments(bodyComments);
        setShowCommentsSidebar(true);
        commentsLoadedRef.current = true;
      }
    }, [history.state]);

    // Extension manager — built once, provides schema + plugins + commands
    const extensionManager = useMemo(() => {
      const mgr = new ExtensionManager(createStarterKit());
      mgr.buildSchema();
      mgr.initializeRuntime();
      return mgr;
    }, []);

    // Suggestion mode plugin — merged with external plugins
    const suggestionPlugin = useMemo(
      () => createSuggestionModePlugin(editingMode === "suggesting", author),
      [], // eslint-disable-line react-hooks/exhaustive-deps
    );
    const allExternalPlugins = useMemo(
      () => [suggestionPlugin, ...(externalPlugins ?? [])],
      [suggestionPlugin, externalPlugins],
    );

    // Refs
    const pagedEditorRef = useRef<PagedEditorRef>(null);
    const hfEditorRef = useRef<InlineHeaderFooterEditorRef>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    // Save the last known selection for restoring after toolbar interactions
    const lastSelectionRef = useRef<{ from: number; to: number } | null>(null);
    const imageInputRef = useRef<HTMLInputElement>(null);
    const editorContentRef = useRef<HTMLDivElement>(null);
    const scrollContainerRef = useRef<HTMLDivElement>(null);
    const toolbarWrapperRef = useRef<HTMLDivElement>(null);
    const toolbarRoRef = useRef<ResizeObserver | null>(null);
    const [_toolbarHeight, setToolbarHeight] = useState(0);
    // Keep history.state accessible in stable callbacks without stale closures
    const historyStateRef = useRef(history.state);
    historyStateRef.current = history.state;
    // Track current border color/width for border presets (like Google Docs)
    const borderSpecRef = useRef({
      style: "single",
      size: 4,
      color: { rgb: "000000" },
    });
    // Cache style resolver to avoid recreating on every selection change
    const styleResolverCacheRef = useRef<{
      styles: unknown;
      resolver: ReturnType<typeof createStyleResolver>;
    } | null>(null);
    const getCachedStyleResolver = useCallback(
      (styles: Parameters<typeof createStyleResolver>[0]) => {
        const cached = styleResolverCacheRef.current;
        if (cached && cached.styles === styles) {
          return cached.resolver;
        }
        const resolver = createStyleResolver(styles);
        styleResolverCacheRef.current = { styles, resolver };
        return resolver;
      },
      [],
    );

    // Scroll-based page indicator (Google Docs style)
    const [scrollPageInfo, setScrollPageInfo] = useState<{
      currentPage: number;
      totalPages: number;
      visible: boolean;
    }>({ currentPage: 1, totalPages: 1, visible: false });
    const [bodyHistoryAvailability, setBodyHistoryAvailability] = useState({
      canRedo: false,
      canUndo: false,
    });
    const scrollFadeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
      null,
    );

    // Measure toolbar height for positioning the outline panel below it
    const toolbarRefCallback = useCallback((el: HTMLDivElement | null) => {
      toolbarWrapperRef.current = el;
      // Clean up previous observer
      if (toolbarRoRef.current) {
        toolbarRoRef.current.disconnect();
        toolbarRoRef.current = null;
      }
      if (!el) {
        setToolbarHeight(0);
        return;
      }
      setToolbarHeight(el.offsetHeight);
      const ro = new ResizeObserver(() => {
        setToolbarHeight(el.offsetHeight);
      });
      ro.observe(el);
      toolbarRoRef.current = ro;
    }, []);

    // Cleanup ResizeObserver on unmount
    useEffect(
      () => () => {
        toolbarRoRef.current?.disconnect();
      },
      [],
    );

    const pushDocument = useCallback(
      (document: Document) => {
        history.push(document);
        return document;
      },
      [history],
    );

    const refreshBodyHistoryAvailability = useCallback(() => {
      const canUndo = pagedEditorRef.current?.canUndo() ?? false;
      const canRedo = pagedEditorRef.current?.canRedo() ?? false;
      setBodyHistoryAvailability((prev) =>
        prev.canUndo === canUndo && prev.canRedo === canRedo
          ? prev
          : { canUndo, canRedo },
      );
    }, []);

    // Header/footer editing state + content resolution + mutation callbacks
    const {
      hfEditPosition,
      setHfEditPosition,
      hfEditIsFirstPage,
      headerContent,
      footerContent,
      firstPageHeaderContent,
      firstPageFooterContent,
      effectiveSectionProperties,
      handleHeaderFooterDoubleClick,
      handleHeaderFooterSave,
      handleBodyClick,
      handleRemoveHeaderFooter,
    } = useHeaderFooterEditor({ history, pushDocument, hfEditorRef });

    // Helper to get the active editor's view — returns HF editor view when in HF editing mode
    const getActiveEditorView = useCallback(() => {
      if (hfEditPosition && hfEditorRef.current) {
        return hfEditorRef.current.getView();
      }
      return pagedEditorRef.current?.getView();
    }, [hfEditPosition]);

    // Helper to focus the active editor
    const focusActiveEditor = useCallback(() => {
      if (hfEditPosition && hfEditorRef.current) {
        hfEditorRef.current.focus();
      } else {
        pagedEditorRef.current?.focus();
      }
    }, [hfEditPosition]);

    // Helper to undo in the active editor
    const undoActiveEditor = useCallback(() => {
      if (hfEditPosition && hfEditorRef.current) {
        hfEditorRef.current.undo();
      } else {
        pagedEditorRef.current?.undo();
        requestAnimationFrame(refreshBodyHistoryAvailability);
      }
    }, [hfEditPosition, refreshBodyHistoryAvailability]);

    // Helper to redo in the active editor
    const redoActiveEditor = useCallback(() => {
      if (hfEditPosition && hfEditorRef.current) {
        hfEditorRef.current.redo();
      } else {
        pagedEditorRef.current?.redo();
        requestAnimationFrame(refreshBodyHistoryAvailability);
      }
    }, [hfEditPosition, refreshBodyHistoryAvailability]);

    // Find/Replace hook
    const findReplace = useFindReplaceState();

    // Hyperlink dialog hook
    const hyperlinkDialog = useHyperlinkDialog();

    // Page setup dialog state
    const [showPageSetup, setShowPageSetup] = useState(false);

    // Hyperlink handlers (dialog submit, popup state, navigation, etc.)
    const {
      hyperlinkPopupData,
      handleHyperlinkSubmit,
      handleHyperlinkRemove,
      handleHyperlinkClick,
      handleHyperlinkPopupNavigate,
      handleHyperlinkPopupCopy,
      handleHyperlinkPopupEdit,
      handleHyperlinkPopupRemove,
      handleHyperlinkPopupClose,
    } = useHyperlinkHandlers({
      getActiveEditorView,
      focusActiveEditor,
      hyperlinkDialog,
    });

    const {
      imagePositionOpen,
      setImagePositionOpen,
      imagePropsOpen,
      setImagePropsOpen,
      handleImageFileChange,
      handleImageWrapType,
      handleImageTransform,
      handleApplyImagePosition,
      handleOpenImageProperties,
      handleApplyImageProperties,
    } = useImageHandlers({
      getActiveEditorView,
      focusActiveEditor,
      pmImageContext: state.pmImageContext,
    });

    // Document loading (parse buffer, reset UI, keep original buffer for save)
    const { loadBuffer, loadParsedDocument, originalBufferRef } =
      useDocumentLoader({
        documentBuffer: documentBuffer ?? null,
        initialDocument: initialDocument ?? null,
        history,
        onError,
        onReset: useCallback(() => {
          commentsLoadedRef.current = false;
          trackedChangesLoadedRef.current = false;
          setComments([]);
          setTrackedChanges([]);
          setHeadingInfos([]);
          setShowCommentsSidebar(false);
          setIsAddingComment(false);
          setCommentSelectionRange(null);
          setAddCommentYPosition(null);
          setFloatingCommentBtn(null);
          setHfEditPosition(null);
          setAnchorPositions(EMPTY_ANCHOR_POSITIONS);
          findReplace.setMatches([], 0);
          if (extractTrackedChangesTimerRef.current) {
            clearTimeout(extractTrackedChangesTimerRef.current);
            extractTrackedChangesTimerRef.current = null;
          }
        }, [findReplace, setHfEditPosition]),
        setDocumentLoadState: useCallback((documentLoad: DocumentLoadState) => {
          setState((prev) => ({ ...prev, documentLoad }));
        }, []),
      });

    // Extract tracked changes once PM view is ready (after loading completes)
    const trackedChangesLoadedRef = useRef(false);
    useEffect(() => {
      if (state.documentLoad.status === "ready" && history.state) {
        const timer = setTimeout(() => {
          extractTrackedChanges();
          // Auto-open sidebar once on initial load
          if (!trackedChangesLoadedRef.current) {
            trackedChangesLoadedRef.current = true;
            // Check if we just populated tracked changes
            setTrackedChanges((prev) => {
              if (autoOpenReviewSidebar && prev.length > 0) {
                setShowCommentsSidebar(true);
              }
              return prev;
            });
          }
        }, 200);
        return () => clearTimeout(timer);
      }
      return undefined;
    }, [
      state.documentLoad.status,
      history.state,
      extractTrackedChanges,
      autoOpenReviewSidebar,
    ]);

    const initialScrollAppliedRef = useRef(false);
    useEffect(() => {
      if (
        initialScrollTop === undefined ||
        state.documentLoad.status !== "ready" ||
        initialScrollAppliedRef.current
      ) {
        return undefined;
      }

      initialScrollAppliedRef.current = true;
      const frame = requestAnimationFrame(() => {
        if (scrollContainerRef.current) {
          scrollContainerRef.current.scrollTop = initialScrollTop;
        }
      });

      return () => {
        cancelAnimationFrame(frame);
      };
    }, [initialScrollTop, state.documentLoad.status]);

    // Listen for font loading
    useEffect(() => {
      const cleanup = onFontsLoaded(() => {
        onFontsLoadedCallback?.();
      });
      return cleanup;
    }, [onFontsLoadedCallback]);

    // Sync editing mode to ProseMirror suggestion mode plugin
    useEffect(() => {
      const view = pagedEditorRef.current?.getView();
      if (view) {
        setSuggestionMode(
          editingMode === "suggesting",
          view.state,
          view.dispatch,
          author,
        );
      }
    }, [editingMode, author]);

    // Handle document change
    const handleDocumentChange = useCallback(
      (newDocument: Document) => {
        pushDocument(newDocument);
        onChange?.(newDocument);
        // Update outline headings if sidebar is open
        if (showOutlineRef.current) {
          const view = pagedEditorRef.current?.getView();
          if (view) {
            setHeadingInfos(collectHeadings(view.state.doc));
          }
        }
        // Re-extract tracked changes after document change (debounced to avoid
        // full-document walk on every keystroke in suggestion mode)
        if (extractTrackedChangesTimerRef.current) {
          clearTimeout(extractTrackedChangesTimerRef.current);
        }
        extractTrackedChangesTimerRef.current = setTimeout(
          extractTrackedChanges,
          300,
        );
        requestAnimationFrame(refreshBodyHistoryAvailability);
      },
      [
        onChange,
        pushDocument,
        extractTrackedChanges,
        refreshBodyHistoryAvailability,
      ],
    );

    // Find/Replace handlers (depends on handleDocumentChange)
    const {
      findResultRef,
      handleFind,
      handleFindNext,
      handleFindPrevious,
      handleReplace,
      handleReplaceAll,
    } = useFindReplace({
      documentState: history.state,
      containerRef,
      handleDocumentChange,
      findReplace,
    });

    // Handle selection changes from ProseMirror
    const handleSelectionChange = useCallback(
      (selectionState: SelectionState | null) => {
        // Save selection for restoring after toolbar interactions
        const view = getActiveEditorView();
        if (view) {
          const { from, to } = view.state.selection;
          lastSelectionRef.current = { from, to };
        }

        // Also check table context from ProseMirror
        let pmTableCtx: TableContextInfo | null = null;
        if (view) {
          pmTableCtx = getTableContext(view.state);
          if (!pmTableCtx.isInTable) {
            pmTableCtx = null;
          }
        }

        // Sync borderSpecRef with the current cell's actual border color
        if (pmTableCtx?.cellBorderColor) {
          const colorVal = pmTableCtx.cellBorderColor;
          // Resolve theme/auto colors to hex
          let rgb = colorVal.rgb;
          if (!rgb || rgb === "auto") {
            const resolved = resolveColor(colorVal, theme);
            rgb = resolved.replace(/^#/, "");
          }
          borderSpecRef.current = {
            ...borderSpecRef.current,
            color: { rgb },
          };
        }

        // Check if cursor is on an image (NodeSelection)
        let pmImageCtx: typeof state.pmImageContext = null;
        if (view) {
          const sel = view.state.selection;
          // NodeSelection has a `node` property
          const selectedNode = (
            sel as {
              node?: { type: { name: string }; attrs: Record<string, unknown> };
            }
          ).node;
          if (selectedNode?.type.name === "image") {
            pmImageCtx = {
              pos: sel.from,
              wrapType: (selectedNode.attrs["wrapType"] as string) ?? "inline",
              displayMode:
                (selectedNode.attrs["displayMode"] as string) ?? "inline",
              cssFloat: (selectedNode.attrs["cssFloat"] as string) ?? null,
              transform: (selectedNode.attrs["transform"] as string) ?? null,
              alt: (selectedNode.attrs["alt"] as string) ?? null,
              borderWidth:
                (selectedNode.attrs["borderWidth"] as number) ?? null,
              borderColor:
                (selectedNode.attrs["borderColor"] as string) ?? null,
              borderStyle:
                (selectedNode.attrs["borderStyle"] as string) ?? null,
            };
          }
        }

        // Detect tracked change at cursor position
        let trackedChange: EditorState["activeTrackedChange"] = null;
        if (view) {
          const { from } = view.state.selection;
          const $pos = view.state.doc.resolve(from);
          const node = $pos.parent;
          if (node.isTextblock) {
            // oxlint-disable-next-line unicorn/no-array-for-each -- ProseMirror Node.forEach
            node.forEach((child, offset) => {
              const childStart = $pos.start() + offset;
              const childEnd = childStart + child.nodeSize;
              if (from >= childStart && from <= childEnd && child.isText) {
                for (const mark of child.marks) {
                  if (
                    mark.type.name === "insertion" ||
                    mark.type.name === "deletion"
                  ) {
                    // Expand to full change range
                    const range = findChangeAtPosition(view.state, from, from);
                    trackedChange = {
                      type: mark.type.name as "insertion" | "deletion",
                      author: (mark.attrs["author"] as string) || "Unknown",
                      date: (mark.attrs["date"] as string) || null,
                      from: range.from,
                      to: range.to,
                    };
                  }
                }
              }
            });
          }
        }

        if (!selectionState) {
          setFloatingCommentBtn(null);
          setState((prev) => ({
            ...prev,
            selectionFormatting: {},
            pmTableContext: pmTableCtx,
            pmImageContext: pmImageCtx,
            activeTrackedChange: trackedChange,
          }));
          return;
        }

        // Update toolbar formatting from ProseMirror selection
        const { textFormatting, paragraphFormatting } = selectionState;

        // Extract font family (prefer ascii, fall back to hAnsi)
        let fontFamily =
          textFormatting.fontFamily?.ascii || textFormatting.fontFamily?.hAnsi;
        let fontSize = textFormatting.fontSize;

        // If no explicit font/size marks, resolve from paragraph style or document defaults
        if (!fontFamily || !fontSize) {
          const currentDoc = historyStateRef.current;
          const paraStyleId = selectionState.styleId;
          if (currentDoc?.package.styles && paraStyleId) {
            const resolver = getCachedStyleResolver(currentDoc.package.styles);
            const resolved = resolver.resolveParagraphStyle(paraStyleId);
            if (!fontFamily && resolved.runFormatting?.fontFamily) {
              fontFamily =
                resolved.runFormatting.fontFamily.ascii ||
                resolved.runFormatting.fontFamily.hAnsi;
            }
            if (!fontSize && resolved.runFormatting?.fontSize) {
              fontSize = resolved.runFormatting.fontSize;
            }
          }
        }

        // Extract text color as hex string
        const textColor = textFormatting.color?.rgb
          ? `#${textFormatting.color.rgb}`
          : undefined;

        // Build list state from numPr
        const numPr = paragraphFormatting.numPr;
        let listState: SelectionFormatting["listState"];
        if (numPr) {
          const ls: NonNullable<SelectionFormatting["listState"]> = {
            type: (numPr.numId === 1 ? "bullet" : "numbered") as
              | "bullet"
              | "numbered",
            level: numPr.ilvl ?? 0,
            isInList: true,
          };
          if (numPr.numId !== undefined) {
            ls.numId = numPr.numId;
          }
          listState = ls;
        }

        const formatting: SelectionFormatting = {
          underline: !!textFormatting.underline,
          superscript: textFormatting.vertAlign === "superscript",
          subscript: textFormatting.vertAlign === "subscript",
          bidi: !!paragraphFormatting.bidi,
        };
        if (textFormatting.bold !== undefined) {
          formatting.bold = textFormatting.bold;
        }
        if (textFormatting.italic !== undefined) {
          formatting.italic = textFormatting.italic;
        }
        if (textFormatting.strike !== undefined) {
          formatting.strike = textFormatting.strike;
        }
        if (fontFamily !== undefined) {
          formatting.fontFamily = fontFamily;
        }
        if (fontSize !== undefined) {
          formatting.fontSize = fontSize;
        }
        if (textColor !== undefined) {
          formatting.color = textColor;
        }
        if (textFormatting.highlight !== undefined) {
          formatting.highlight = textFormatting.highlight;
        }
        if (paragraphFormatting.alignment !== undefined) {
          formatting.alignment = paragraphFormatting.alignment;
        }
        if (paragraphFormatting.lineSpacing !== undefined) {
          formatting.lineSpacing = paragraphFormatting.lineSpacing;
        }
        if (listState !== undefined) {
          formatting.listState = listState;
        }
        if (selectionState.styleId) {
          formatting.styleId = selectionState.styleId;
        }
        if (paragraphFormatting.indentLeft !== undefined) {
          formatting.indentLeft = paragraphFormatting.indentLeft;
        }
        setState((prev) => ({
          ...prev,
          selectionFormatting: formatting,
          paragraphIndentLeft: paragraphFormatting.indentLeft ?? 0,
          paragraphIndentRight: paragraphFormatting.indentRight ?? 0,
          paragraphFirstLineIndent: paragraphFormatting.indentFirstLine ?? 0,
          paragraphHangingIndent: paragraphFormatting.hangingIndent ?? false,
          paragraphTabs: paragraphFormatting.tabs ?? null,
          pmTableContext: pmTableCtx,
          pmImageContext: pmImageCtx,
          activeTrackedChange: trackedChange,
        }));

        // Update floating comment button position
        if (
          view &&
          selectionState.hasSelection &&
          !isAddingComment &&
          !readOnly
        ) {
          const container = scrollContainerRef.current;
          const parentEl = editorContentRef.current;
          const { from: selFrom } = view.state.selection;
          const top = findSelectionYPosition(container, parentEl, selFrom);
          if (top !== null && top !== undefined && container && parentEl) {
            const pagesEl = container.querySelector(".paged-editor__pages");
            const pageEl = pagesEl?.querySelector(
              ".layout-page",
            ) as HTMLElement | null;
            const parentRect = parentEl.getBoundingClientRect();
            const rawLeft = pageEl
              ? pageEl.getBoundingClientRect().right - parentRect.left + 12
              : parentRect.width / 2 + 408;
            const left = Math.max(16, Math.min(rawLeft, parentRect.width - 16));
            setFloatingCommentBtn({ top, left });
          }
        } else {
          setFloatingCommentBtn(null);
        }

        // Notify parent
        onSelectionChange?.(selectionState);
      },
      // oxlint-disable-next-line react-hooks/exhaustive-deps
      [onSelectionChange, isAddingComment, readOnly],
    );

    // Table selection hook
    const tableSelection = useTableSelection({
      document: history.state,
      onChange: handleDocumentChange,
      onSelectionChange: (_context) => {
        // Could notify parent of table selection changes
      },
    });

    const handleDirectPrint = useCallback(() => {
      if (onPrint) {
        onPrint();
        return;
      }

      const pages = containerRef.current?.querySelector(".paged-editor__pages");
      if (!pages) {
        toast(t("printRedirect"));
        return;
      }

      const iframe = document.createElement("iframe");
      iframe.style.position = "fixed";
      iframe.style.width = "0";
      iframe.style.height = "0";
      iframe.style.border = "0";
      iframe.style.opacity = "0";
      iframe.style.pointerEvents = "none";
      document.body.append(iframe);

      const printDocument = iframe.contentDocument;
      const printWindow = iframe.contentWindow;
      if (!printDocument || !printWindow) {
        iframe.remove();
        toast(t("printRedirect"));
        return;
      }

      const styles = [
        ...document.querySelectorAll('style, link[rel="stylesheet"]'),
      ]
        .map((node) => node.outerHTML)
        .join("\n");
      const pagesClone = pages.cloneNode(true) as HTMLElement;
      const overlays = pagesClone.querySelectorAll(
        ".selection-overlay, .layout-selection-overlay, .image-selection-overlay",
      );
      for (const node of overlays) {
        node.remove();
      }

      printDocument.open();
      printDocument.write(`<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    ${styles}
    <style>
      @page { margin: 0; }
      html, body {
        margin: 0;
        background: white;
      }
      * {
        -webkit-print-color-adjust: exact;
        print-color-adjust: exact;
      }
      .paged-editor__pages {
        display: block !important;
        margin: 0 auto !important;
        background: white !important;
      }
      .layout-page {
        break-after: page;
        page-break-after: always;
        border: 0 !important;
        box-shadow: none !important;
        margin: 0 auto !important;
        outline: 0 !important;
      }
      .layout-page:last-child {
        break-after: auto;
        page-break-after: auto;
      }
    </style>
  </head>
  <body>${pagesClone.outerHTML}</body>
</html>`);
      printDocument.close();

      let isCleanedUp = false;
      const cleanup = () => {
        if (isCleanedUp) {
          return;
        }
        isCleanedUp = true;
        iframe.remove();
      };
      printWindow.addEventListener("afterprint", cleanup, { once: true });
      setTimeout(cleanup, 5 * 60 * 1000);

      const waitForFrameLoad = async () =>
        await new Promise<void>((resolve) => {
          if (printDocument.readyState === "complete") {
            resolve();
            return;
          }

          iframe.addEventListener("load", () => resolve(), { once: true });
          setTimeout(resolve, 1000);
        });

      const waitForFonts = async () =>
        await Promise.race([
          printDocument.fonts.ready.catch(() => undefined),
          new Promise((resolve) => {
            setTimeout(resolve, 1000);
          }),
        ]);

      void (async () => {
        await waitForFrameLoad();
        await waitForFonts();
        if (isCleanedUp) {
          return;
        }
        printWindow.focus();
        printWindow.print();
      })();
    }, [onPrint, t]);

    // Keyboard shortcuts for Find/Replace (Ctrl+F, Ctrl+H) and delete table selection
    useEffect(() => {
      const handleKeyDown = (e: KeyboardEvent) => {
        // Check for Ctrl+F (Find) or Ctrl+H (Replace)
        const isMac = navigator.platform.toUpperCase().includes("MAC");
        const cmdOrCtrl = isMac ? e.metaKey : e.ctrlKey;

        // Delete selected table from layout selection (non-ProseMirror selection)
        if (
          !cmdOrCtrl &&
          !e.shiftKey &&
          !e.altKey &&
          (e.key === "Delete" || e.key === "Backspace")
        ) {
          // If full table is selected via ProseMirror CellSelection, delete it.
          const view = pagedEditorRef.current?.getView();
          if (view) {
            const sel = view.state.selection as {
              $anchorCell?: unknown;
              forEachCell?: unknown;
            };
            const isCellSel =
              "$anchorCell" in sel && typeof sel.forEachCell === "function";
            if (isCellSel) {
              const context = getTableContext(view.state);
              if (context.isInTable && context.table) {
                let totalCells = 0;
                context.table.descendants((node) => {
                  if (
                    node.type.name === "tableCell" ||
                    node.type.name === "tableHeader"
                  ) {
                    totalCells += 1;
                  }
                });
                let selectedCells = 0;
                (sel as { forEachCell: (fn: () => void) => void }).forEachCell(
                  () => {
                    selectedCells += 1;
                  },
                );
                if (totalCells > 0 && selectedCells >= totalCells) {
                  e.preventDefault();
                  pmDeleteTable(view.state, view.dispatch);
                  return;
                }
              }
            }
          }

          if (tableSelection.state.tableIndex !== null) {
            e.preventDefault();
            tableSelection.handleAction("deleteTable");
            return;
          }
        }

        if (cmdOrCtrl && !e.shiftKey && !e.altKey) {
          if (e.key.toLowerCase() === "f") {
            e.preventDefault();
            // Get selected text if any
            const selection = window.getSelection();
            const selectedText =
              selection && !selection.isCollapsed ? selection.toString() : "";
            findReplace.openFind(selectedText);
          } else if (e.key.toLowerCase() === "h") {
            e.preventDefault();
            // Get selected text if any
            const selection = window.getSelection();
            const selectedText =
              selection && !selection.isCollapsed ? selection.toString() : "";
            findReplace.openReplace(selectedText);
          } else if (e.key.toLowerCase() === "p" && !e.repeat) {
            e.preventDefault();
            handleDirectPrint();
          } else if (e.key.toLowerCase() === "k") {
            e.preventDefault();
            // Open hyperlink dialog
            const view = pagedEditorRef.current?.getView();
            if (view) {
              const selectedText = getSelectedText(view.state);
              const existingLink = getHyperlinkAttrs(view.state);
              if (existingLink) {
                const linkData: import("./dialogs/HyperlinkDialog").HyperlinkData =
                  {
                    url: existingLink.href,
                    displayText: selectedText,
                  };
                if (existingLink.tooltip) {
                  linkData.tooltip = existingLink.tooltip;
                }
                hyperlinkDialog.openEdit(linkData);
              } else {
                hyperlinkDialog.openInsert(selectedText);
              }
            }
          }
        }
      };

      document.addEventListener("keydown", handleKeyDown);
      return () => {
        document.removeEventListener("keydown", handleKeyDown);
      };
    }, [findReplace, handleDirectPrint, hyperlinkDialog, tableSelection]);

    // Handle footnote/endnote properties update
    const handleApplyFootnoteProperties = useCallback(
      (footnotePr: FootnoteProperties, endnotePr: EndnoteProperties) => {
        if (!history.state?.package) {
          return;
        }
        const newDoc = {
          ...history.state.package.document,
          finalSectionProperties: {
            ...history.state.package.document.finalSectionProperties,
            footnotePr,
            endnotePr,
          },
        };
        pushDocument({
          ...history.state,
          package: {
            ...history.state.package,
            document: newDoc,
          },
        });
      },
      [history, pushDocument],
    );

    // Handle table action from Toolbar - use ProseMirror commands
    const handleTableAction = useCallback(
      (action: TableAction) => {
        const view = getActiveEditorView();
        if (!view) {
          return;
        }

        switch (action) {
          case "addRowAbove":
            addRowAbove(view.state, view.dispatch);
            break;
          case "addRowBelow":
            addRowBelow(view.state, view.dispatch);
            break;
          case "addColumnLeft":
            addColumnLeft(view.state, view.dispatch);
            break;
          case "addColumnRight":
            addColumnRight(view.state, view.dispatch);
            break;
          case "deleteRow":
            pmDeleteRow(view.state, view.dispatch);
            break;
          case "deleteColumn":
            pmDeleteColumn(view.state, view.dispatch);
            break;
          case "deleteTable":
            pmDeleteTable(view.state, view.dispatch);
            break;
          case "selectTable":
            pmSelectTable(view.state, view.dispatch);
            break;
          case "selectRow":
            pmSelectRow(view.state, view.dispatch);
            break;
          case "selectColumn":
            pmSelectColumn(view.state, view.dispatch);
            break;
          case "mergeCells":
            pmMergeCells(view.state, view.dispatch);
            break;
          case "splitCell":
            pmSplitCell(view.state, view.dispatch);
            break;
          // Border actions — use current border spec from toolbar
          case "borderAll":
            setAllTableBorders(
              view.state,
              view.dispatch,
              borderSpecRef.current,
            );
            break;
          case "borderOutside":
            setOutsideTableBorders(
              view.state,
              view.dispatch,
              borderSpecRef.current,
            );
            break;
          case "borderInside":
            setInsideTableBorders(
              view.state,
              view.dispatch,
              borderSpecRef.current,
            );
            break;
          case "borderNone":
            removeTableBorders(view.state, view.dispatch);
            break;
          // Per-side border actions (use current border spec)
          case "borderTop":
            setCellBorder(
              "top",
              borderSpecRef.current,
              true,
            )(view.state, view.dispatch);
            break;
          case "borderBottom":
            setCellBorder(
              "bottom",
              borderSpecRef.current,
              true,
            )(view.state, view.dispatch);
            break;
          case "borderLeft":
            setCellBorder(
              "left",
              borderSpecRef.current,
              true,
            )(view.state, view.dispatch);
            break;
          case "borderRight":
            setCellBorder(
              "right",
              borderSpecRef.current,
              true,
            )(view.state, view.dispatch);
            break;
          default:
            // Handle complex actions (with parameters)
            if (typeof action === "object") {
              if (action.type === "cellFillColor") {
                setCellFillColor(action.color)(view.state, view.dispatch);
              } else if (action.type === "borderColor") {
                const rgb = action.color.replace(/^#/, "");
                borderSpecRef.current = {
                  ...borderSpecRef.current,
                  color: { rgb },
                };
                setTableBorderColor(action.color)(view.state, view.dispatch);
              } else if (action.type === "borderWidth") {
                borderSpecRef.current = {
                  ...borderSpecRef.current,
                  size: action.size,
                };
                setTableBorderWidth(action.size)(view.state, view.dispatch);
              } else if (action.type === "cellBorder") {
                setCellBorder(action.side, {
                  style: action.style,
                  size: action.size,
                  color: { rgb: action.color.replace(/^#/, "") },
                })(view.state, view.dispatch);
              } else if (action.type === "cellVerticalAlign") {
                setCellVerticalAlign(action.align)(view.state, view.dispatch);
              } else if (action.type === "cellMargins") {
                setCellMargins(action.margins)(view.state, view.dispatch);
              } else if (action.type === "cellTextDirection") {
                setCellTextDirection(action.direction)(
                  view.state,
                  view.dispatch,
                );
              } else if (action.type === "toggleNoWrap") {
                toggleNoWrap()(view.state, view.dispatch);
              } else if (action.type === "rowHeight") {
                setRowHeight(action.height, action.rule)(
                  view.state,
                  view.dispatch,
                );
              } else if (action.type === "toggleHeaderRow") {
                toggleHeaderRow()(view.state, view.dispatch);
              } else if (action.type === "distributeColumns") {
                distributeColumns()(view.state, view.dispatch);
              } else if (action.type === "autoFitContents") {
                autoFitContents()(view.state, view.dispatch);
              } else if (action.type === "openTableProperties") {
                setTablePropsOpen(true);
              } else if (action.type === "tableProperties") {
                setTableProperties(action.props)(view.state, view.dispatch);
              } else if (action.type === "applyTableStyle") {
                // Resolve style data from built-in presets or document styles
                let preset: TableStylePreset | undefined = getBuiltinTableStyle(
                  action.styleId,
                );
                const currentDocForTable = historyStateRef.current;
                if (!preset && currentDocForTable?.package.styles) {
                  const styleResolver = getCachedStyleResolver(
                    currentDocForTable.package.styles,
                  );
                  const docStyle = styleResolver.getStyle(action.styleId);
                  if (docStyle) {
                    // Convert to preset inline (same as documentStyleToPreset)
                    preset = {
                      id: docStyle.styleId,
                      name: docStyle.name ?? docStyle.styleId,
                    };
                    if (docStyle.tblPr?.borders) {
                      const b = docStyle.tblPr.borders;
                      preset.tableBorders = {};
                      for (const side of [
                        "top",
                        "bottom",
                        "left",
                        "right",
                        "insideH",
                        "insideV",
                      ] as const) {
                        const bs = b[side];
                        if (bs) {
                          const borderEntry: {
                            style: string;
                            size?: number;
                            color?: { rgb: string };
                          } = {
                            style: bs.style,
                          };
                          if (bs.size !== undefined) {
                            borderEntry.size = bs.size;
                          }
                          if (bs.color?.rgb) {
                            borderEntry.color = { rgb: bs.color.rgb };
                          }
                          preset.tableBorders[side] = borderEntry;
                        }
                      }
                    }
                    if (docStyle.tblStylePr) {
                      preset.conditionals = {};
                      for (const cond of docStyle.tblStylePr) {
                        const entry: Record<string, unknown> = {};
                        if (cond.tcPr?.shading?.fill?.rgb) {
                          entry["backgroundColor"] =
                            `#${cond.tcPr.shading.fill.rgb}`;
                        }
                        if (cond.tcPr?.borders) {
                          const borders: Record<string, unknown> = {};
                          for (const s of [
                            "top",
                            "bottom",
                            "left",
                            "right",
                          ] as const) {
                            const bs2 = cond.tcPr.borders[s];
                            if (bs2) {
                              borders[s] = {
                                style: bs2.style,
                                size: bs2.size,
                                color: bs2.color?.rgb
                                  ? { rgb: bs2.color.rgb }
                                  : undefined,
                              };
                            }
                          }
                          entry["borders"] = borders;
                        }
                        if (cond.rPr?.bold) {
                          entry["bold"] = true;
                        }
                        if (cond.rPr?.color?.rgb) {
                          entry["color"] = `#${cond.rPr.color.rgb}`;
                        }
                        // SAFETY: preset.conditionals is Record<string, ...>; entry satisfies its value type
                        preset.conditionals[cond.type] = entry as NonNullable<
                          TableStylePreset["conditionals"]
                        >[string];
                      }
                    }
                    preset.look = {
                      firstRow: true,
                      lastRow: false,
                      noHBand: false,
                      noVBand: true,
                    };
                  }
                }
                if (preset) {
                  const styleArg: Parameters<typeof applyTableStyle>[0] = {
                    styleId: preset.id,
                  };
                  if (preset.tableBorders) {
                    styleArg.tableBorders = preset.tableBorders;
                  }
                  if (preset.conditionals) {
                    styleArg.conditionals = preset.conditionals;
                  }
                  if (preset.look) {
                    styleArg.look = preset.look;
                  }
                  applyTableStyle(styleArg)(view.state, view.dispatch);
                }
              }
            } else {
              // Fallback to legacy table selection handler for other actions
              tableSelection.handleAction(action);
            }
        }

        focusActiveEditor();
      },
      // oxlint-disable-next-line react-hooks/exhaustive-deps
      [tableSelection, getActiveEditorView, focusActiveEditor],
    );

    // Context menu handler
    const handleEditorContextMenu = useCallback((e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const view = pagedEditorRef.current?.getView();
      const inTable = view ? isInTable(view.state) : false;
      const { from, to } = view?.state.selection ?? { from: 0, to: 0 };
      const hasSel = from !== to;
      // Check if cursor is on a tracked change mark
      let inTrackedChange = false;
      if (view) {
        const $pos = view.state.doc.resolve(from);
        const node = $pos.parent;
        if (node.isTextblock) {
          // oxlint-disable-next-line unicorn/no-array-for-each -- ProseMirror Node.forEach
          node.forEach((child, offset) => {
            const childStart = $pos.start() + offset;
            const childEnd = childStart + child.nodeSize;
            if (
              from >= childStart &&
              from <= childEnd &&
              child.isText &&
              child.marks.some(
                (m) =>
                  m.type.name === "insertion" || m.type.name === "deletion",
              )
            ) {
              inTrackedChange = true;
            }
          });
        }
      }
      setContextMenu({
        isOpen: true,
        position: { x: e.clientX, y: e.clientY },
        hasSelection: hasSel,
        selectionRange: { from, to },
        cursorInTable: inTable,
        cursorInTrackedChange: inTrackedChange,
      });
    }, []);

    // Handle formatting action from toolbar
    const handleFormat = useCallback(
      (action: FormattingAction) => {
        const view = getActiveEditorView();
        if (!view) {
          return;
        }

        // Focus editor first to ensure we can dispatch commands
        view.focus();

        // Restore selection if it was lost during toolbar interaction
        // This happens when user clicks on dropdown menus (font picker, style picker, etc.)
        // Only restore for the body editor — HF editor manages its own selection
        const isBodyEditor = view === pagedEditorRef.current?.getView();
        const { from, to } = view.state.selection;
        const savedSelection = lastSelectionRef.current;

        if (
          isBodyEditor &&
          savedSelection &&
          (from !== savedSelection.from || to !== savedSelection.to)
        ) {
          // Selection was lost (focus moved to dropdown portal) - restore it
          try {
            const tr = view.state.tr.setSelection(
              TextSelection.create(
                view.state.doc,
                savedSelection.from,
                savedSelection.to,
              ),
            );
            view.dispatch(tr);
          } catch {
            // If restoration fails (e.g., positions are invalid after doc change), continue with current selection
          }
        }

        // Handle simple toggle actions
        if (action === "bold") {
          toggleBold(view.state, view.dispatch);
          return;
        }
        if (action === "italic") {
          toggleItalic(view.state, view.dispatch);
          return;
        }
        if (action === "underline") {
          toggleUnderline(view.state, view.dispatch);
          return;
        }
        if (action === "strikethrough") {
          toggleStrike(view.state, view.dispatch);
          return;
        }
        if (action === "superscript") {
          toggleSuperscript(view.state, view.dispatch);
          return;
        }
        if (action === "subscript") {
          toggleSubscript(view.state, view.dispatch);
          return;
        }
        if (action === "bulletList") {
          toggleBulletList(view.state, view.dispatch);
          return;
        }
        if (action === "numberedList") {
          toggleNumberedList(view.state, view.dispatch);
          return;
        }
        if (action === "indent") {
          // Try list indent first, then paragraph indent
          if (!increaseListLevel(view.state, view.dispatch)) {
            increaseIndent()(view.state, view.dispatch);
          }
          return;
        }
        if (action === "outdent") {
          // Try list outdent first, then paragraph outdent
          if (!decreaseListLevel(view.state, view.dispatch)) {
            decreaseIndent()(view.state, view.dispatch);
          }
          return;
        }
        if (action === "clearFormatting") {
          clearFormatting(view.state, view.dispatch);
          return;
        }
        if (action === "setRtl") {
          setRtl(view.state, view.dispatch);
          return;
        }
        if (action === "setLtr") {
          setLtr(view.state, view.dispatch);
          return;
        }
        if (action === "insertLink") {
          // Get the selected text for the hyperlink dialog
          const selectedText = getSelectedText(view.state);
          // Check if we're editing an existing link
          const existingLink = getHyperlinkAttrs(view.state);
          if (existingLink) {
            const editData: import("./dialogs/HyperlinkDialog").HyperlinkData =
              {
                url: existingLink.href,
                displayText: selectedText,
              };
            if (existingLink.tooltip) {
              editData.tooltip = existingLink.tooltip;
            }
            hyperlinkDialog.openEdit(editData);
          } else {
            hyperlinkDialog.openInsert(selectedText);
          }
          return;
        }

        // Handle object-based actions
        if (typeof action === "object") {
          switch (action.type) {
            case "alignment":
              setAlignment(action.value)(view.state, view.dispatch);
              break;
            case "textColor": {
              // action.value can be a ColorValue object or a string like "#FF0000"
              const colorVal = action.value;
              if (typeof colorVal === "string") {
                setTextColor({ rgb: colorVal.replace("#", "") })(
                  view.state,
                  view.dispatch,
                );
              } else if (colorVal.auto) {
                // "Automatic" — remove text color
                clearTextColor(view.state, view.dispatch);
              } else {
                setTextColor(colorVal)(view.state, view.dispatch);
              }
              break;
            }
            case "highlightColor": {
              // Convert hex to OOXML named highlight value (e.g., 'FFFF00' → 'yellow')
              const highlightName = action.value
                ? mapHexToHighlightName(action.value)
                : "";
              setHighlight(highlightName || action.value)(
                view.state,
                view.dispatch,
              );
              break;
            }
            case "fontSize":
              // Convert points to half-points (OOXML uses half-points for font sizes)
              setFontSize(pointsToHalfPoints(action.value))(
                view.state,
                view.dispatch,
              );
              break;
            case "fontFamily":
              setFontFamily(action.value)(view.state, view.dispatch);
              break;
            case "lineSpacing":
              setLineSpacing(action.value)(view.state, view.dispatch);
              break;
            case "applyStyle": {
              // Resolve style to get its formatting properties
              // Use ref to avoid stale closure (handleFormat has [] deps)
              const currentDoc = historyStateRef.current;
              const styleResolver = currentDoc?.package.styles
                ? getCachedStyleResolver(currentDoc.package.styles)
                : null;

              if (styleResolver) {
                const resolved = styleResolver.resolveParagraphStyle(
                  action.value,
                );
                const styleAttrs: Parameters<typeof applyStyle>[1] = {};
                if (resolved.paragraphFormatting) {
                  styleAttrs.paragraphFormatting = resolved.paragraphFormatting;
                }
                if (resolved.runFormatting) {
                  styleAttrs.runFormatting = resolved.runFormatting;
                }
                applyStyle(action.value, styleAttrs)(view.state, view.dispatch);
              } else {
                // No styles available, just set the styleId
                applyStyle(action.value)(view.state, view.dispatch);
              }
              break;
            }
            default:
              break;
          }
        }
      },
      // oxlint-disable-next-line react-hooks/exhaustive-deps
      [getActiveEditorView],
    );

    // Handle zoom change
    const handleZoomChange = useCallback((zoom: number) => {
      setState((prev) => ({ ...prev, zoom }));
    }, []);

    // Right-click context menu handlers
    const handleContextMenu = useCallback(
      (data: { x: number; y: number; hasSelection: boolean }) => {
        const view = pagedEditorRef.current?.getView();
        const inTable = view ? isInTable(view.state) : false;
        let inChange = false;
        if (view) {
          const { from } = view.state.selection;
          const $pos = view.state.doc.resolve(from);
          const node = $pos.parent;
          if (node.isTextblock) {
            // oxlint-disable-next-line unicorn/no-array-for-each -- ProseMirror Node.forEach
            node.forEach((child, offset) => {
              const s = $pos.start() + offset;
              if (
                from >= s &&
                from <= s + child.nodeSize &&
                child.isText &&
                child.marks.some(
                  (m) =>
                    m.type.name === "insertion" || m.type.name === "deletion",
                )
              ) {
                inChange = true;
              }
            });
          }
        }
        const sel = view?.state.selection ?? { from: 0, to: 0 };
        setContextMenu({
          isOpen: true,
          position: data,
          hasSelection: data.hasSelection,
          selectionRange: { from: sel.from, to: sel.to },
          cursorInTable: inTable,
          cursorInTrackedChange: inChange,
        });
      },
      [],
    );

    const handleContextMenuClose = useCallback(() => {
      setContextMenu({
        isOpen: false,
        position: { x: 0, y: 0 },
        hasSelection: false,
        selectionRange: { from: 0, to: 0 },
        cursorInTable: false,
        cursorInTrackedChange: false,
      });
    }, []);

    const contextMenuItems = useMemo((): TextContextMenuItem[] => {
      const isMac =
        typeof navigator !== "undefined" && /Mac/.test(navigator.platform);
      const mod = isMac ? "⌘" : "Ctrl";
      const items: TextContextMenuItem[] = [
        { action: "cut", label: t("cut"), shortcut: `${mod}+X` },
        { action: "copy", label: t("copy"), shortcut: `${mod}+C` },
        { action: "paste", label: t("paste"), shortcut: `${mod}+V` },
        {
          action: "pasteAsPlainText",
          label: t("pasteUnformatted"),
          shortcut: `${mod}+Shift+V`,
          dividerAfter: true,
        },
        {
          action: "delete",
          label: t("delete"),
          shortcut: "Del",
          dividerAfter: !contextMenu.hasSelection && !contextMenu.cursorInTable,
        },
      ];
      if (contextMenu.hasSelection) {
        items.push({
          action: "addComment",
          label: t("comment"),
          dividerAfter: !contextMenu.cursorInTable,
        });
      }
      if (contextMenu.cursorInTable) {
        items.push(
          { action: "addRowAbove", label: t("insertRowAbove") },
          { action: "addRowBelow", label: t("insertRowBelow") },
          { action: "deleteRow", label: t("deleteRow"), dividerAfter: true },
          { action: "addColumnLeft", label: t("insertColumnLeft") },
          { action: "addColumnRight", label: t("insertColumnRight") },
          {
            action: "deleteColumn",
            label: t("deleteColumn"),
            dividerAfter: true,
          },
        );
      }
      if (contextMenu.cursorInTrackedChange) {
        items.push(
          { action: "acceptChange", label: t("acceptChange") },
          {
            action: "rejectChange",
            label: t("rejectChange"),
            dividerAfter: true,
          },
        );
      }
      items.push({
        action: "selectAll",
        label: t("selectAll"),
        shortcut: `${mod}+A`,
      });
      return items;
    }, [
      contextMenu.hasSelection,
      contextMenu.cursorInTable,
      contextMenu.cursorInTrackedChange,
      t,
    ]);

    const handleContextMenuAction = useCallback(
      async (action: TextContextAction) => {
        const view = getActiveEditorView();
        if (!view) {
          return;
        }

        // Focus the hidden PM so clipboard operations target the right element
        focusActiveEditor();

        switch (action) {
          case "cut": {
            // Copy selected text to clipboard, then delete selection
            const { from, to } = view.state.selection;
            const text = view.state.doc.textBetween(from, to, "\n");
            void navigator.clipboard.writeText(text);
            view.dispatch(view.state.tr.deleteSelection());
            break;
          }
          case "copy": {
            const { from: cf, to: ct } = view.state.selection;
            const copied = view.state.doc.textBetween(cf, ct, "\n");
            void navigator.clipboard.writeText(copied);
            break;
          }
          case "paste": {
            // Use Clipboard API — document.execCommand('paste') is blocked in modern browsers
            try {
              const items = await navigator.clipboard.read();
              let html = "";
              let text = "";
              for (const item of items) {
                if (item.types.includes("text/html")) {
                  html = await (await item.getType("text/html")).text();
                }
                if (item.types.includes("text/plain")) {
                  text = await (await item.getType("text/plain")).text();
                }
              }
              const dt = new DataTransfer();
              if (html) {
                dt.items.add(html, "text/html");
              }
              if (text) {
                dt.items.add(text, "text/plain");
              }
              const pasteEvent = new ClipboardEvent("paste", {
                clipboardData: dt,
                bubbles: true,
                cancelable: true,
              });
              view.dom.dispatchEvent(pasteEvent);
            } catch {
              try {
                const text = await navigator.clipboard.readText();
                if (text) {
                  view.dispatch(view.state.tr.insertText(text));
                }
              } catch {
                // Clipboard access denied
              }
            }
            break;
          }
          case "pasteAsPlainText":
            try {
              const text = await navigator.clipboard.readText();
              if (text) {
                view.dispatch(view.state.tr.insertText(text));
              }
            } catch {
              // Clipboard access denied
            }
            break;
          case "delete": {
            const { from, to } = view.state.selection;
            if (from !== to) {
              view.dispatch(view.state.tr.deleteRange(from, to));
            }
            break;
          }
          case "selectAll":
            view.dispatch(
              view.state.tr.setSelection(
                TextSelection.create(
                  view.state.doc,
                  0,
                  view.state.doc.content.size,
                ),
              ),
            );
            break;
          // Table operations
          case "addRowAbove":
            addRowAbove(view.state, view.dispatch);
            break;
          case "addRowBelow":
            addRowBelow(view.state, view.dispatch);
            break;
          case "deleteRow":
            pmDeleteRow(view.state, view.dispatch);
            break;
          case "addColumnLeft":
            addColumnLeft(view.state, view.dispatch);
            break;
          case "addColumnRight":
            addColumnRight(view.state, view.dispatch);
            break;
          case "deleteColumn":
            pmDeleteColumn(view.state, view.dispatch);
            break;
          // Comment — same flow as floating comment button
          case "addComment": {
            // Use the stored selection range from when the context menu opened,
            // because right-click may collapse the PM selection to a cursor
            const { from, to } =
              contextMenu.selectionRange.from !== contextMenu.selectionRange.to
                ? contextMenu.selectionRange
                : view.state.selection;
            if (from === to) {
              break;
            }
            // Compute Y position BEFORE dispatching — dispatch triggers re-layout
            // which rebuilds page DOM and invalidates the old span elements
            const yPos = findSelectionYPosition(
              scrollContainerRef.current,
              editorContentRef.current,
              from,
            );
            setCommentSelectionRange({ from, to });
            const commentMarkType = view.state.schema.marks["comment"];
            if (!commentMarkType) {
              return;
            }
            const pendingMark = commentMarkType.create({
              commentId: PENDING_COMMENT_ID,
            });
            const tr = view.state.tr.addMark(from, to, pendingMark);
            tr.setSelection(TextSelection.create(tr.doc, to));
            view.dispatch(tr);
            setAddCommentYPosition(yPos);
            setShowCommentsSidebar(true);
            setIsAddingComment(true);
            setFloatingCommentBtn(null);
            break;
          }
          case "acceptChange": {
            const { from, to } = view.state.selection;
            const range = findChangeAtPosition(view.state, from, to);
            acceptChange(range.from, range.to)(view.state, view.dispatch);
            break;
          }
          case "rejectChange": {
            const { from, to } = view.state.selection;
            const range = findChangeAtPosition(view.state, from, to);
            rejectChange(range.from, range.to)(view.state, view.dispatch);
            break;
          }
          default:
            break;
        }
        // TextContextMenu calls onClose after onAction, so no need to close here
      },
      [
        getActiveEditorView,
        focusActiveEditor,
        contextMenu.selectionRange.from,
        contextMenu.selectionRange.to,
      ],
    );

    // Page setup apply handler
    const handlePageSetupApply = useCallback(
      (props: Partial<SectionProperties>) => {
        if (!history.state || readOnly) {
          return;
        }
        const newDoc = {
          ...history.state,
          package: {
            ...history.state.package,
            document: {
              ...history.state.package.document,
              finalSectionProperties: {
                ...history.state.package.document.finalSectionProperties,
                ...props,
              },
            },
          },
        };
        handleDocumentChange(newDoc);
      },
      [history.state, readOnly, handleDocumentChange],
    );

    // Scroll-based page tracking: calculate current page from scroll position.
    // Re-attaches when the scroll container mounts (after loading completes).
    const scrollContainerEl = scrollContainerRef.current;
    useEffect(() => {
      if (!scrollContainerEl) {
        return;
      }

      const handleScroll = () => {
        const layout = pagedEditorRef.current?.getLayout();
        if (!layout || layout.pages.length === 0) {
          return;
        }

        const scrollTop = scrollContainerEl.scrollTop;
        const totalPages = layout.pages.length;
        const pageGap = 24; // DEFAULT_PAGE_GAP from PagedEditor
        const paddingTop = 24; // top padding in paged-editor__pages

        // Calculate which page is visible at the viewport center
        const viewportCenter = scrollTop + scrollContainerEl.clientHeight / 2;
        let accumulatedY = paddingTop;
        let currentPage = 1;

        for (let i = 0; i < layout.pages.length; i++) {
          // SAFETY: i is bounded by layout.pages.length
          const pageHeight = layout.pages[i]!.size.h;
          const pageEnd = accumulatedY + pageHeight;
          if (viewportCenter < pageEnd) {
            currentPage = i + 1;
            break;
          }
          accumulatedY = pageEnd + pageGap;
          currentPage = i + 2; // next page
        }
        currentPage = Math.min(currentPage, totalPages);

        setScrollPageInfo({ currentPage, totalPages, visible: true });

        // Clear existing fade timer
        if (scrollFadeTimerRef.current) {
          clearTimeout(scrollFadeTimerRef.current);
        }
        // Hide after 0.6s of no scrolling
        scrollFadeTimerRef.current = setTimeout(() => {
          setScrollPageInfo((prev) => ({ ...prev, visible: false }));
        }, 600);
      };

      scrollContainerEl.addEventListener("scroll", handleScroll, {
        passive: true,
      });
      return () => {
        scrollContainerEl.removeEventListener("scroll", handleScroll);
        if (scrollFadeTimerRef.current) {
          clearTimeout(scrollFadeTimerRef.current);
        }
      };
    }, [scrollContainerEl]);

    // Handle save
    const handleSave = useCallback(
      async (options?: {
        selective?: boolean;
      }): Promise<ArrayBuffer | null> => {
        if (!history.state) {
          return null;
        }

        try {
          // Build current document from PM editor state
          const doc = structuredClone(history.state);
          const pmDoc = pagedEditorRef.current?.getDocument();
          if (pmDoc?.package?.document) {
            doc.package.document.content = pmDoc.package.document.content;
          }
          doc.package.document.comments = comments;

          // Try selective save first (patches only changed paragraphs)
          const useSelective = options?.selective !== false;
          const view = pagedEditorRef.current?.getView();
          let buffer: ArrayBuffer | null = null;

          if (useSelective && view && originalBufferRef.current) {
            const editorState = view.state;
            buffer = await attemptSelectiveSave(
              doc,
              originalBufferRef.current,
              {
                changedParaIds: getChangedParagraphIds(editorState),
                structuralChange: hasStructuralChanges(editorState),
                hasUntrackedChanges: hasUntrackedChanges(editorState),
              },
            );
          }

          // Fall back to full repack
          if (!buffer) {
            buffer = await repackDocx(doc);
          }

          // Clear change tracker after successful save
          if (view) {
            view.dispatch(clearTrackedChanges(view.state));
          }

          onSave?.(buffer);
          return buffer;
        } catch (error) {
          onError?.(
            error instanceof Error
              ? error
              : new Error("Failed to save document"),
          );
          return null;
        }
      },
      [history.state, onSave, onError, comments, originalBufferRef],
    );

    // Handle error from editor
    const handleEditorError = useCallback(
      (error: Error) => {
        onError?.(error);
      },
      [onError],
    );

    // Expose ref methods
    useImperativeHandle(
      ref,
      () => ({
        getDocument: () => history.state,
        getEditorRef: () => pagedEditorRef.current,
        save: handleSave,
        setZoom: (zoom: number) => setState((prev) => ({ ...prev, zoom })),
        getZoom: () => state.zoom,
        focus: () => {
          pagedEditorRef.current?.focus();
        },
        getCurrentPage: () => scrollPageInfo.currentPage,
        getTotalPages: () => scrollPageInfo.totalPages,
        scrollToPage: (_pageNumber: number) => {
          // TODO: Implement page navigation in ProseMirror
        },
        openPrintPreview: handleDirectPrint,
        print: handleDirectPrint,
        loadDocument: loadParsedDocument,
        loadDocumentBuffer: loadBuffer,
      }),
      [
        history.state,
        state.zoom,
        scrollPageInfo,
        handleSave,
        handleDirectPrint,
        loadParsedDocument,
        loadBuffer,
      ],
    );

    // Get the DOM element for the header/footer area on the first page
    const getHfTargetElement = useCallback(
      (pos: "header" | "footer"): HTMLElement | null => {
        const pagesContainer = containerRef.current?.querySelector(
          ".paged-editor__pages",
        );
        if (!pagesContainer) {
          return null;
        }
        const selector =
          pos === "header" ? ".layout-page-header" : ".layout-page-footer";
        return pagesContainer.querySelector(selector);
      },
      [],
    );

    // Container styles - using overflow: auto so sticky toolbar works
    const containerStyle: CSSProperties = {
      display: "flex",
      flexDirection: "column",
      height: "100%",
      width: "100%",
      backgroundColor: "var(--muted)",
      ...style,
    };

    const mainContentStyle: CSSProperties = {
      display: "flex",
      flex: 1,
      minHeight: 0, // Allow flex item to shrink below content size
      minWidth: 0, // Allow flex item to shrink below content width on narrow viewports
      flexDirection: "row",
    };

    const editorContainerStyle: CSSProperties = {
      flex: 1,
      minHeight: 0,
      minWidth: 0, // Allow flex item to shrink below content width on narrow viewports
      overflow: "auto", // Sole scroll container — PagedEditor sizes to content
      position: "relative",
    };

    // Render loading state
    if (state.documentLoad.status === "loading") {
      return (
        <div
          className={`folio-root folio-editor folio-editor-loading ${className}`}
          style={containerStyle}
          data-testid="folio-editor"
        >
          {loadingIndicator || <DefaultLoadingIndicator />}
        </div>
      );
    }

    // Render error state
    if (state.documentLoad.status === "error") {
      return (
        <div
          className={`folio-root folio-editor folio-editor-error ${className}`}
          style={containerStyle}
          data-testid="folio-editor"
        >
          <ParseError message={state.documentLoad.message} />
        </div>
      );
    }

    // Render placeholder when no document
    if (!history.state) {
      return (
        <div
          className={`folio-root folio-editor folio-editor-empty ${className}`}
          style={containerStyle}
          data-testid="folio-editor"
        >
          {placeholder || <DefaultPlaceholder />}
        </div>
      );
    }

    const DISPLAY_MODE_LABELS = {
      "all-markup": "All Markup",
      "simple-markup": "Simple",
      "no-markup": "No Markup",
      original: "Original",
    } as const satisfies Record<DisplayMode, string>;

    const toolbarChildren = toolbarExtra ?? null;

    const toolbarInlineExtra = (
      <>
        <ToolbarSeparator />
        <button
          type="button"
          onClick={toggleTrackChanges}
          onMouseDown={(e) => e.preventDefault()}
          disabled={readOnly}
          aria-pressed={trackChangesOn}
          aria-label={t("toggleTrackChanges")}
          className={`flex h-8 w-[110px] items-center gap-1.5 rounded-md px-2.5 text-xs transition-colors duration-100 disabled:cursor-not-allowed disabled:text-[var(--doc-text-subtle)] disabled:opacity-[0.16] disabled:hover:bg-transparent disabled:hover:text-[var(--doc-text-subtle)] ${
            trackChangesOn
              ? "bg-[var(--doc-primary-light)] text-[var(--doc-text)]"
              : "text-[var(--doc-text-muted)] hover:bg-[var(--doc-primary-light)] hover:text-[var(--doc-text)]"
          }`}
        >
          <PenLineIcon size={14} />
          <span>{trackChangesOn ? t("trackingOn") : t("trackingOff")}</span>
        </button>
        <ToolbarSeparator />
        <StSelect
          value={displayMode}
          onValueChange={(val) => setDisplayMode(val as DisplayMode)}
          disabled={readOnly}
          items={[
            { value: "all-markup", label: "All Markup" },
            { value: "simple-markup", label: "Simple" },
            { value: "no-markup", label: "No Markup" },
            { value: "original", label: "Original" },
          ]}
        >
          <StSelectTrigger
            size="sm"
            className="h-8 min-h-0 w-[130px] min-w-0 border-transparent bg-transparent text-xs text-[var(--doc-text-muted)] shadow-none hover:bg-[var(--doc-primary-light)] hover:text-[var(--doc-text)] data-[pressed]:bg-[var(--doc-primary-light)]"
          >
            <EyeIcon size={14} className="shrink-0" />
            <StSelectValue />
          </StSelectTrigger>
          <StSelectPopup>
            {(
              ["all-markup", "simple-markup", "no-markup", "original"] as const
            ).map((mode) => (
              <StSelectItem key={mode} value={mode}>
                {DISPLAY_MODE_LABELS[mode]}
              </StSelectItem>
            ))}
          </StSelectPopup>
        </StSelect>
        <ToolbarSeparator />
        {state.activeTrackedChange && (
          <span
            className="flex items-center gap-1 px-2 text-xs text-[var(--doc-text-muted)]"
            style={{ maxWidth: 260 }}
          >
            <span className="truncate">
              <span className="font-medium text-[var(--doc-text)]">
                {state.activeTrackedChange.author}
              </span>
              {state.activeTrackedChange.date && (
                <>
                  {" · "}
                  {new Date(
                    state.activeTrackedChange.date,
                  ).toLocaleDateString()}
                </>
              )}
              {" · "}
              {state.activeTrackedChange.type === "insertion"
                ? t("inserted")
                : t("deleted")}
            </span>
          </span>
        )}
        <ToolbarButton
          onClick={() => {
            const view = pagedEditorRef.current?.getView();
            if (!view) {
              return;
            }
            const { from, to } = view.state.selection;
            const range = findChangeAtPosition(view.state, from, to);
            acceptChange(range.from, range.to)(view.state, view.dispatch);
          }}
          disabled={readOnly || !state.activeTrackedChange}
          title={t("acceptChange")}
          ariaLabel={t("acceptChange")}
        >
          <CheckIcon size={16} />
        </ToolbarButton>
        <ToolbarButton
          onClick={() => {
            const view = pagedEditorRef.current?.getView();
            if (!view) {
              return;
            }
            const { from, to } = view.state.selection;
            const range = findChangeAtPosition(view.state, from, to);
            rejectChange(range.from, range.to)(view.state, view.dispatch);
          }}
          disabled={readOnly || !state.activeTrackedChange}
          title={t("rejectChange")}
          ariaLabel={t("rejectChange")}
        >
          <XIcon size={16} />
        </ToolbarButton>
        <ToolbarButton
          onClick={() => {
            const view = pagedEditorRef.current?.getView();
            if (!view) {
              return;
            }
            const { from } = view.state.selection;
            const change = findPreviousChange(view.state, from);
            if (change) {
              view.dispatch(
                view.state.tr.setSelection(
                  TextSelection.create(view.state.doc, change.from, change.to),
                ),
              );
              view.focus();
              // Scroll the rendered page to the change position
              requestAnimationFrame(() => {
                pagedEditorRef.current?.scrollToPosition(change.from);
              });
            }
          }}
          disabled={readOnly}
          title={t("previousChange")}
          ariaLabel={t("previousChange")}
        >
          <ChevronLeftIcon size={16} />
        </ToolbarButton>
        <ToolbarButton
          onClick={() => {
            const view = pagedEditorRef.current?.getView();
            if (!view) {
              return;
            }
            const { to } = view.state.selection;
            const change = findNextChange(view.state, to);
            if (change) {
              view.dispatch(
                view.state.tr.setSelection(
                  TextSelection.create(view.state.doc, change.from, change.to),
                ),
              );
              view.focus();
              // Scroll the rendered page to the change position
              requestAnimationFrame(() => {
                pagedEditorRef.current?.scrollToPosition(change.from);
              });
            }
          }}
          disabled={readOnly}
          title={t("nextChange")}
          ariaLabel={t("nextChange")}
        >
          <ChevronRightIcon size={16} />
        </ToolbarButton>
      </>
    );

    return (
      <ErrorProvider>
        <ErrorBoundary onError={handleEditorError}>
          <div
            ref={containerRef}
            className={`folio-root folio-editor${displayMode !== "all-markup" ? ` folio-root--${displayMode}` : ""} ${className}`}
            style={containerStyle}
            data-testid="folio-editor"
          >
            {/* Main content area */}
            <div style={mainContentStyle}>
              {/* Wrapper for toolbar + scroll container + outline overlay */}
              <div
                style={{
                  position: "relative",
                  flex: 1,
                  minHeight: 0,
                  minWidth: 0,
                  display: "flex",
                  flexDirection: "column",
                }}
              >
                {/* Toolbar - above the scroll container so scrollbar doesn't extend behind it */}
                {/* Hide toolbar only when readOnly prop is explicitly set (not from viewing mode) */}
                {showToolbar && !readOnlyProp && (
                  <div
                    ref={toolbarRefCallback}
                    className="z-50 flex flex-shrink-0 flex-col gap-0 bg-[var(--doc-page)]"
                  >
                    <FormattingBar
                      currentFormatting={state.selectionFormatting}
                      onFormat={handleFormat}
                      onUndo={undoActiveEditor}
                      onRedo={redoActiveEditor}
                      canUndo={
                        hfEditPosition
                          ? history.canUndo
                          : bodyHistoryAvailability.canUndo
                      }
                      canRedo={
                        hfEditPosition
                          ? history.canRedo
                          : bodyHistoryAvailability.canRedo
                      }
                      disabled={readOnly}
                      theme={history.state?.package.theme || theme || null}
                      showZoomControl={showZoomControl}
                      zoom={state.zoom}
                      onZoomChange={handleZoomChange}
                      onRefocusEditor={focusActiveEditor}
                      onImageWrapType={handleImageWrapType}
                      onImageTransform={handleImageTransform}
                      onOpenImageProperties={handleOpenImageProperties}
                      onTableAction={handleTableAction}
                      inlineExtra={toolbarInlineExtra}
                      {...(history.state?.package.styles?.styles
                        ? {
                            documentStyles: history.state.package.styles.styles,
                          }
                        : {})}
                      {...(state.pmImageContext
                        ? { imageContext: state.pmImageContext }
                        : {})}
                      {...(state.pmTableContext
                        ? { tableContext: state.pmTableContext }
                        : {})}
                    >
                      {toolbarChildren}
                    </FormattingBar>
                  </div>
                )}

                {/* Editor container - this is the scroll container (toolbar is above, not inside) */}
                <div
                  ref={scrollContainerRef}
                  style={editorContainerStyle}
                  onScroll={(event) => {
                    onScrollTopChange?.(event.currentTarget.scrollTop);
                  }}
                >
                  {/* Editor content wrapper */}
                  <div
                    style={{
                      display: "flex",
                      flex: 1,
                      minHeight: 0,
                      position: "relative",
                    }}
                  >
                    {/* Editor content area */}
                    {/* oxlint-disable-next-line jsx-a11y/no-static-element-interactions */}
                    <div
                      ref={editorContentRef}
                      style={{ position: "relative", flex: 1, minWidth: 0 }}
                      onMouseDown={(e) => {
                        // Focus editor when clicking on the background area (not the editor itself)
                        // Using mouseDown for immediate response before focus can be lost
                        if (e.target === e.currentTarget) {
                          e.preventDefault();
                          pagedEditorRef.current?.focus();
                        }
                      }}
                      onContextMenu={handleEditorContextMenu}
                    >
                      <PagedEditor
                        ref={pagedEditorRef}
                        document={history.state}
                        theme={history.state?.package.theme || theme || null}
                        sectionProperties={effectiveSectionProperties ?? null}
                        headerContent={headerContent}
                        footerContent={footerContent}
                        firstPageHeaderContent={firstPageHeaderContent}
                        firstPageFooterContent={firstPageFooterContent}
                        {...(history.state?.package.styles
                          ? { styles: history.state.package.styles }
                          : {})}
                        onHeaderFooterDoubleClick={
                          handleHeaderFooterDoubleClick
                        }
                        hfEditMode={hfEditPosition}
                        onBodyClick={handleBodyClick}
                        zoom={state.zoom}
                        readOnly={readOnly}
                        onDocumentChange={handleDocumentChange}
                        {...(extensionManager !== undefined
                          ? { extensionManager }
                          : {})}
                        onSelectionChange={(_from, _to) => {
                          // Extract full selection state from PM and use the standard handler
                          const view = pagedEditorRef.current?.getView();
                          if (view) {
                            const selectionState = extractSelectionState(
                              view.state,
                            );
                            handleSelectionChange(selectionState);
                          } else {
                            handleSelectionChange(null);
                          }
                        }}
                        externalPlugins={allExternalPlugins}
                        onReady={(editorRef) => {
                          // oxlint-disable-next-line typescript/no-non-null-assertion
                          onEditorViewReady?.(editorRef.getView()!);
                        }}
                        {...(onRenderedDomContextReady
                          ? { onRenderedDomContextReady }
                          : {})}
                        {...(pluginOverlays !== undefined
                          ? { pluginOverlays }
                          : {})}
                        onHyperlinkClick={handleHyperlinkClick}
                        onContextMenu={handleContextMenu}
                        commentsSidebarOpen={showCommentsSidebar}
                        onAnchorPositionsChange={setAnchorPositions}
                        scrollContainerRef={scrollContainerRef}
                        sidebarOverlay={
                          showCommentsSidebar ? (
                            <CommentsSidebar
                              comments={comments}
                              anchorPositions={anchorPositions}
                              pageWidth={(() => {
                                const sp =
                                  history.state?.package?.document
                                    ?.finalSectionProperties;
                                return sp?.pageWidth
                                  ? Math.round(sp.pageWidth / 15)
                                  : 816;
                              })()}
                              editorContainerRef={scrollContainerRef}
                              onCommentResolve={(id) => {
                                setComments((prev) =>
                                  prev.map((c) =>
                                    c.id === id ? { ...c, done: true } : c,
                                  ),
                                );
                              }}
                              onCommentDelete={(id) => {
                                setComments((prev) =>
                                  prev.filter(
                                    (c) => c.id !== id && c.parentId !== id,
                                  ),
                                );
                              }}
                              onCommentReply={(id, text) => {
                                setComments((prev) => [
                                  ...prev,
                                  createComment(text, author, id),
                                ]);
                              }}
                              onAddComment={(addText) => {
                                const comment = createComment(addText, author);
                                // Replace pending comment mark with the real comment ID
                                const view = pagedEditorRef.current?.getView();
                                const commentMark =
                                  view?.state.schema.marks["comment"];
                                if (
                                  view &&
                                  commentMark &&
                                  commentSelectionRange
                                ) {
                                  const { from, to } = commentSelectionRange;
                                  const pendingMark = commentMark.create({
                                    commentId: PENDING_COMMENT_ID,
                                  });
                                  const realMark = commentMark.create({
                                    commentId: comment.id,
                                  });
                                  const tr = view.state.tr
                                    .removeMark(from, to, pendingMark)
                                    .addMark(from, to, realMark);
                                  view.dispatch(tr);
                                }
                                setComments((prev) => [...prev, comment]);
                                setIsAddingComment(false);
                                setCommentSelectionRange(null);
                                setAddCommentYPosition(null);
                              }}
                              onTrackedChangeReply={(revisionId, text) => {
                                setComments((prev) => [
                                  ...prev,
                                  createComment(text, author, revisionId),
                                ]);
                              }}
                              onCancelAddComment={() => {
                                // Remove pending comment highlight
                                const view = pagedEditorRef.current?.getView();
                                const cancelCommentMark =
                                  view?.state.schema.marks["comment"];
                                if (
                                  view &&
                                  cancelCommentMark &&
                                  commentSelectionRange
                                ) {
                                  const { from, to } = commentSelectionRange;
                                  const pendingMark = cancelCommentMark.create({
                                    commentId: PENDING_COMMENT_ID,
                                  });
                                  view.dispatch(
                                    view.state.tr.removeMark(
                                      from,
                                      to,
                                      pendingMark,
                                    ),
                                  );
                                }
                                setIsAddingComment(false);
                                setCommentSelectionRange(null);
                                setAddCommentYPosition(null);
                              }}
                              onAcceptChange={(from, to) => {
                                const view = pagedEditorRef.current?.getView();
                                if (view) {
                                  acceptChange(from, to)(
                                    view.state,
                                    view.dispatch,
                                  );
                                  extractTrackedChanges();
                                }
                              }}
                              onRejectChange={(from, to) => {
                                const view = pagedEditorRef.current?.getView();
                                if (view) {
                                  rejectChange(from, to)(
                                    view.state,
                                    view.dispatch,
                                  );
                                  extractTrackedChanges();
                                }
                              }}
                              isAddingComment={isAddingComment}
                              addCommentYPosition={addCommentYPosition}
                              topOffset={0}
                            />
                          ) : undefined
                        }
                      />

                      {/* Floating "add comment" button — appears on right edge of page at selection */}
                      {floatingCommentBtn !== null &&
                        floatingCommentBtn !== undefined &&
                        !isAddingComment &&
                        !readOnly && (
                          <Tooltip
                            content="Add comment"
                            side="bottom"
                            delayMs={300}
                          >
                            <button
                              type="button"
                              onMouseDown={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                const view = pagedEditorRef.current?.getView();
                                const btnCommentMark =
                                  view?.state.schema.marks["comment"];
                                if (view && btnCommentMark) {
                                  const { from, to } = view.state.selection;
                                  if (from !== to) {
                                    setCommentSelectionRange({ from, to });
                                    const pendingMark = btnCommentMark.create({
                                      commentId: PENDING_COMMENT_ID,
                                    });
                                    const tr = view.state.tr.addMark(
                                      from,
                                      to,
                                      pendingMark,
                                    );
                                    tr.setSelection(
                                      TextSelection.create(tr.doc, to),
                                    );
                                    view.dispatch(tr);
                                  }
                                }
                                setAddCommentYPosition(floatingCommentBtn.top);
                                setShowCommentsSidebar(true);
                                setIsAddingComment(true);
                                setFloatingCommentBtn(null);
                              }}
                              style={{
                                position: "absolute",
                                top: floatingCommentBtn.top,
                                left: floatingCommentBtn.left,
                                transform: "translate(-50%, -50%)",
                                zIndex: 50,
                                width: 28,
                                height: 28,
                                borderRadius: 6,
                                border: "1px solid var(--doc-border)",
                                backgroundColor: "var(--doc-page)",
                                color: "var(--doc-text-muted)",
                                cursor: "pointer",
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "center",
                                boxShadow: "0 2px 8px var(--doc-border)",
                                transition:
                                  "background-color 0.15s, box-shadow 0.15s",
                              }}
                              onMouseOver={(e) => {
                                (
                                  e.currentTarget as HTMLButtonElement
                                ).style.backgroundColor =
                                  "rgba(26, 115, 232, 0.08)";
                                (
                                  e.currentTarget as HTMLButtonElement
                                ).style.boxShadow =
                                  "0 1px 4px rgba(26, 115, 232, 0.3)";
                              }}
                              onFocus={(e) => {
                                (
                                  e.currentTarget as HTMLButtonElement
                                ).style.backgroundColor =
                                  "rgba(26, 115, 232, 0.08)";
                              }}
                              onMouseOut={(e) => {
                                (
                                  e.currentTarget as HTMLButtonElement
                                ).style.backgroundColor =
                                  "var(--doc-canvas, #fff)";
                                (
                                  e.currentTarget as HTMLButtonElement
                                ).style.boxShadow =
                                  "0 1px 3px rgba(60,64,67,0.2)";
                              }}
                              onBlur={(e) => {
                                (
                                  e.currentTarget as HTMLButtonElement
                                ).style.backgroundColor =
                                  "var(--doc-canvas, #fff)";
                              }}
                            >
                              <MessageSquarePlusIcon size={16} />
                            </button>
                          </Tooltip>
                        )}

                      {/* Inline Header/Footer Editor — positioned over the target area */}
                      {hfEditPosition &&
                        (() => {
                          const activeHf = hfEditIsFirstPage
                            ? hfEditPosition === "header"
                              ? firstPageHeaderContent
                              : firstPageFooterContent
                            : hfEditPosition === "header"
                              ? headerContent
                              : footerContent;
                          if (!activeHf) {
                            return null;
                          }
                          const targetEl = getHfTargetElement(hfEditPosition);
                          const parentEl = editorContentRef.current;
                          if (!targetEl || !parentEl) {
                            return null;
                          }
                          return (
                            <InlineHeaderFooterEditor
                              ref={hfEditorRef}
                              headerFooter={activeHf}
                              position={hfEditPosition}
                              targetElement={targetEl}
                              parentElement={parentEl}
                              onSave={handleHeaderFooterSave}
                              onClose={() => setHfEditPosition(null)}
                              onSelectionChange={handleSelectionChange}
                              onRemove={handleRemoveHeaderFooter}
                              {...(history.state?.package.styles
                                ? { styles: history.state.package.styles }
                                : {})}
                            />
                          );
                        })()}
                    </div>
                  </div>
                  {/* end editor flex wrapper */}
                </div>
                {/* end scroll container */}

                {/* Page indicator — Google Docs style, next to scrollbar while scrolling */}
                {scrollPageInfo.totalPages > 1 && (
                  <div
                    style={{
                      position: "absolute",
                      right: 24,
                      top: "50%",
                      transform: "translateY(-50%)",
                      backgroundColor: "var(--doc-text)",
                      color: "var(--doc-page)",
                      padding: "6px 12px",
                      borderRadius: "4px",
                      fontSize: "12px",
                      fontFamily:
                        '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
                      fontWeight: 500,
                      whiteSpace: "nowrap",
                      pointerEvents: "none",
                      zIndex: 1000,
                      opacity: scrollPageInfo.visible ? 1 : 0,
                      transition: "opacity 0.3s ease",
                      userSelect: "none",
                    }}
                    aria-live="polite"
                    role="status"
                  >
                    {scrollPageInfo.currentPage} of {scrollPageInfo.totalPages}
                  </div>
                )}

                {/* Document outline sidebar — absolutely positioned, doesn't scroll */}
                {/* Document outline and comments sidebar provided by host app */}
              </div>
              {/* end wrapper for scroll container + outline */}
            </div>

            {/* Hyperlink popup (Google Docs-style) */}
            <HyperlinkPopup
              data={hyperlinkPopupData}
              onNavigate={handleHyperlinkPopupNavigate}
              onCopy={handleHyperlinkPopupCopy}
              onEdit={handleHyperlinkPopupEdit}
              onRemove={handleHyperlinkPopupRemove}
              onClose={handleHyperlinkPopupClose}
              readOnly={readOnly}
            />

            {/* Right-click context menu */}
            <TextContextMenu
              isOpen={contextMenu.isOpen}
              position={contextMenu.position}
              hasSelection={contextMenu.hasSelection}
              isEditable={!readOnly}
              items={contextMenuItems}
              onAction={handleContextMenuAction}
              onClose={handleContextMenuClose}
            />

            {/* Toast notifications */}
            {/* Toast notifications provided by host app */}

            {/* Lazy-loaded dialogs — only fetched when first opened */}
            <Suspense fallback={null}>
              {findReplace.state.dialog.status === "open" && (
                <FindReplaceDialog
                  isOpen={true}
                  onClose={findReplace.close}
                  onFind={handleFind}
                  onFindNext={handleFindNext}
                  onFindPrevious={handleFindPrevious}
                  onReplace={handleReplace}
                  onReplaceAll={handleReplaceAll}
                  initialSearchText={findReplace.state.searchText}
                  replaceMode={findReplace.state.dialog.mode === "replace"}
                  currentResult={findResultRef.current}
                />
              )}
              {hyperlinkDialog.state.status !== "closed" && (
                <HyperlinkDialog
                  isOpen={true}
                  onClose={hyperlinkDialog.close}
                  onSubmit={handleHyperlinkSubmit}
                  isEditing={hyperlinkDialog.state.status === "edit"}
                  {...(hyperlinkDialog.state.status === "edit"
                    ? { onRemove: handleHyperlinkRemove }
                    : {})}
                  {...(hyperlinkDialog.state.status === "edit"
                    ? { initialData: hyperlinkDialog.state.initialData }
                    : {})}
                  {...(hyperlinkDialog.state.selectedText
                    ? { selectedText: hyperlinkDialog.state.selectedText }
                    : {})}
                />
              )}
              {tablePropsOpen && (
                <TablePropertiesDialog
                  isOpen={tablePropsOpen}
                  onClose={() => setTablePropsOpen(false)}
                  onApply={(props) => {
                    const view = getActiveEditorView();
                    if (view) {
                      setTableProperties(props)(view.state, view.dispatch);
                    }
                  }}
                  {...(state.pmTableContext?.table?.attrs
                    ? {
                        currentProps: state.pmTableContext.table
                          .attrs as Record<string, unknown>,
                      }
                    : {})}
                />
              )}
              {imagePositionOpen && (
                <ImagePositionDialog
                  isOpen={imagePositionOpen}
                  onClose={() => setImagePositionOpen(false)}
                  onApply={handleApplyImagePosition}
                />
              )}
              {imagePropsOpen && (
                <ImagePropertiesDialog
                  isOpen={imagePropsOpen}
                  onClose={() => setImagePropsOpen(false)}
                  onApply={handleApplyImageProperties}
                  {...(state.pmImageContext
                    ? {
                        currentData: (() => {
                          const data: Record<string, string | number> = {};
                          if (state.pmImageContext.alt != null) {
                            data["alt"] = state.pmImageContext.alt;
                          }
                          if (state.pmImageContext.borderWidth != null) {
                            data["borderWidth"] =
                              state.pmImageContext.borderWidth;
                          }
                          if (state.pmImageContext.borderColor != null) {
                            data["borderColor"] =
                              state.pmImageContext.borderColor;
                          }
                          if (state.pmImageContext.borderStyle != null) {
                            data["borderStyle"] =
                              state.pmImageContext.borderStyle;
                          }
                          return data as import("./dialogs/ImagePropertiesDialog").ImagePropertiesData;
                        })(),
                      }
                    : {})}
                />
              )}
              {showPageSetup && (
                <PageSetupDialog
                  isOpen={showPageSetup}
                  onClose={() => setShowPageSetup(false)}
                  onApply={handlePageSetupApply}
                  {...(history.state?.package.document?.finalSectionProperties
                    ? {
                        currentProps:
                          history.state.package.document.finalSectionProperties,
                      }
                    : {})}
                />
              )}
              {footnotePropsOpen && (
                <FootnotePropertiesDialog
                  isOpen={footnotePropsOpen}
                  onClose={() => setFootnotePropsOpen(false)}
                  onApply={handleApplyFootnoteProperties}
                  {...(history.state?.package.document?.finalSectionProperties
                    ?.footnotePr
                    ? {
                        footnotePr:
                          history.state.package.document.finalSectionProperties
                            .footnotePr,
                      }
                    : {})}
                  {...(history.state?.package.document?.finalSectionProperties
                    ?.endnotePr
                    ? {
                        endnotePr:
                          history.state.package.document.finalSectionProperties
                            .endnotePr,
                      }
                    : {})}
                />
              )}
            </Suspense>
            {/* InlineHeaderFooterEditor is rendered inside the editor content area (position:relative div) */}
            {/* Hidden file input for image insertion */}
            <input
              ref={imageInputRef}
              type="file"
              accept="image/*"
              style={{ display: "none" }}
              onChange={handleImageFileChange}
            />
          </div>
        </ErrorBoundary>
      </ErrorProvider>
    );
  },
);

// ============================================================================
// EXPORTS
// ============================================================================
