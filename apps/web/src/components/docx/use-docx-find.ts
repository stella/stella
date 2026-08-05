import { useCallback, useRef, useState } from "react";
import type { RefObject } from "react";

import { useDebouncedCallback } from "use-debounce";

import { resolveFindMatchRange } from "@stll/folio-core/prosemirror/findReplaceSelection";
import type { FindMatch } from "@stll/folio-core/utils/findReplace";
import type { DocxEditorRef } from "@stll/folio-react";

import { useExternalSyncEffect } from "@/hooks/use-effect";
import { findDocumentSearchResult } from "@/lib/document-search";
import {
  getAdjacentSearchMatchIndex,
  MAX_SEARCH_PREVIEW_MATCHES,
} from "@/lib/search-match-navigation";
import type { SearchMatchSummary } from "@/lib/search-match-navigation";

import { classifyDocxFindKeydown } from "./docx-find.logic";

const SEARCH_DEBOUNCE_MS = 150;

const EMPTY_SUMMARY: SearchMatchSummary = { count: 0, truncated: false };

type DocxFindState =
  | { status: "closed" }
  | {
      status: "open";
      activeIndex: number;
      focusSeq: number;
      query: string;
      summary: SearchMatchSummary;
    };

const CLOSED_STATE: DocxFindState = { status: "closed" };

export type DocxFind = {
  activeIndex: number;
  close: () => void;
  /**
   * Bumped every time the shortcut is pressed. The bar owns its input, so it
   * watches this to take (or retake) focus.
   */
  focusSeq: number;
  isOpen: boolean;
  query: string;
  setQuery: (query: string) => void;
  step: (direction: "next" | "previous") => void;
  summary: SearchMatchSummary;
};

type UseDocxFindOptions = {
  /** Pane root: bounds the visibility gate and the Escape shortcut. */
  containerRef: RefObject<HTMLElement | null>;
  editorRef: RefObject<DocxEditorRef | null>;
  enabled: boolean;
};

/**
 * Cmd/Ctrl+F for a DOCX rendered in the inspector pane.
 *
 * Folio's built-in dialog is a viewport overlay positioned clear of the
 * docked inspector, which puts it over unrelated page content. This hook
 * claims the shortcut before Folio's document-level listener sees it and
 * drives a docked bar instead, reusing the passage-highlight search path
 * the PDF peek viewer already uses.
 */
export const useDocxFind = ({
  containerRef,
  editorRef,
  enabled,
}: UseDocxFindOptions): DocxFind => {
  const [state, setState] = useState<DocxFindState>(CLOSED_STATE);
  const matchesRef = useRef<readonly FindMatch[]>([]);

  const highlightMatch = (index: number) => {
    const editor = editorRef.current;
    const pagedEditor = editor?.getEditorRef();
    const view = pagedEditor?.getView();
    if (!pagedEditor || !view) {
      return;
    }

    const match = matchesRef.current.at(index);
    const range = match ? resolveFindMatchRange(view.state.doc, match) : null;
    if (!range) {
      pagedEditor.setPassageHighlight(null);
      return;
    }

    pagedEditor.setPassageHighlight(range);
    pagedEditor.scrollToPosition(range.from);
  };

  const clearHighlight = () => {
    editorRef.current?.getEditorRef()?.setPassageHighlight(null);
  };

  const runSearch = (query: string) => {
    const editor = editorRef.current;
    if (!editor) {
      return;
    }

    // The view is created lazily; the search needs it to resolve match
    // offsets onto ProseMirror positions.
    editor.ensureEditorView({ focus: false });

    const trimmed = query.trim();
    if (trimmed.length === 0) {
      matchesRef.current = [];
      clearHighlight();
      setState((prev) =>
        prev.status === "open"
          ? { ...prev, activeIndex: 0, summary: EMPTY_SUMMARY }
          : prev,
      );
      return;
    }

    const result = findDocumentSearchResult({
      document: editor.getDocument(),
      maxMatches: MAX_SEARCH_PREVIEW_MATCHES,
      searchText: trimmed,
    });
    matchesRef.current = result.matches;
    setState((prev) =>
      prev.status === "open"
        ? {
            ...prev,
            activeIndex: 0,
            summary: {
              count: result.matches.length,
              truncated: result.truncated,
            },
          }
        : prev,
    );
    highlightMatch(0);
  };

  const debouncedSearch = useDebouncedCallback(runSearch, SEARCH_DEBOUNCE_MS);

  const setQuery = (query: string) => {
    if (state.status !== "open") {
      return;
    }
    setState({ ...state, query });
    debouncedSearch(query);
  };

  // Stable identity: the keydown subscription below depends on it.
  const close = useCallback(() => {
    debouncedSearch.cancel();
    matchesRef.current = [];
    editorRef.current?.getEditorRef()?.setPassageHighlight(null);
    setState(CLOSED_STATE);
  }, [debouncedSearch, editorRef]);

  const step = (direction: "next" | "previous") => {
    if (state.status !== "open") {
      return;
    }
    if (state.summary.count === 0) {
      // Enter pressed inside the debounce window: run the pending search now
      // so the first press lands on the first match.
      debouncedSearch.flush();
      return;
    }
    const activeIndex = getAdjacentSearchMatchIndex({
      activeIndex: state.activeIndex,
      direction,
      matchCount: state.summary.count,
    });
    setState({ ...state, activeIndex });
    highlightMatch(activeIndex);
  };

  const isOpen = state.status === "open";

  useExternalSyncEffect(() => {
    if (!enabled) {
      return undefined;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      const container = containerRef.current;
      // `offsetParent` is null while an inspector tab is CSS-hidden, which is
      // how the pane keeps background tabs mounted. Only the visible editor
      // may claim the shortcut.
      if (!container || container.offsetParent === null) {
        return;
      }

      const action = classifyDocxFindKeydown({ event, isOpen });
      if (action.type === "none") {
        return;
      }

      if (action.type === "closeFind") {
        // Leave Escape to whatever is layered over the pane (dialogs render
        // in portals outside it).
        if (
          !(event.target instanceof Node) ||
          !container.contains(event.target)
        ) {
          return;
        }
        event.preventDefault();
        close();
        return;
      }

      event.preventDefault();
      // Folio listens for the same shortcut on `document` in the bubble
      // phase; stopping propagation here keeps its overlay dialog closed.
      event.stopPropagation();
      const selection = window.getSelection();
      const selected =
        selection && !selection.isCollapsed ? selection.toString().trim() : "";
      setState((prev) => {
        if (prev.status === "open") {
          return {
            ...prev,
            focusSeq: prev.focusSeq + 1,
            query: selected.length > 0 ? selected : prev.query,
          };
        }
        return {
          status: "open",
          activeIndex: 0,
          focusSeq: 0,
          query: selected,
          summary: EMPTY_SUMMARY,
        };
      });
      if (selected.length > 0) {
        debouncedSearch(selected);
      }
    };

    document.addEventListener("keydown", handleKeyDown, { capture: true });
    return () => {
      document.removeEventListener("keydown", handleKeyDown, { capture: true });
    };
  }, [close, containerRef, debouncedSearch, editorRef, enabled, isOpen]);

  return {
    activeIndex: state.status === "open" ? state.activeIndex : 0,
    close,
    focusSeq: state.status === "open" ? state.focusSeq : 0,
    isOpen,
    query: state.status === "open" ? state.query : "",
    setQuery,
    step,
    summary: state.status === "open" ? state.summary : EMPTY_SUMMARY,
  };
};
