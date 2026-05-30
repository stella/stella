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
  Suspense,
  lazy,
  useRef,
  useCallback,
  useState,
  useEffect,
  useLayoutEffect,
  useMemo,
  useImperativeHandle,
} from "react";
import type { CSSProperties, Ref } from "react";

import {
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  EyeIcon,
  PenLineIcon,
  SquarePenIcon,
  StickyNoteIcon,
  XIcon,
} from "lucide-react";
// Paginated editor
import type { EditorView } from "prosemirror-view";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";
import {
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "@stll/ui/components/menu";
import {
  Select as StSelect,
  SelectItem as StSelectItem,
  SelectPopup as StSelectPopup,
  SelectTrigger as StSelectTrigger,
  SelectValue as StSelectValue,
} from "@stll/ui/components/select";

import {
  applyFolioAIEditOperations,
  createFolioAIEditSnapshot,
} from "../core/ai-edits";
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
  setRtl,
  setLtr,
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
  acceptAIEditRevision,
  rejectAIEditRevision,
  findAIEditRevisionRange,
  findChangeAtPosition,
  findNextChange,
  findPreviousChange,
} from "../core/prosemirror/commands/comments";
import { proseDocToBlocks } from "../core/prosemirror/conversion/fromProseDoc";
import { ExtensionManager } from "../core/prosemirror/extensions/ExtensionManager";
import {
  getChangedParagraphIds,
  hasStructuralChanges,
  hasUntrackedChanges,
  clearTrackedChanges,
} from "../core/prosemirror/extensions/features/ParagraphChangeTrackerExtension";
// Extension system
import { createStarterKit } from "../core/prosemirror/extensions/StarterKit";
import { createAICitationDecorationsPlugin } from "../core/prosemirror/plugins/aiCitationDecorations";
import { createAISuggestionDecorationsPlugin } from "../core/prosemirror/plugins/aiSuggestionDecorations";
import { createAnonymizationDecorationsPlugin } from "../core/prosemirror/plugins/anonymizationDecorations";
import {
  createSuggestionModePlugin,
  setSuggestionMode,
} from "../core/prosemirror/plugins/suggestionMode";
import type { Comment } from "../core/types/content";
import type {
  Document,
  SectionProperties,
  FootnoteProperties,
  EndnoteProperties,
} from "../core/types/document";
import { resolveColor } from "../core/utils/colorResolver";
import { queryHtmlElement } from "../core/utils/domGuards";
import { onFontsLoaded } from "../core/utils/fontLoader";
import type { HeadingInfo } from "../core/utils/headingCollector";
import { collectHeadings } from "../core/utils/headingCollector";
import { pointsToHalfPoints } from "../core/utils/units";
import { useDocumentHistory } from "../hooks/useHistory";
import { useTableSelection } from "../hooks/useTableSelection";
import { PagedEditor } from "../paged-editor/PagedEditor";
import type { PagedEditorRef } from "../paged-editor/PagedEditor";
import { clampRangeToDocSize, resolveFolioAIBlockRange } from "./aiEditRange";
import { resolveCommentCreationRange } from "./commentAnchors";
import {
  EMPTY_ANCHOR_POSITIONS,
  PENDING_COMMENT_ID,
  applyCommentMarkRange,
  collectCommentIdsFromSources,
  createComment,
  findSelectionYPosition,
  getCommentAuthorKey,
  getCommentParentId,
  getFallbackCommentYPosition,
  pruneOrphanedComments,
  removePendingCommentMarkRange,
} from "./commentsHelpers";
import type { TrackedChangeEntry } from "./CommentsSidebar";
// Dialog hooks and utilities (static imports — lightweight, no UI)
import type { FindMatch } from "./dialogs/findReplaceUtils";
import type { ImagePropertiesData } from "./dialogs/ImagePropertiesDialog";
import { useFindReplace as useFindReplaceState } from "./dialogs/useFindReplace";
import { DocumentOutline } from "./DocumentOutline";
import type {
  DocxEditorProps,
  DocxEditorRef,
  EditorState,
} from "./DocxEditor.props";
import { DocxEditorDialogs } from "./DocxEditorDialogs";
import {
  DefaultLoadingIndicator,
  DefaultPlaceholder,
  ParseError,
} from "./DocxEditorHelpers";
import { ErrorBoundary, ErrorProvider } from "./ErrorBoundary";
import { FormattingBar } from "./FormattingBar";
import { resolveFindMatchRange } from "./hooks/findReplaceSelection";
import { useContextMenu } from "./hooks/useContextMenu";
import type { DocumentLoadState } from "./hooks/useDocumentLoader";
import { useDocumentLoader } from "./hooks/useDocumentLoader";
import type { DisplayMode } from "./hooks/useEditorMode";
import { useEditorMode } from "./hooks/useEditorMode";
import { useFindReplace } from "./hooks/useFindReplace";
import { useHeaderFooterEditor } from "./hooks/useHeaderFooterEditor";
import { useHyperlinkHandlers } from "./hooks/useHyperlinkHandlers";
import { useImageHandlers } from "./hooks/useImageHandlers";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";
import { useZoomAndPageInfo } from "./hooks/useZoomAndPageInfo";
import { InlineHeaderFooterEditor } from "./InlineHeaderFooterEditor";
import type { InlineHeaderFooterEditorRef } from "./InlineHeaderFooterEditor";
import { updateScrollPageTotal } from "./scrollPageInfo";
import {
  detectActiveTrackedChange,
  detectImageContext,
} from "./selectionDetection";
import {
  buildSelectionFormatting,
  extractListState,
} from "./selectionFormattingBuilder";
import type { TextContextAction, TextContextMenuItem } from "./TextContextMenu";
import { ToolbarButton, ToolbarSeparator } from "./Toolbar";
import type { FormattingAction } from "./Toolbar";
import {
  areSelectionFormattingEqual,
  mapHexToHighlightName,
} from "./toolbarUtils";
import { HyperlinkPopup } from "./ui/HyperlinkPopup";
import { getBuiltinTableStyle } from "./ui/table-styles";
import type { TableStylePreset } from "./ui/table-styles";
import type { TableAction } from "./ui/table-types";
import { Tooltip } from "./ui/Tooltip";

const CommentsSidebar = lazy(() =>
  import("./CommentsSidebar").then((m) => ({
    default: m.CommentsSidebar,
  })),
);

const TextContextMenu = lazy(() =>
  import("./TextContextMenu").then((m) => ({
    default: m.TextContextMenu,
  })),
);

const loadAttemptSelectiveSave = async () => {
  const { attemptSelectiveSave } = await import("../core/docx/selectiveSave");
  return attemptSelectiveSave;
};

const loadRepackDocx = async () => {
  const { repackDocx } = await import("../core/docx/rezip");
  return repackDocx;
};

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

// Dialog tree (lazy-loaded internally) lives in ./DocxEditorDialogs.

// ============================================================================
// TYPES — `DocxEditorProps` / `DocxEditorRef` live in `./DocxEditor.props`,
// `EditorMode` / `DisplayMode` in `./hooks/useEditorMode`. The package barrel
// (`src/index.ts`) imports them from those canonical homes directly; no
// re-export shim here.
// ============================================================================

// ============================================================================
// MAIN COMPONENT
// ============================================================================

// Comment helpers and the in-process id allocator live in ./commentsHelpers.

function buildImagePropertiesData(
  ctx: EditorState["pmImageContext"],
): ImagePropertiesData | undefined {
  if (!ctx) {
    return undefined;
  }
  const data: ImagePropertiesData = {};
  if (ctx.alt != null) {
    data.alt = ctx.alt;
  }
  if (ctx.borderWidth != null) {
    data.borderWidth = ctx.borderWidth;
  }
  if (ctx.borderColor != null) {
    data.borderColor = ctx.borderColor;
  }
  if (ctx.borderStyle != null) {
    data.borderStyle = ctx.borderStyle;
  }
  return data;
}

/**
 * Shared empty formatting object for selections that carry no formatting
 * (e.g. no active selection). Reusing one reference lets the selection
 * `setState` bail out instead of allocating a fresh `{}` each time.
 */
const EMPTY_SELECTION_FORMATTING: EditorState["selectionFormatting"] = {};

/**
 * Structural equality for the ProseMirror table context. `getTableContext`
 * returns a fresh object on every selection change; comparing by value lets
 * the selection `setState` preserve the previous reference and skip a render.
 */
function areTableContextsEqual(
  a: EditorState["pmTableContext"],
  b: EditorState["pmTableContext"],
): boolean {
  if (a === b) {
    return true;
  }
  if (!a || !b) {
    return false;
  }
  return (
    a.isInTable === b.isInTable &&
    a.table === b.table &&
    a.tablePos === b.tablePos &&
    a.rowIndex === b.rowIndex &&
    a.columnIndex === b.columnIndex &&
    a.rowCount === b.rowCount &&
    a.columnCount === b.columnCount &&
    a.hasMultiCellSelection === b.hasMultiCellSelection &&
    a.canSplitCell === b.canSplitCell &&
    a.cellBorderColor === b.cellBorderColor &&
    a.cellBackgroundColor === b.cellBackgroundColor
  );
}

/** Structural equality for the image context surfaced to the toolbar. */
function areImageContextsEqual(
  a: EditorState["pmImageContext"],
  b: EditorState["pmImageContext"],
): boolean {
  if (a === b) {
    return true;
  }
  if (!a || !b) {
    return false;
  }
  return (
    a.pos === b.pos &&
    a.wrapType === b.wrapType &&
    a.displayMode === b.displayMode &&
    a.cssFloat === b.cssFloat &&
    a.transform === b.transform &&
    a.alt === b.alt &&
    a.borderWidth === b.borderWidth &&
    a.borderColor === b.borderColor &&
    a.borderStyle === b.borderStyle
  );
}

/** Structural equality for the active tracked-change context. */
function areActiveTrackedChangesEqual(
  a: EditorState["activeTrackedChange"],
  b: EditorState["activeTrackedChange"],
): boolean {
  if (a === b) {
    return true;
  }
  if (!a || !b) {
    return false;
  }
  return (
    a.type === b.type &&
    a.author === b.author &&
    a.date === b.date &&
    a.from === b.from &&
    a.to === b.to
  );
}

/**
 * DocxEditor - Complete DOCX editor component
 */
export function DocxEditor({
  ref,
  documentBuffer,
  document: initialDocument,
  onSave,
  author = "User",
  onChange,
  onSelectionChange,
  onSelectionTextChange,
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
  preserveDocumentWhileLoading = false,
  initialScrollTop,
  onScrollTopChange,
  showOutline: showOutlineProp = true,
  onPrint,
  onCopy: _onCopy,
  onCut: _onCut,
  onPaste: _onPaste,
  mode: modeProp,
  onModeChange,
  onReadonlyEditAttempt,
  onCompatibilityChange,
  onEditorViewReady,
  onAnonymizationMatchesChange,
  onAnonymizationTermClick,
  selectedAnonymizationCanonical = null,
  anonymizationSelectionSeq,
  collaboration,
  featureFlags,
  onSelectiveSaveTripwire,
}: DocxEditorProps & { ref?: Ref<DocxEditorRef> }) {
  const t = useTranslations("folio");

  // State
  const [state, setState] = useState<EditorState>({
    documentLoad: documentBuffer ? { status: "loading" } : { status: "ready" },
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
  const [outlineHeadings, setHeadingInfos] = useState<HeadingInfo[]>([]);

  // Comments sidebar state
  const [showCommentsSidebar, setShowCommentsSidebar] = useState(false);
  const [visibleCommentAuthors, setVisibleCommentAuthors] =
    useState<Set<string> | null>(null);
  const [activeCommentId, setActiveCommentId] = useState<number | null>(null);
  const [comments, setComments] = useState<Comment[]>([]);
  const commentsDirtyRef = useRef(false);
  const commentsRef = useRef<Comment[]>([]);
  commentsRef.current = comments;
  const [, setTrackedChanges] = useState<TrackedChangeEntry[]>([]);
  const [anchorPositions, setAnchorPositions] = useState<Map<string, number>>(
    EMPTY_ANCHOR_POSITIONS,
  );

  const [isAddingComment, setIsAddingComment] = useState(false);
  const [commentSelectionRange, setCommentSelectionRange] = useState<{
    from: number;
    to: number;
  } | null>(null);
  const [addCommentYPosition, setAddCommentYPosition] = useState<number | null>(
    null,
  );
  const {
    editingMode,
    readOnly,
    trackChangesOn,
    toggleTrackChanges,
    displayMode,
    setDisplayMode,
  } = useEditorMode({
    modeProp,
    onModeChange,
    readOnlyProp,
  });

  // Floating "add comment" button position (relative to scroll container, null = hidden)
  const [floatingCommentBtn, setFloatingCommentBtn] = useState<{
    top: number;
    left: number;
    from: number;
    to: number;
  } | null>(null);

  // Debounce timer for extractTrackedChanges (avoid full doc walk on every keystroke)
  const extractTrackedChangesTimerRef = useRef<ReturnType<
    typeof setTimeout
  > | null>(null);

  // Debounce timer for collectHeadings — same reasoning as tracked changes:
  // a doc-wide descend on every keystroke stalls typing on large documents.
  const collectHeadingsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );

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

  // Clean up debounce timers on unmount
  useEffect(
    () => () => {
      if (extractTrackedChangesTimerRef.current) {
        clearTimeout(extractTrackedChangesTimerRef.current);
      }
      if (collectHeadingsTimerRef.current) {
        clearTimeout(collectHeadingsTimerRef.current);
      }
    },
    [],
  );

  // Sync outline visibility when prop changes
  useEffect(() => {
    setShowOutline(showOutlineProp);
  }, [showOutlineProp]);

  // History hook for undo/redo - start with null document
  const history = useDocumentHistory<Document | null>(initialDocument || null, {
    maxEntries: 100,
    groupingInterval: 500,
    enableKeyboardShortcuts: true,
  });

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
    const bodyComments = doc.package.document.comments;
    if (bodyComments && bodyComments.length > 0) {
      setComments(bodyComments);
      setVisibleCommentAuthors(null);
      setActiveCommentId(null);
      if (autoOpenReviewSidebar) {
        setShowCommentsSidebar(true);
      }
      commentsLoadedRef.current = true;
    }
  }, [autoOpenReviewSidebar, history.state]);

  const commentAuthors = useMemo(() => {
    const seen = new Set<string>();
    const authors: string[] = [];
    for (const comment of comments) {
      const commentAuthor = getCommentAuthorKey(comment.author);
      if (!seen.has(commentAuthor)) {
        seen.add(commentAuthor);
        authors.push(commentAuthor);
      }
    }
    return authors;
  }, [comments]);

  const visibleCommentAuthorSet = useMemo(
    () => visibleCommentAuthors ?? new Set(commentAuthors),
    [visibleCommentAuthors, commentAuthors],
  );

  const visibleCommentIds = useMemo(() => {
    const ids = new Set<number>([PENDING_COMMENT_ID]);
    for (const comment of comments) {
      if (visibleCommentAuthorSet.has(getCommentAuthorKey(comment.author))) {
        ids.add(comment.id);
      }
    }
    return ids;
  }, [comments, visibleCommentAuthorSet]);

  const visibleComments = useMemo(() => {
    const visibleRootIds = new Set<number>();
    for (const comment of comments) {
      const parentId = getCommentParentId(comment);
      if (
        parentId === null ||
        parentId === undefined ||
        !visibleCommentIds.has(comment.id)
      ) {
        continue;
      }
      visibleRootIds.add(parentId);
    }
    return comments.filter((comment) => {
      const parentId = getCommentParentId(comment);
      if (parentId !== null && parentId !== undefined) {
        return visibleCommentIds.has(comment.id);
      }
      return (
        visibleCommentIds.has(comment.id) || visibleRootIds.has(comment.id)
      );
    });
  }, [comments, visibleCommentIds]);

  const activeCommentVisible =
    activeCommentId !== null && visibleCommentIds.has(activeCommentId);

  useEffect(() => {
    if (!activeCommentVisible) {
      setActiveCommentId(null);
    }
  }, [activeCommentVisible]);

  // Extension manager — built once, provides schema + plugins + commands
  const extensionManager = useMemo(() => {
    const mgr = new ExtensionManager(createStarterKit());
    mgr.buildSchema();
    mgr.initializeRuntime();
    return mgr;
  }, []);

  // Suggestion mode plugin
  const suggestionPlugin = useMemo(
    () => createSuggestionModePlugin(editingMode === "suggesting", author),
    [], // eslint-disable-line react-hooks/exhaustive-deps
  );
  // AI suggestion decorations — non-mutating overlay for the review
  // queue. Always present; the plugin renders nothing until
  // suggestions are pushed in.
  const aiSuggestionPlugin = useMemo(
    () => createAISuggestionDecorationsPlugin(),
    [],
  );
  // AI citation decorations — pointers from chat answers / extraction
  // justifications back to source ranges. Distinct visual from
  // suggestions; renders nothing until citations are pushed in.
  const aiCitationPlugin = useMemo(
    () => createAICitationDecorationsPlugin(),
    [],
  );
  // Workspace anonymization-term highlights. Always installed;
  // renders nothing until the host pushes a term list via
  // `setAnonymizationTermsMeta`.
  // Hold the callback in a ref so the plugin instance is stable
  // across re-renders even when the parent passes a fresh
  // closure each time. The ref always points at the latest
  // function, so the plugin's view spec calls into the most
  // recent host implementation without forcing PM to swap
  // plugins (which would reset its state).
  const onAnonymizationMatchesChangeRef = useRef(onAnonymizationMatchesChange);
  onAnonymizationMatchesChangeRef.current = onAnonymizationMatchesChange;
  const anonymizationDecorationsPlugin = useMemo(
    () =>
      createAnonymizationDecorationsPlugin({
        onMatchesChange: (matches) => {
          onAnonymizationMatchesChangeRef.current?.(matches);
        },
      }),
    [],
  );
  const editorPlugins = useMemo(
    () => [
      ...(collaboration?.plugins ?? []),
      suggestionPlugin,
      aiSuggestionPlugin,
      aiCitationPlugin,
      anonymizationDecorationsPlugin,
    ],
    [
      collaboration?.plugins,
      suggestionPlugin,
      aiSuggestionPlugin,
      aiCitationPlugin,
      anonymizationDecorationsPlugin,
    ],
  );

  // Surface the live PM view to the host for AI overlay wiring.
  // We watch `history.state` because the document re-loads (e.g.,
  // unlocking from preview into editing) re-mount the PagedEditor
  // and replace the view instance.
  const lastReportedViewRef = useRef<EditorView | null>(null);
  useEffect(() => {
    if (!onEditorViewReady) {
      return;
    }
    const view = pagedEditorRef.current?.getView() ?? null;
    if (lastReportedViewRef.current === view) {
      return;
    }
    lastReportedViewRef.current = view;
    onEditorViewReady(view);
  }, [onEditorViewReady, history.state]);
  useEffect(() => {
    if (!onEditorViewReady) {
      return;
    }
    return () => {
      if (lastReportedViewRef.current !== null) {
        lastReportedViewRef.current = null;
        onEditorViewReady(null);
      }
    };
  }, [onEditorViewReady]);

  // Refresh outline headings when the document loads or the outline is enabled.
  // handleDocumentChange keeps it in sync after subsequent edits. Page-number
  // resolution depends on the paged layout having run at least once, so we
  // retry briefly until every heading has a page or we give up.
  useEffect(() => {
    if (!showOutline) {
      return;
    }
    const view = pagedEditorRef.current?.getView();
    if (!view) {
      return;
    }
    const headings = collectHeadings(view.state.doc);
    setHeadingInfos(headings);

    let attempts = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const fill = () => {
      attempts++;
      const pagedRef = pagedEditorRef.current;
      if (!pagedRef) {
        return;
      }
      let unresolved = false;
      for (const heading of headings) {
        if (heading.pageNumber == null) {
          const page = pagedRef.getPageNumberForPmPos(heading.pmPos);
          if (page !== null) {
            heading.pageNumber = page;
          } else {
            unresolved = true;
          }
        }
      }
      // Push a fresh array so React picks up the mutated entries.
      setHeadingInfos([...headings]);
      if (unresolved && attempts < 10) {
        timer = setTimeout(fill, 300);
      }
    };
    timer = setTimeout(fill, 100);
    return () => {
      if (timer) {
        clearTimeout(timer);
      }
    };
  }, [showOutline, history.state]);

  // Refs
  const pagedEditorRef = useRef<PagedEditorRef>(null);
  const hfEditorRef = useRef<InlineHeaderFooterEditorRef>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  // Save the last known selection for restoring after toolbar interactions
  const lastSelectionRef = useRef<{ from: number; to: number } | null>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const editorContentRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  const {
    contextMenu,
    openMenu: openContextMenu,
    closeMenu: closeContextMenu,
  } = useContextMenu({ pagedEditorRef });
  const toolbarWrapperRef = useRef<HTMLDivElement>(null);
  const toolbarRoRef = useRef<ResizeObserver | null>(null);
  const [toolbarHeight, setToolbarHeight] = useState(0);
  // Keep history.state accessible in stable callbacks without stale closures
  const historyStateRef = useRef(history.state);
  historyStateRef.current = history.state;
  // Track current border color/width for border presets (like Google Docs)
  const borderSpecRef = useRef({
    style: "single",
    size: 4,
    color: { rgb: "000000" },
  });

  const syncCommentHighlightStyles = useCallback(() => {
    const root = editorContentRef.current;
    if (!root) {
      return;
    }

    const nodes = root.querySelectorAll<HTMLElement>(
      ".layout-run-text[data-comment-id]",
    );
    for (const node of nodes) {
      const commentId = Number.parseInt(node.dataset["commentId"] ?? "", 10);
      const isPending = commentId === PENDING_COMMENT_ID;
      const isVisible = isPending || visibleCommentIds.has(commentId);
      if (!isVisible) {
        node.style.backgroundColor = "transparent";
        node.style.borderBottom = "2px solid transparent";
        node.style.boxShadow = "none";
        delete node.dataset["activeComment"];
        continue;
      }

      if (activeCommentId === commentId) {
        node.style.backgroundColor =
          "var(--doc-comment-active-bg, rgba(255, 212, 0, 0.22))";
        node.style.borderBottom =
          "1px solid var(--doc-comment-active-border, rgba(180, 130, 0, 0.62))";
        node.style.boxShadow = "none";
        node.dataset["activeComment"] = "true";
        continue;
      }

      node.style.backgroundColor =
        "var(--doc-comment-bg, rgba(255, 212, 0, 0.08))";
      node.style.borderBottom =
        "1px solid var(--doc-comment-border, rgba(180, 130, 0, 0.24))";
      node.style.boxShadow = "none";
      delete node.dataset["activeComment"];
    }
  }, [visibleCommentIds, activeCommentId]);

  useLayoutEffect(() => {
    syncCommentHighlightStyles();
  }, [syncCommentHighlightStyles, anchorPositions]);

  useEffect(() => {
    syncCommentHighlightStyles();
    const firstFrame = requestAnimationFrame(() => {
      syncCommentHighlightStyles();
      requestAnimationFrame(syncCommentHighlightStyles);
    });
    const timeout = setTimeout(syncCommentHighlightStyles, 120);
    return () => {
      cancelAnimationFrame(firstFrame);
      clearTimeout(timeout);
    };
  }, [comments.length, syncCommentHighlightStyles]);
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

  const {
    zoom,
    zoomRef,
    setZoomWithViewportAnchor,
    scrollPageInfo,
    setScrollPageInfo,
  } = useZoomAndPageInfo({
    scrollContainerRef,
    pagedEditorRef,
    initialZoom,
  });
  const [bodyHistoryAvailability, setBodyHistoryAvailability] = useState({
    canRedo: false,
    canUndo: false,
  });

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
    activeHeaderRId,
    activeFooterRId,
    activeFirstHeaderRId,
    activeFirstFooterRId,
    effectiveSectionProperties,
    handleHeaderFooterDoubleClick,
    handleBodyClick,
    handleRemoveHeaderFooter,
  } = useHeaderFooterEditor({
    history,
    pushDocument,
    // Hook reads live HF PM state at close time (the in-place sync
    // that previously kept package.headers/footers current per
    // keystroke was removed to fix the undo-corruption bug; the
    // close path now flushes via this callback). PagedEditor's ref
    // exposes per-rId view lookup; the hook supplies the rId it
    // already resolved internally for save / remove.
    getHfView: (rId) => pagedEditorRef.current?.getHfView(rId) ?? null,
  });

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

  // Page setup dialog state
  const [showPageSetup, setShowPageSetup] = useState(false);

  // Hyperlink handlers (popup state, navigation, etc.)
  const {
    hyperlinkPopupData,
    handleHyperlinkClick,
    handleHyperlinkPopupNavigate,
    handleHyperlinkPopupCopy,
    handleHyperlinkPopupEdit,
    handleHyperlinkPopupRemove,
    handleHyperlinkPopupClose,
  } = useHyperlinkHandlers({
    getActiveEditorView,
    focusActiveEditor,
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
      onCompatibilityChange,
      onReset: useCallback(() => {
        commentsDirtyRef.current = false;
        commentsLoadedRef.current = false;
        trackedChangesLoadedRef.current = false;
        setComments([]);
        setTrackedChanges([]);
        setVisibleCommentAuthors(null);
        setActiveCommentId(null);
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
        if (collectHeadingsTimerRef.current) {
          clearTimeout(collectHeadingsTimerRef.current);
          collectHeadingsTimerRef.current = null;
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
      const currentComments = commentsRef.current;
      const documentWithComments = {
        ...newDocument,
        package: {
          ...newDocument.package,
          document: {
            ...newDocument.package.document,
            comments: currentComments,
          },
        },
      };
      pushDocument(documentWithComments);
      onChange?.(documentWithComments);
      // Update outline headings if sidebar is open (debounced — collectHeadings
      // descends the whole doc, expensive on large files).
      if (showOutlineRef.current) {
        if (collectHeadingsTimerRef.current) {
          clearTimeout(collectHeadingsTimerRef.current);
        }
        collectHeadingsTimerRef.current = setTimeout(() => {
          const view = pagedEditorRef.current?.getView();
          if (view) {
            const headings = collectHeadings(view.state.doc);
            const pagedRef = pagedEditorRef.current;
            for (const heading of headings) {
              heading.pageNumber =
                pagedRef?.getPageNumberForPmPos(heading.pmPos) ?? null;
            }
            setHeadingInfos(headings);
          }
        }, 400);
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

  const buildCurrentDocument = useCallback(() => {
    if (!history.state) {
      return null;
    }

    const doc = structuredClone(history.state);
    const pmDoc = pagedEditorRef.current?.getDocument();
    if (pmDoc) {
      doc.package.document.content = pmDoc.package.document.content;
    }
    // Flush in-flight HF PM edits into the cloned package — the persistent
    // hidden HF EditorViews don't mutate history.state per keystroke
    // (Codex #487 P1: 20:18 review), so a "Save As .docx" called while the
    // chrome is still open would otherwise ship the pre-edit content for
    // every rId the user touched (Codex #487 P1 follow-up: 20:52 review).
    // We walk the cloned headers / footers (structuredClone gave us fresh
    // HF objects), look up the matching persistent view, and overwrite
    // each rId's `.content` with `proseDocToBlocks(view.state.doc)`. The
    // original history.state remains untouched because every mutation
    // lands on the cloned Map / HF objects.
    const editor = pagedEditorRef.current;
    if (editor) {
      const flushBag = (bag: Map<string, { content: unknown }> | undefined) => {
        if (!bag) {
          return;
        }
        for (const [rId, hf] of bag) {
          const view = editor.getHfView(rId);
          if (view) {
            hf.content = proseDocToBlocks(view.state.doc);
          }
        }
      };
      flushBag(
        doc.package.headers as Map<string, { content: unknown }> | undefined,
      );
      flushBag(
        doc.package.footers as Map<string, { content: unknown }> | undefined,
      );
    }
    // Drop comment threads whose anchor text has been edited away. The
    // in-memory `comments` array can outlive its in-body anchors (PM
    // removes the mark when its text is deleted, but the array entry
    // stays put), and serializing the unfiltered array writes
    // unanchored threads into `comments.xml` that no reader can
    // resolve.
    // Collect anchors from every part of the doc that can carry a
    // comment marker — body, headers, footers, footnotes, endnotes.
    // A body-only walk would prune legitimate header/footer/note
    // comments because their anchors live outside `document.content`.
    const referencedCommentIds = collectCommentIdsFromSources(
      doc.package.document.content,
      doc.package.headers,
      doc.package.footers,
      doc.package.footnotes,
      doc.package.endnotes,
    );
    doc.package.document.comments = pruneOrphanedComments(
      commentsRef.current,
      referencedCommentIds,
    );
    return doc;
  }, [history.state]);

  const replaceComments = useCallback(
    (nextComments: Comment[]) => {
      commentsDirtyRef.current = true;
      commentsRef.current = nextComments;
      setComments(nextComments);

      const currentDocument = buildCurrentDocument();
      if (!currentDocument) {
        return;
      }

      onChange?.(currentDocument);
    },
    [buildCurrentDocument, onChange],
  );

  const updateComments = useCallback(
    (updater: (comments: Comment[]) => Comment[]) => {
      replaceComments(updater(commentsRef.current));
    },
    [replaceComments],
  );

  const selectFindMatch = useCallback((match: FindMatch): boolean => {
    const editor = pagedEditorRef.current;
    const view = editor?.getView();
    if (!editor || !view) {
      return false;
    }

    const range = resolveFindMatchRange(view.state.doc, match);
    if (!range) {
      return false;
    }

    editor.setSelection(range.from, range.to);
    requestAnimationFrame(() => {
      editor.scrollToPosition(range.from);
    });
    return true;
  }, []);

  // Find/Replace handlers (depends on handleDocumentChange)
  const {
    findResultRef,
    handleFind,
    handleFindNext,
    handleFindPrevious,
    handleReplace,
    handleReplaceAll,
  } = useFindReplace({
    getDocumentState: buildCurrentDocument,
    containerRef,
    handleDocumentChange,
    findReplace,
    selectMatch: selectFindMatch,
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
          rgb = resolved.replace(/^#/u, "");
        }
        borderSpecRef.current = {
          ...borderSpecRef.current,
          color: { rgb },
        };
      }

      // Image context (when the selection is a NodeSelection of an image)
      // and active tracked-change at the cursor live in pure helpers so the
      // logic is unit-tested without spinning up a real component.
      const pmImageCtx = view ? detectImageContext(view.state) : null;
      const trackedChange = view ? detectActiveTrackedChange(view.state) : null;

      if (!selectionState) {
        setFloatingCommentBtn(null);
        setState((prev) => {
          const selectionFormatting = areSelectionFormattingEqual(
            prev.selectionFormatting,
            EMPTY_SELECTION_FORMATTING,
          )
            ? prev.selectionFormatting
            : EMPTY_SELECTION_FORMATTING;
          const pmTableContext = areTableContextsEqual(
            prev.pmTableContext,
            pmTableCtx,
          )
            ? prev.pmTableContext
            : pmTableCtx;
          const pmImageContext = areImageContextsEqual(
            prev.pmImageContext,
            pmImageCtx,
          )
            ? prev.pmImageContext
            : pmImageCtx;
          const activeTrackedChange = areActiveTrackedChangesEqual(
            prev.activeTrackedChange,
            trackedChange,
          )
            ? prev.activeTrackedChange
            : trackedChange;
          if (
            selectionFormatting === prev.selectionFormatting &&
            pmTableContext === prev.pmTableContext &&
            pmImageContext === prev.pmImageContext &&
            activeTrackedChange === prev.activeTrackedChange
          ) {
            return prev;
          }
          return {
            ...prev,
            selectionFormatting,
            pmTableContext,
            pmImageContext,
            activeTrackedChange,
          };
        });
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

      const listState = extractListState(paragraphFormatting.numPr);
      const formatting = buildSelectionFormatting({
        selectionState,
        fontFamily,
        fontSize,
        textColor,
        listState,
      });
      setState((prev) => {
        const selectionFormatting = areSelectionFormattingEqual(
          prev.selectionFormatting,
          formatting,
        )
          ? prev.selectionFormatting
          : formatting;
        const pmTableContext = areTableContextsEqual(
          prev.pmTableContext,
          pmTableCtx,
        )
          ? prev.pmTableContext
          : pmTableCtx;
        const pmImageContext = areImageContextsEqual(
          prev.pmImageContext,
          pmImageCtx,
        )
          ? prev.pmImageContext
          : pmImageCtx;
        const activeTrackedChange = areActiveTrackedChangesEqual(
          prev.activeTrackedChange,
          trackedChange,
        )
          ? prev.activeTrackedChange
          : trackedChange;
        const paragraphIndentLeft = paragraphFormatting.indentLeft ?? 0;
        const paragraphIndentRight = paragraphFormatting.indentRight ?? 0;
        const paragraphFirstLineIndent =
          paragraphFormatting.indentFirstLine ?? 0;
        const paragraphHangingIndent =
          paragraphFormatting.hangingIndent ?? false;
        const paragraphTabs = paragraphFormatting.tabs ?? null;
        if (
          selectionFormatting === prev.selectionFormatting &&
          pmTableContext === prev.pmTableContext &&
          pmImageContext === prev.pmImageContext &&
          activeTrackedChange === prev.activeTrackedChange &&
          paragraphIndentLeft === prev.paragraphIndentLeft &&
          paragraphIndentRight === prev.paragraphIndentRight &&
          paragraphFirstLineIndent === prev.paragraphFirstLineIndent &&
          paragraphHangingIndent === prev.paragraphHangingIndent &&
          paragraphTabs === prev.paragraphTabs
        ) {
          return prev;
        }
        return {
          ...prev,
          selectionFormatting,
          paragraphIndentLeft,
          paragraphIndentRight,
          paragraphFirstLineIndent,
          paragraphHangingIndent,
          paragraphTabs,
          pmTableContext,
          pmImageContext,
          activeTrackedChange,
        };
      });

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
        if (top !== null && container && parentEl) {
          const pagesEl = container.querySelector(".paged-editor__pages");
          const pageEl =
            pagesEl instanceof Element
              ? queryHtmlElement(pagesEl, ".layout-page")
              : null;
          const parentRect = parentEl.getBoundingClientRect();
          const rawLeft = pageEl
            ? pageEl.getBoundingClientRect().right - parentRect.left + 12
            : parentRect.width / 2 + 408;
          const left = Math.max(16, Math.min(rawLeft, parentRect.width - 16));
          const { from, to } = view.state.selection;
          if (from !== to) {
            setFloatingCommentBtn({ top, left, from, to });
          } else {
            setFloatingCommentBtn(null);
          }
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
    const pagesCloneRaw = pages.cloneNode(true);
    if (!(pagesCloneRaw instanceof HTMLElement)) {
      return;
    }
    const pagesClone = pagesCloneRaw;
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

    const cleanupState = { isCleanedUp: false };
    const cleanup = () => {
      if (cleanupState.isCleanedUp) {
        return;
      }
      cleanupState.isCleanedUp = true;
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
      if (cleanupState.isCleanedUp) {
        return;
      }
      printWindow.focus();
      printWindow.print();
    })();
  }, [onPrint, t]);

  useKeyboardShortcuts({
    pagedEditorRef,
    findReplace,
    tableSelection,
    onDirectPrint: handleDirectPrint,
  });

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
          setAllTableBorders(view.state, view.dispatch, borderSpecRef.current);
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
              const rgb = action.color.replace(/^#/u, "");
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
                color: { rgb: action.color.replace(/^#/u, "") },
              })(view.state, view.dispatch);
            } else if (action.type === "cellVerticalAlign") {
              setCellVerticalAlign(action.align)(view.state, view.dispatch);
            } else if (action.type === "cellMargins") {
              setCellMargins(action.margins)(view.state, view.dispatch);
            } else if (action.type === "cellTextDirection") {
              setCellTextDirection(action.direction)(view.state, view.dispatch);
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
            } else {
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
  const handleEditorContextMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      openContextMenu({ x: e.clientX, y: e.clientY });
    },
    [openContextMenu],
  );

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

      const commandState = view.state;

      // Handle simple toggle actions
      if (action === "bold") {
        toggleBold(commandState, view.dispatch);
        return;
      }
      if (action === "italic") {
        toggleItalic(commandState, view.dispatch);
        return;
      }
      if (action === "underline") {
        toggleUnderline(commandState, view.dispatch);
        return;
      }
      if (action === "strikethrough") {
        toggleStrike(commandState, view.dispatch);
        return;
      }
      if (action === "superscript") {
        toggleSuperscript(commandState, view.dispatch);
        return;
      }
      if (action === "subscript") {
        toggleSubscript(commandState, view.dispatch);
        return;
      }
      if (action === "bulletList") {
        toggleBulletList(commandState, view.dispatch);
        return;
      }
      if (action === "numberedList") {
        toggleNumberedList(commandState, view.dispatch);
        return;
      }
      if (action === "indent") {
        // Try list indent first, then paragraph indent
        if (!increaseListLevel(commandState, view.dispatch)) {
          increaseIndent()(commandState, view.dispatch);
        }
        return;
      }
      if (action === "outdent") {
        // Try list outdent first, then paragraph outdent
        if (!decreaseListLevel(commandState, view.dispatch)) {
          decreaseIndent()(commandState, view.dispatch);
        }
        return;
      }
      if (action === "clearFormatting") {
        clearFormatting(commandState, view.dispatch);
        return;
      }
      if (action === "setRtl") {
        setRtl(commandState, view.dispatch);
        return;
      }
      if (action === "setLtr") {
        setLtr(commandState, view.dispatch);
        return;
      }

      // Handle object-based actions
      if (typeof action === "object") {
        switch (action.type) {
          case "alignment":
            setAlignment(action.value)(commandState, view.dispatch);
            break;
          case "textColor": {
            // action.value can be a ColorValue object or a string like "#FF0000"
            const colorVal = action.value;
            if (typeof colorVal === "string") {
              setTextColor({ rgb: colorVal.replace("#", "") })(
                commandState,
                view.dispatch,
              );
            } else if (colorVal.auto) {
              // "Automatic" — remove text color
              clearTextColor(commandState, view.dispatch);
            } else {
              setTextColor(colorVal)(commandState, view.dispatch);
            }
            break;
          }
          case "highlightColor": {
            // Convert hex to OOXML named highlight value (e.g., 'FFFF00' → 'yellow')
            const highlightName = action.value
              ? mapHexToHighlightName(action.value)
              : "";
            setHighlight(highlightName || action.value)(
              commandState,
              view.dispatch,
            );
            break;
          }
          case "fontSize":
            // Convert points to half-points (OOXML uses half-points for font sizes)
            setFontSize(pointsToHalfPoints(action.value))(
              commandState,
              view.dispatch,
            );
            break;
          case "fontFamily":
            setFontFamily(action.value)(commandState, view.dispatch);
            break;
          case "lineSpacing":
            setLineSpacing(action.value)(commandState, view.dispatch);
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
              applyStyle(action.value, styleAttrs)(commandState, view.dispatch);
            } else {
              // No styles available, just set the styleId
              applyStyle(action.value)(commandState, view.dispatch);
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

  const handleContextMenu = useCallback(
    (data: { x: number; y: number; hasSelection: boolean }) => {
      openContextMenu({ x: data.x, y: data.y }, data.hasSelection);
    },
    [openContextMenu],
  );

  const handleContextMenuClose = closeContextMenu;

  const contextMenuItems = useMemo((): TextContextMenuItem[] => {
    const isMac =
      typeof navigator !== "undefined" && navigator.platform.includes("Mac");
    const mod = isMac ? "⌘" : "Ctrl";
    if (readOnly) {
      return [
        { action: "copy", label: t("copy"), shortcut: `${mod}+C` },
        {
          action: "selectAll",
          label: t("selectAll"),
          shortcut: `${mod}+A`,
        },
      ];
    }
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
    readOnly,
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

      if (readOnly && action !== "copy" && action !== "selectAll") {
        return;
      }

      switch (action) {
        case "cut": {
          if (readOnly) {
            return;
          }
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
          if (readOnly) {
            return;
          }
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
          const commentY =
            yPos ?? getFallbackCommentYPosition(scrollContainerRef.current);
          setCommentSelectionRange({ from, to });
          const marked = applyCommentMarkRange(
            view,
            { from, to },
            PENDING_COMMENT_ID,
            {
              selectEnd: true,
            },
          );
          if (!marked) {
            break;
          }
          setAddCommentYPosition(commentY);
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
        case "separator":
          // Separators are visual dividers in the menu, never
          // emitted as an actual user action.
          break;
      }
      // TextContextMenu calls onClose after onAction, so no need to close here
    },
    [
      getActiveEditorView,
      focusActiveEditor,
      readOnly,
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

  // Handle save
  const handleSave = useCallback(
    async (options?: { selective?: boolean }): Promise<ArrayBuffer | null> => {
      let tripwireResult:
        | Parameters<NonNullable<typeof onSelectiveSaveTripwire>>[0]
        | null = null;
      let savedBuffer: ArrayBuffer | null = null;

      try {
        // Build current document from PM editor state
        const doc = buildCurrentDocument();
        if (!doc) {
          return null;
        }

        const { resolveSelectiveSaveFlags } =
          await import("../core/docx/selectiveSaveFlags");
        const flags = resolveSelectiveSaveFlags(featureFlags);

        // The tripwire observes the selective path independently from the
        // user-visible save mode. Only `useSelectiveForSave` is allowed to
        // choose the returned bytes.
        const explicitSelectiveSave = options?.selective === true;
        const useSelectiveForSave =
          (flags.selectiveSave || explicitSelectiveSave) &&
          options?.selective !== false;
        const shouldAttemptSelective =
          useSelectiveForSave || flags.selectiveSaveTripwire;
        const view = pagedEditorRef.current?.getView();
        let selectiveBuffer: ArrayBuffer | null = null;

        if (shouldAttemptSelective && view && originalBufferRef.current) {
          const editorState = view.state;
          const attemptSelectiveSave = await loadAttemptSelectiveSave();
          selectiveBuffer = await attemptSelectiveSave(
            doc,
            originalBufferRef.current,
            {
              changedParaIds: getChangedParagraphIds(editorState),
              structuralChange: hasStructuralChanges(editorState),
              hasUntrackedChanges: hasUntrackedChanges(editorState),
              maxBytes: flags.selectiveSaveMaxBytes,
            },
          );
        }

        let buffer: ArrayBuffer | null = useSelectiveForSave
          ? selectiveBuffer
          : null;
        let fullBuffer: ArrayBuffer | null = null;

        if (!buffer) {
          const repackDocx = await loadRepackDocx();
          fullBuffer = await repackDocx(doc);
          buffer = fullBuffer;
        } else if (flags.selectiveSaveTripwire) {
          try {
            const repackDocx = await loadRepackDocx();
            fullBuffer = await repackDocx(doc);
          } catch {
            // Tripwire-only full repack failures must never poison a
            // successful selective save.
          }
        }

        if (
          flags.selectiveSaveTripwire &&
          fullBuffer &&
          onSelectiveSaveTripwire
        ) {
          // The comparison itself never blocks the save path. The host
          // callback runs after the save try/catch so test harnesses may fail
          // on mismatches by throwing.
          try {
            const { compareSelectiveVsFull } =
              await import("../core/docx/selectiveSaveTripwire");
            tripwireResult = await compareSelectiveVsFull(
              selectiveBuffer,
              fullBuffer,
            );
          } catch {
            // Comparison failures must never poison the save path.
          }
        }

        // Clear change tracker after successful save
        if (view) {
          originalBufferRef.current = buffer;
          view.dispatch(clearTrackedChanges(view.state));
        }
        commentsDirtyRef.current = false;

        onSave?.(buffer);
        savedBuffer = buffer;
      } catch (error) {
        onError?.(
          error instanceof Error ? error : new Error("Failed to save document"),
        );
        return null;
      }

      if (tripwireResult && onSelectiveSaveTripwire) {
        onSelectiveSaveTripwire(tripwireResult);
      }
      return savedBuffer;
    },
    [
      buildCurrentDocument,
      onSave,
      onError,
      originalBufferRef,
      featureFlags,
      onSelectiveSaveTripwire,
    ],
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
      getDocument: () => buildCurrentDocument(),
      hasPendingChanges: () => {
        const view = pagedEditorRef.current?.getView();
        if (!view) {
          return false;
        }
        return (
          commentsDirtyRef.current ||
          getChangedParagraphIds(view.state).size > 0 ||
          hasStructuralChanges(view.state) ||
          hasUntrackedChanges(view.state)
        );
      },
      getEditorRef: () => pagedEditorRef.current,
      save: handleSave,
      setZoom: setZoomWithViewportAnchor,
      getZoom: () => zoomRef.current,
      focus: () => {
        pagedEditorRef.current?.focus();
      },
      getCurrentPage: () => scrollPageInfo.currentPage,
      getTotalPages: () => scrollPageInfo.totalPages,
      scrollToPage: (pageNumber: number) => {
        pagedEditorRef.current?.scrollToPage(pageNumber);
      },
      openPrintPreview: handleDirectPrint,
      print: handleDirectPrint,
      loadDocument: loadParsedDocument,
      loadDocumentBuffer: loadBuffer,
      ensureEditorView: (options?: { focus?: boolean }) => {
        pagedEditorRef.current?.ensureView(options);
      },
      createAIEditSnapshot: () => {
        const view = pagedEditorRef.current?.getView();
        return view ? createFolioAIEditSnapshot(view.state.doc) : null;
      },
      applyAIEditOperations: ({
        snapshot,
        operations,
        mode = "tracked-changes",
        author: operationAuthor = author,
      }) => {
        const view = pagedEditorRef.current?.getView();
        if (!view) {
          return {
            applied: [],
            skipped: operations.map((operation) => ({
              id: operation.id,
              reason: "unsupportedBlock",
            })),
          };
        }

        const createdComments: Comment[] = [];
        const result = applyFolioAIEditOperations({
          view,
          snapshot,
          operations,
          mode,
          author: operationAuthor,
          createCommentId: (text) => {
            const comment = createComment(text, operationAuthor);
            createdComments.push(comment);
            return comment.id;
          },
        });

        if (createdComments.length > 0) {
          updateComments((currentComments) => [
            ...currentComments,
            ...createdComments,
          ]);
        }

        return result;
      },
      acceptAIEditOperation: (revisionId) => {
        const view = pagedEditorRef.current?.getView();
        if (!view) {
          return false;
        }
        return acceptAIEditRevision(revisionId)(view.state, view.dispatch);
      },
      rejectAIEditOperation: (revisionId) => {
        const view = pagedEditorRef.current?.getView();
        if (!view) {
          return false;
        }
        return rejectAIEditRevision(revisionId)(view.state, view.dispatch);
      },
      scrollToAIEditOperation: (revisionId) => {
        const view = pagedEditorRef.current?.getView();
        if (!view) {
          return false;
        }
        const range = findAIEditRevisionRange(view.state, revisionId);
        if (!range) {
          return false;
        }
        // `TextSelection.between` clamps to the nearest valid inline
        // position; `create` throws "endpoint not pointing into a node
        // with inline content" when from/to land on a block boundary,
        // which is exactly what happens for marks that wrap an entire
        // paragraph. `clampRangeToDocSize` is a defensive guard against
        // a revision range whose endpoints fell past the doc end after
        // concurrent edits.
        const { from, to } = clampRangeToDocSize(
          view.state.doc.content.size,
          range,
        );
        const $from = view.state.doc.resolve(from);
        const $to = view.state.doc.resolve(to);
        view.dispatch(
          view.state.tr.setSelection(TextSelection.between($from, $to)),
        );
        requestAnimationFrame(() => {
          pagedEditorRef.current?.scrollToPosition(from);
        });
        return true;
      },
      scrollToBlock: (blockId, snapshot) => {
        const view = pagedEditorRef.current?.getView();
        if (!view) {
          return false;
        }
        // ParaId-backed ids resolve against the live document so
        // queued suggestions still navigate correctly after earlier
        // accepts insert or delete paragraphs above them. `seq-*`
        // fallback ids keep using the snapshot the AI saw.
        const range = resolveFolioAIBlockRange({
          blockId,
          doc: view.state.doc,
          snapshot,
        });
        if (range === null) {
          return false;
        }
        const { from, to } = range;
        const $from = view.state.doc.resolve(from);
        const $to = view.state.doc.resolve(to);
        view.dispatch(
          view.state.tr.setSelection(TextSelection.between($from, $to)),
        );
        requestAnimationFrame(() => {
          pagedEditorRef.current?.scrollToPosition(from);
        });
        return true;
      },
    }),
    [
      author,
      buildCurrentDocument,
      scrollPageInfo,
      handleSave,
      setZoomWithViewportAnchor,
      zoomRef,
      handleDirectPrint,
      loadParsedDocument,
      loadBuffer,
      updateComments,
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
  if (
    state.documentLoad.status === "loading" &&
    (!preserveDocumentWhileLoading || !history.state)
  ) {
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
    "all-markup": t("markupView.allMarkup"),
    "simple-markup": t("markupView.simple"),
    "no-markup": t("markupView.noMarkup"),
    original: t("markupView.original"),
  } as const satisfies Record<DisplayMode, string>;

  const toolbarChildren = toolbarExtra ?? null;
  const visibleCommentAuthorCount = commentAuthors.filter((commentAuthor) =>
    visibleCommentAuthorSet.has(commentAuthor),
  ).length;
  const allCommentAuthorsVisible =
    commentAuthors.length > 0 &&
    showCommentsSidebar &&
    visibleCommentAuthorCount === commentAuthors.length;
  const commentVisibilityLabel =
    visibleCommentAuthorCount === commentAuthors.length
      ? t("comments.showAll")
      : `${visibleCommentAuthorCount}/${commentAuthors.length}`;
  const showAllCommentAuthors = () => {
    setVisibleCommentAuthors(null);
    setShowCommentsSidebar(true);
  };
  const hideAllCommentAuthors = () => {
    setVisibleCommentAuthors(new Set());
    setShowCommentsSidebar(false);
    setActiveCommentId(null);
  };
  const setCommentAuthorVisible = (commentAuthor: string, visible: boolean) => {
    const next = new Set(visibleCommentAuthorSet);
    if (visible) {
      next.add(commentAuthor);
    } else {
      next.delete(commentAuthor);
    }
    setVisibleCommentAuthors(next);
    setShowCommentsSidebar(next.size > 0);
    if (next.size === 0) {
      setActiveCommentId(null);
    }
  };

  const toolbarPriorityExtra = (
    <div className="flex shrink-0 items-center gap-1">
      <Button
        onClick={toggleTrackChanges}
        onMouseDown={(e) => e.preventDefault()}
        disabled={readOnly}
        aria-pressed={trackChangesOn}
        aria-label={t("toggleTrackChanges")}
        className={`h-8 min-w-[140px] justify-start gap-1.5 rounded-md px-2 text-xs text-[var(--doc-text-muted)] shadow-none disabled:text-[var(--doc-text-subtle)] disabled:opacity-[0.35] ${
          trackChangesOn
            ? "border-[var(--doc-primary)] bg-[var(--doc-primary-light)] text-[var(--doc-text)] shadow-[0_0_0_1px_var(--doc-primary)]"
            : "border-transparent text-[var(--doc-text-muted)] hover:border-[var(--doc-border)] hover:bg-[var(--doc-primary-light)] hover:text-[var(--doc-text)]"
        }`}
        size="xs"
        title={t("toggleTrackChanges")}
        variant="ghost"
      >
        <PenLineIcon className="size-3.5" />
        <span className="truncate whitespace-nowrap">
          {trackChangesOn ? t("trackingOn") : t("trackingOff")}
        </span>
      </Button>
      <StSelect
        value={displayMode}
        onValueChange={(val) => setDisplayMode(val as DisplayMode)}
        items={[
          { value: "all-markup", label: "All Markup" },
          { value: "simple-markup", label: "Simple" },
          { value: "no-markup", label: "No Markup" },
          { value: "original", label: "Original" },
        ]}
      >
        <StSelectTrigger
          size="sm"
          className="h-8 min-h-0 w-[132px] min-w-0 shrink-0 border-transparent bg-transparent text-xs text-[var(--doc-text-muted)] shadow-none hover:bg-[var(--doc-primary-light)] hover:text-[var(--doc-text)] data-[pressed]:bg-[var(--doc-primary-light)]"
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
    </div>
  );

  const toolbarInlineExtra = (
    <>
      <Menu>
        <MenuTrigger
          type="button"
          disabled={comments.length === 0}
          aria-label={t("comments.visibility")}
          onMouseDown={(e) => e.preventDefault()}
          className={`flex h-8 min-w-0 items-center gap-1.5 rounded-md border px-2.5 text-xs transition-colors duration-100 disabled:cursor-not-allowed disabled:border-transparent disabled:text-[var(--doc-text-subtle)] disabled:opacity-[0.16] disabled:hover:bg-transparent disabled:hover:text-[var(--doc-text-subtle)] ${
            showCommentsSidebar && visibleCommentAuthorCount > 0
              ? "border-[var(--doc-primary)] bg-[var(--doc-primary-light)] text-[var(--doc-text)]"
              : "border-transparent text-[var(--doc-text-muted)] hover:border-[var(--doc-border)] hover:bg-[var(--doc-primary-light)] hover:text-[var(--doc-text)]"
          }`}
        >
          <StickyNoteIcon size={14} className="shrink-0" />
          <span className="max-w-24 truncate">{commentVisibilityLabel}</span>
        </MenuTrigger>
        <MenuPopup align="start" className="min-w-52">
          <MenuGroup>
            <MenuGroupLabel>{t("comments.visibility")}</MenuGroupLabel>
            <MenuCheckboxItem
              checked={allCommentAuthorsVisible}
              onCheckedChange={(checked) => {
                if (checked) {
                  showAllCommentAuthors();
                } else {
                  hideAllCommentAuthors();
                }
              }}
            >
              {t("comments.showAll")}
            </MenuCheckboxItem>
            <MenuItem onClick={hideAllCommentAuthors}>
              {t("comments.hideAll")}
            </MenuItem>
          </MenuGroup>
          {(() => {
            if (commentAuthors.length > 0) {
              return (
                <>
                  <MenuSeparator />
                  <MenuGroup>
                    {commentAuthors.map((commentAuthor) => (
                      <MenuCheckboxItem
                        checked={
                          showCommentsSidebar &&
                          visibleCommentAuthorSet.has(commentAuthor)
                        }
                        key={commentAuthor}
                        onCheckedChange={(checked) =>
                          setCommentAuthorVisible(commentAuthor, checked)
                        }
                      >
                        {commentAuthor === "Unknown"
                          ? t("comments.unknownAuthor")
                          : commentAuthor}
                      </MenuCheckboxItem>
                    ))}
                  </MenuGroup>
                </>
              );
            }
            return null;
          })()}
        </MenuPopup>
      </Menu>
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
                {new Date(state.activeTrackedChange.date).toLocaleDateString()}
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

  const imagePropertiesCurrentData = buildImagePropertiesData(
    state.pmImageContext,
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
                    theme={history.state.package.theme || theme || null}
                    showZoomControl={showZoomControl}
                    zoom={zoom}
                    onZoomChange={setZoomWithViewportAnchor}
                    editorRef={editorContentRef}
                    onRefocusEditor={focusActiveEditor}
                    onImageWrapType={handleImageWrapType}
                    onImageTransform={handleImageTransform}
                    onOpenImageProperties={handleOpenImageProperties}
                    onTableAction={handleTableAction}
                    priorityExtra={toolbarPriorityExtra}
                    inlineExtra={toolbarInlineExtra}
                    {...(history.state.package.styles?.styles
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
                data-folio-scroll=""
                onScroll={(event) => {
                  onScrollTopChange?.(event.currentTarget.scrollTop);
                  requestAnimationFrame(syncCommentHighlightStyles);
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
                      theme={history.state.package.theme || theme || null}
                      sectionProperties={effectiveSectionProperties ?? null}
                      headerContent={headerContent}
                      footerContent={footerContent}
                      firstPageHeaderContent={firstPageHeaderContent}
                      firstPageFooterContent={firstPageFooterContent}
                      headerContentRId={activeHeaderRId}
                      footerContentRId={activeFooterRId}
                      firstPageHeaderContentRId={activeFirstHeaderRId}
                      firstPageFooterContentRId={activeFirstFooterRId}
                      {...(history.state.package.styles
                        ? { styles: history.state.package.styles }
                        : {})}
                      onHeaderFooterDoubleClick={handleHeaderFooterDoubleClick}
                      hfEditMode={hfEditPosition}
                      onBodyClick={handleBodyClick}
                      zoom={zoom}
                      readOnly={readOnly}
                      onDocumentChange={handleDocumentChange}
                      extensionManager={extensionManager}
                      {...(onReadonlyEditAttempt !== undefined
                        ? { onReadOnlyEditAttempt: onReadonlyEditAttempt }
                        : {})}
                      onSelectionChange={(_from, _to) => {
                        // Extract full selection state from whichever PM
                        // is active. When the user is editing HF the
                        // hfEditorRef delegates to the persistent hidden
                        // HF view via pagedEditorRef.getHfView(activeRId);
                        // reading body PM here would leave the toolbar
                        // (FormattingBar, table / image context) showing
                        // stale body-selection state while its actions
                        // target the HF view (post-eigenpal#611).
                        const view =
                          getActiveEditorView() ??
                          pagedEditorRef.current?.getView() ??
                          null;
                        if (view) {
                          const selectionState = extractSelectionState(
                            view.state,
                          );
                          handleSelectionChange(selectionState);
                        } else {
                          handleSelectionChange(null);
                        }
                      }}
                      {...(onSelectionTextChange !== undefined
                        ? { onSelectionTextChange }
                        : {})}
                      externalPlugins={editorPlugins}
                      {...(collaboration !== undefined
                        ? { collaboration }
                        : {})}
                      onHyperlinkClick={handleHyperlinkClick}
                      onContextMenu={handleContextMenu}
                      commentsSidebarOpen={showCommentsSidebar}
                      anchorPositionMode="comments"
                      onAnonymizationTermClick={onAnonymizationTermClick}
                      selectedAnonymizationCanonical={
                        selectedAnonymizationCanonical
                      }
                      anonymizationSelectionSeq={anonymizationSelectionSeq}
                      {...(showCommentsSidebar
                        ? { onAnchorPositionsChange: setAnchorPositions }
                        : {})}
                      onTotalPagesChange={(totalPages) => {
                        setScrollPageInfo((previous) =>
                          updateScrollPageTotal(previous, totalPages),
                        );
                      }}
                      scrollContainerRef={scrollContainerRef}
                      sidebarOverlay={(() => {
                        if (showCommentsSidebar) {
                          return (
                            <Suspense fallback={null}>
                              <CommentsSidebar
                                activeCommentId={activeCommentId}
                                comments={visibleComments}
                                anchorPositions={anchorPositions}
                                pageWidth={(() => {
                                  const sp =
                                    history.state.package.document
                                      .finalSectionProperties;
                                  return sp?.pageWidth
                                    ? Math.round(sp.pageWidth / 15)
                                    : 816;
                                })()}
                                editorContainerRef={scrollContainerRef}
                                onCommentClick={(id) => {
                                  setActiveCommentId(id);
                                }}
                                onCommentResolve={(id) => {
                                  updateComments((prev) =>
                                    prev.map((c) =>
                                      c.id === id
                                        ? {
                                            ...c,
                                            done: true,
                                          }
                                        : c,
                                    ),
                                  );
                                }}
                                onCommentDelete={(id) => {
                                  updateComments((prev) =>
                                    prev.filter(
                                      (c) => c.id !== id && c.parentId !== id,
                                    ),
                                  );
                                  if (activeCommentId === id) {
                                    setActiveCommentId(null);
                                  }
                                }}
                                onCommentReply={(id, text) => {
                                  updateComments((prev) => [
                                    ...prev,
                                    createComment(text, author, id),
                                  ]);
                                }}
                                onAddComment={(addText) => {
                                  const comment = createComment(
                                    addText,
                                    author,
                                  );
                                  // Replace pending comment mark with the real comment ID
                                  const view =
                                    pagedEditorRef.current?.getView();
                                  if (!view || !commentSelectionRange) {
                                    return false;
                                  }
                                  const marked = applyCommentMarkRange(
                                    view,
                                    commentSelectionRange,
                                    comment.id,
                                    {
                                      replacePending: true,
                                    },
                                  );
                                  if (!marked) {
                                    return false;
                                  }
                                  const commentAuthor = getCommentAuthorKey(
                                    comment.author,
                                  );
                                  setVisibleCommentAuthors((current) => {
                                    if (current === null) {
                                      return null;
                                    }
                                    const next = new Set(current);
                                    next.add(commentAuthor);
                                    return next;
                                  });
                                  setActiveCommentId(comment.id);
                                  updateComments((prev) => [...prev, comment]);
                                  pagedEditorRef.current?.relayout();
                                  requestAnimationFrame(() => {
                                    syncCommentHighlightStyles();
                                    requestAnimationFrame(
                                      syncCommentHighlightStyles,
                                    );
                                  });
                                  setIsAddingComment(false);
                                  setCommentSelectionRange(null);
                                  setAddCommentYPosition(null);
                                  return true;
                                }}
                                onTrackedChangeReply={(revisionId, text) => {
                                  updateComments((prev) => [
                                    ...prev,
                                    createComment(text, author, revisionId),
                                  ]);
                                }}
                                onCancelAddComment={() => {
                                  // Remove pending comment highlight
                                  const view =
                                    pagedEditorRef.current?.getView();
                                  if (view && commentSelectionRange) {
                                    removePendingCommentMarkRange(
                                      view,
                                      commentSelectionRange,
                                    );
                                  }
                                  setIsAddingComment(false);
                                  setCommentSelectionRange(null);
                                  setAddCommentYPosition(null);
                                }}
                                onAcceptChange={(from, to) => {
                                  const view =
                                    pagedEditorRef.current?.getView();
                                  if (view) {
                                    acceptChange(from, to)(
                                      view.state,
                                      view.dispatch,
                                    );
                                    extractTrackedChanges();
                                  }
                                }}
                                onRejectChange={(from, to) => {
                                  const view =
                                    pagedEditorRef.current?.getView();
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
                            </Suspense>
                          );
                        }
                        return undefined;
                      })()}
                    />

                    {/* Floating "add comment" button — appears on right edge of page at selection */}
                    {floatingCommentBtn !== null &&
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
                              if (!view) {
                                setFloatingCommentBtn(null);
                                return;
                              }
                              const capturedRange = {
                                from: floatingCommentBtn.from,
                                to: floatingCommentBtn.to,
                              };
                              const currentSelection = view.state.selection;
                              const safeRange = resolveCommentCreationRange({
                                docSize: view.state.doc.content.size,
                                capturedRange,
                                currentRange: {
                                  from: currentSelection.from,
                                  to: currentSelection.to,
                                },
                                savedRange: lastSelectionRef.current,
                              });
                              if (!safeRange) {
                                setCommentSelectionRange(null);
                                setFloatingCommentBtn(null);
                                return;
                              }
                              setCommentSelectionRange(safeRange);
                              const marked = applyCommentMarkRange(
                                view,
                                safeRange,
                                PENDING_COMMENT_ID,
                                { selectEnd: true },
                              );
                              if (!marked) {
                                setCommentSelectionRange(null);
                                setFloatingCommentBtn(null);
                                return;
                              }
                              const yPos = findSelectionYPosition(
                                scrollContainerRef.current,
                                editorContentRef.current,
                                safeRange.from,
                              );
                              setAddCommentYPosition(
                                yPos ?? floatingCommentBtn.top,
                              );
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
                            <SquarePenIcon size={16} />
                          </button>
                        </Tooltip>
                      )}

                    {/* Inline Header/Footer Editor — positioned over the target area */}
                    {hfEditPosition &&
                      (() => {
                        const activeHf = (() => {
                          if (hfEditIsFirstPage) {
                            return (() => {
                              if (hfEditPosition === "header") {
                                return firstPageHeaderContent;
                              }
                              return firstPageFooterContent;
                            })();
                          }
                          if (hfEditPosition === "header") {
                            return headerContent;
                          }
                          return footerContent;
                        })();
                        if (!activeHf) {
                          return null;
                        }
                        const targetEl = getHfTargetElement(hfEditPosition);
                        const parentEl = editorContentRef.current;
                        if (!targetEl || !parentEl) {
                          return null;
                        }
                        // Resolve the active HF rId for this edit session;
                        // the chrome delegates getView/focus/undo/redo to the
                        // persistent hidden HF EditorView mounted by
                        // HiddenHeaderFooterPMs (post-eigenpal#611). The
                        // inline overlay no longer mounts its own visible PM.
                        const activeRId = (() => {
                          if (hfEditIsFirstPage) {
                            return hfEditPosition === "header"
                              ? activeFirstHeaderRId
                              : activeFirstFooterRId;
                          }
                          return hfEditPosition === "header"
                            ? activeHeaderRId
                            : activeFooterRId;
                        })();
                        const getActiveView = () =>
                          activeRId
                            ? (pagedEditorRef.current?.getHfView(activeRId) ??
                              null)
                            : null;
                        return (
                          <InlineHeaderFooterEditor
                            ref={hfEditorRef}
                            position={hfEditPosition}
                            targetElement={targetEl}
                            parentElement={parentEl}
                            getActiveView={getActiveView}
                            onClose={handleBodyClick}
                            onRemove={handleRemoveHeaderFooter}
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
              {showOutline && outlineHeadings.length > 1 && (
                <DocumentOutline
                  headings={outlineHeadings}
                  scrollContainerRef={scrollContainerRef}
                  topOffset={toolbarHeight}
                  docSize={
                    pagedEditorRef.current?.getView()?.state.doc.content.size ??
                    0
                  }
                  onHeadingClick={(pmPos) => {
                    pagedEditorRef.current?.scrollToPosition(pmPos);
                    // Wait for the paged editor to mount the target paragraph
                    // (smooth-scroll + virtualisation buffer warm-up), then
                    // trigger the CSS flash animation.
                    let attempts = 0;
                    const flash = () => {
                      attempts++;
                      const container = scrollContainerRef.current;
                      if (!container) {
                        return;
                      }
                      const el = container.querySelector<HTMLElement>(
                        `.layout-page-content [data-pm-start="${String(pmPos)}"]`,
                      );
                      if (el) {
                        delete el.dataset["folioOutlineFlash"];
                        void el.offsetWidth;
                        el.dataset["folioOutlineFlash"] = "";
                        return;
                      }
                      if (attempts < 30) {
                        requestAnimationFrame(flash);
                      }
                    };
                    requestAnimationFrame(flash);
                  }}
                />
              )}
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
          {contextMenu.isOpen && (
            <Suspense fallback={null}>
              <TextContextMenu
                isOpen={contextMenu.isOpen}
                position={contextMenu.position}
                hasSelection={contextMenu.hasSelection}
                isEditable={!readOnly}
                items={contextMenuItems}
                onAction={(action) => {
                  void handleContextMenuAction(action);
                }}
                onClose={handleContextMenuClose}
              />
            </Suspense>
          )}

          {/* Toast notifications */}
          {/* Toast notifications provided by host app */}

          <DocxEditorDialogs
            findReplace={{
              state: findReplace.state,
              onClose: findReplace.close,
              onFind: handleFind,
              onFindNext: handleFindNext,
              onFindPrevious: handleFindPrevious,
              onReplace: handleReplace,
              onReplaceAll: handleReplaceAll,
              currentResult: findResultRef.current,
            }}
            tableProperties={{
              isOpen: tablePropsOpen,
              onClose: () => setTablePropsOpen(false),
              onApply: (props) => {
                const view = getActiveEditorView();
                if (view) {
                  setTableProperties(props)(view.state, view.dispatch);
                }
              },
              currentProps: state.pmTableContext?.table?.attrs as
                | Record<string, unknown>
                | undefined,
            }}
            imagePosition={{
              isOpen: imagePositionOpen,
              onClose: () => setImagePositionOpen(false),
              onApply: handleApplyImagePosition,
            }}
            imageProperties={{
              isOpen: imagePropsOpen,
              onClose: () => setImagePropsOpen(false),
              onApply: handleApplyImageProperties,
              currentData: imagePropertiesCurrentData,
            }}
            pageSetup={{
              isOpen: showPageSetup,
              onClose: () => setShowPageSetup(false),
              onApply: handlePageSetupApply,
              currentProps:
                history.state.package.document.finalSectionProperties,
            }}
            footnoteProperties={{
              isOpen: footnotePropsOpen,
              onClose: () => setFootnotePropsOpen(false),
              onApply: handleApplyFootnoteProperties,
              footnotePr:
                history.state.package.document.finalSectionProperties
                  ?.footnotePr,
              endnotePr:
                history.state.package.document.finalSectionProperties
                  ?.endnotePr,
            }}
          />
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
}

// ============================================================================
// EXPORTS
// ============================================================================
