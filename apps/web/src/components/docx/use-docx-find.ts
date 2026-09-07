import { useCallback, useRef, useState } from "react";
import type { RefObject } from "react";

import { useDebouncedCallback } from "use-debounce";

import { resolveFindMatchRange } from "@stll/folio-core/prosemirror/findReplaceSelection";
import type { FindMatch } from "@stll/folio-core/utils/findReplace";
import type { DocxEditorRef } from "@stll/folio-react";

import { useExternalSyncEffect } from "@/hooks/use-effect";
import { findDocumentSearchResult } from "@/lib/document-search";
import { useFindSurface } from "@/lib/find-owner";
import {
  getAdjacentSearchMatchIndex,
  MAX_SEARCH_PREVIEW_MATCHES,
} from "@/lib/search-match-navigation";
import type { SearchMatchSummary } from "@/lib/search-match-navigation";

import {
  EMPTY_DOCX_FIND_SUMMARY,
  resetOpenDocxFindQuery,
} from "./docx-find.logic";
import type { OpenDocxFindState } from "./docx-find.logic";

const SEARCH_DEBOUNCE_MS = 150;

type DocxFindState = { status: "closed" } | OpenDocxFindState;

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
  /** Pane root: the registry reads it for "inside" and "on screen". */
  containerRef: RefObject<HTMLElement | null>;
  editorRef: RefObject<DocxEditorRef | null>;
  enabled: boolean;
};

/**
 * Cmd/Ctrl+F for a DOCX rendered in the inspector pane.
 *
 * Folio's built-in dialog is a viewport overlay positioned clear of the
 * docked inspector, which puts it over unrelated page content. This pane
 * registers with the find registry (`@/lib/find-owner`), which takes the
 * press before Folio's document-level listener sees it, and drives a docked
 * bar instead, reusing the passage-highlight search path the PDF peek viewer
 * already uses.
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
          ? {
              ...prev,
              activeIndex: 0,
              summary: EMPTY_DOCX_FIND_SUMMARY,
            }
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
    matchesRef.current = [];
    clearHighlight();
    setState((prev) =>
      prev.status === "open" ? resetOpenDocxFindQuery(prev, query) : prev,
    );
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

  const openFind = () => {
    const selection = window.getSelection();
    const selected =
      selection && !selection.isCollapsed ? selection.toString().trim() : "";
    if (selected.length > 0) {
      matchesRef.current = [];
      editorRef.current?.getEditorRef()?.setPassageHighlight(null);
    }
    setState((prev) => {
      if (prev.status === "open") {
        const focused = {
          ...prev,
          focusSeq: prev.focusSeq + 1,
        };
        return selected.length > 0
          ? resetOpenDocxFindQuery(focused, selected)
          : focused;
      }
      return {
        status: "open",
        activeIndex: 0,
        focusSeq: 0,
        query: selected,
        summary: EMPTY_DOCX_FIND_SUMMARY,
      };
    });
    if (selected.length > 0) {
      debouncedSearch(selected);
    }
  };

  // The inspector's external-reference preview and a table view's toolbar are
  // candidates for the same press. This pane only claims presses that land
  // inside it, and only while it is the visible tab; the registry owns the
  // listener and calls back the surface it awards the press to.
  useFindSurface({
    enabled,
    onFind: openFind,
    owner: "docx",
    root: containerRef,
    scope: "pane",
  });

  // Escape is not the registry's business, so it keeps a listener of its own,
  // bound to the pane rather than the document: capture phase to beat the
  // editor inside, scoped so it cannot swallow the Escape of a dialog on top.
  useExternalSyncEffect(() => {
    const root = containerRef.current;
    if (!enabled || !isOpen || !root) {
      return undefined;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }
      event.preventDefault();
      close();
    };

    root.addEventListener("keydown", handleKeyDown, { capture: true });
    return () => {
      root.removeEventListener("keydown", handleKeyDown, { capture: true });
    };
  }, [close, containerRef, enabled, isOpen]);

  return {
    activeIndex: state.status === "open" ? state.activeIndex : 0,
    close,
    focusSeq: state.status === "open" ? state.focusSeq : 0,
    isOpen,
    query: state.status === "open" ? state.query : "",
    setQuery,
    step,
    summary: state.status === "open" ? state.summary : EMPTY_DOCX_FIND_SUMMARY,
  };
};
