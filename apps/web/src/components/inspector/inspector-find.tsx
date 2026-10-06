import { useCallback, useLayoutEffect, useState } from "react";
import type { RefObject } from "react";

import { panic } from "better-result";

import { SEARCH_HIT_MARK, textMarkHighlightRule } from "@stll/ui/text-mark";

import { ReaderFindBar } from "@/components/legal-reader/reader-find-bar";
import { buildSearchResults } from "@/components/legal-reader/reader-search";
import { useExternalSyncEffect } from "@/hooks/use-effect";
import { useLatestCallback } from "@/hooks/use-latest-callback";
import { useFindSurface } from "@/lib/find-owner";

type InspectorFindOptions = {
  /** The text the bar searches: every text node under it is walked. */
  contentRef: RefObject<HTMLElement | null>;
  /** While false the surface is not a candidate and its bar cannot open. */
  enabled: boolean;
  /** Search terms supplied when this reader opens; later edits belong to the bar. */
  initialQuery?: string | undefined;
  /**
   * Separates this reader's highlights from those of a reader mounted beside
   * it — the inspector keeps its background tabs mounted. Sanitized here, so
   * a caller cannot hand a tab id through to a CSS identifier unescaped.
   */
  highlightKey: string;
  /** The reader's own pane: what the find registry treats as "inside". */
  panelRef: RefObject<HTMLElement | null>;
};

type FindBarState =
  | { open: false }
  | {
      open: true;
      query: string;
      matchCount: number;
      activeIndex: number;
      /**
       * Bumped on every awarded find command, so a shortcut pressed while
       * the bar is already open still returns the caret to the query.
       */
      focusRequest: number;
    };

const FIND_CLOSED: FindBarState = { open: false };
const FIND_OPENED: FindBarState = {
  open: true,
  query: "",
  matchCount: 0,
  activeIndex: 0,
  focusRequest: 0,
};

/** What a match collection reads from the bar. */
type FindInputs = {
  activeIndex: number;
  enabled: boolean;
  findQuery: string;
};

/** The state after a find command: opened, or open with focus asked for again. */
const findCommanded = (prev: FindBarState): FindBarState =>
  prev.open ? { ...prev, focusRequest: prev.focusRequest + 1 } : FIND_OPENED;

/**
 * Find-in-text for an inspector reader: the shortcut registration, the match
 * ranges, and the highlights the bar paints with.
 *
 * Every reader the inspector shows uses this one hook, so a reader added
 * later answers Cmd/Ctrl+F by rendering {@link InspectorFindBar} rather than
 * by re-deriving any of it.
 */
export const useInspectorFind = ({
  contentRef,
  enabled,
  highlightKey,
  initialQuery,
  panelRef,
}: InspectorFindOptions) => {
  const [findState, setFindState] = useState<FindBarState>(() =>
    initialQuery?.trim()
      ? { ...FIND_OPENED, query: initialQuery.trim() }
      : FIND_CLOSED,
  );
  const safeKey = sanitizeHighlightKey(highlightKey);
  const allHighlightName = `stella-inspector-find-${safeKey}`;
  const activeHighlightName = `stella-inspector-find-active-${safeKey}`;

  const clearFind = useCallback(() => {
    setFindState((prev) =>
      prev.open ? { ...prev, query: "", matchCount: 0, activeIndex: 0 } : prev,
    );
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- CSS.highlights is not available in every supported browser.
    CSS.highlights?.delete(allHighlightName);
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- CSS.highlights is not available in every supported browser.
    CSS.highlights?.delete(activeHighlightName);
  }, [activeHighlightName, allHighlightName]);

  const closeFind = useCallback(() => {
    clearFind();
    setFindState(FIND_CLOSED);
  }, [clearFind]);

  const openFind = useCallback(() => {
    if (!enabled) {
      return;
    }
    setFindState(findCommanded);
  }, [enabled]);

  const setFindQuery = useCallback((query: string) => {
    setFindState((prev) =>
      prev.open ? { ...prev, query, activeIndex: 0 } : prev,
    );
  }, []);

  const nextMatch = useCallback(() => {
    setFindState((prev) => {
      if (!prev.open || prev.matchCount === 0) {
        return prev;
      }
      return {
        ...prev,
        activeIndex: (prev.activeIndex + 1) % prev.matchCount,
      };
    });
  }, []);

  const previousMatch = useCallback(() => {
    setFindState((prev) => {
      if (!prev.open || prev.matchCount === 0) {
        return prev;
      }
      return {
        ...prev,
        activeIndex: (prev.activeIndex - 1 + prev.matchCount) % prev.matchCount,
      };
    });
  }, []);

  const findOpen = findState.open;
  const findQuery = findState.open ? findState.query : "";
  const matchCount = findState.open ? findState.matchCount : 0;
  const activeIndex = findState.open ? findState.activeIndex : 0;
  const focusRequest = findState.open ? findState.focusRequest : 0;

  // The DOCX pane and a table view's toolbar are candidates for the same
  // press: an inspector reader reaches the whole app while it is showing
  // text, and stands down for a pane the press landed inside or while a
  // modal covers it.
  useFindSurface({
    enabled,
    onFind: () => {
      setFindState(findCommanded);
    },
    owner: "inspector",
    root: panelRef,
    scope: "app",
  });

  // Escape closes this bar and nothing else, so it keeps a listener of its own
  // rather than travelling through a registry that has no opinion about it.
  useExternalSyncEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        enabled &&
        findOpen &&
        event.key === "Escape" &&
        event.target instanceof Node &&
        panelRef.current?.contains(event.target)
      ) {
        event.preventDefault();
        closeFind();
      }
    };

    document.addEventListener("keydown", handleKeyDown, { capture: true });
    return () => {
      document.removeEventListener("keydown", handleKeyDown, { capture: true });
    };
  }, [closeFind, enabled, findOpen, panelRef]);

  // One collection for both things that change what matches: the bar's own
  // values, and the reader's text arriving later. Called with the values
  // rather than closing over them, so the effect below lists what it reads.
  const applyFind = useLatestCallback(
    ({
      activeIndex: index,
      enabled: isEnabled,
      findQuery: queryInput,
    }: FindInputs) => {
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- CSS.highlights is not available in every supported browser.
      CSS.highlights?.delete(allHighlightName);
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- CSS.highlights is not available in every supported browser.
      CSS.highlights?.delete(activeHighlightName);

      const root = contentRef.current;
      const query = queryInput.trim();
      if (!isEnabled || !root || query.length === 0) {
        setFindState((prev) =>
          prev.open && (prev.matchCount !== 0 || prev.activeIndex !== 0)
            ? { ...prev, matchCount: 0, activeIndex: 0 }
            : prev,
        );
        return undefined;
      }

      const ranges = collectTextRanges(root, query);
      setFindState((prev) =>
        prev.open && prev.matchCount !== ranges.length
          ? { ...prev, matchCount: ranges.length }
          : prev,
      );

      if (ranges.length === 0) {
        setFindState((prev) =>
          prev.open && prev.activeIndex !== 0
            ? { ...prev, activeIndex: 0 }
            : prev,
        );
        return undefined;
      }

      const safeActiveIndex = index >= ranges.length ? 0 : index;
      if (safeActiveIndex !== index) {
        setFindState((prev) =>
          prev.open ? { ...prev, activeIndex: safeActiveIndex } : prev,
        );
        return undefined;
      }

      // oxlint-disable-next-line typescript/no-unnecessary-condition -- CSS.highlights is not available in every supported browser.
      CSS.highlights?.set(allHighlightName, new Highlight(...ranges));
      const activeRange = ranges.at(safeActiveIndex);
      if (activeRange) {
        // oxlint-disable-next-line typescript/no-unnecessary-condition -- CSS.highlights is not available in every supported browser.
        CSS.highlights?.set(activeHighlightName, new Highlight(activeRange));
        scrollRangeIntoView(activeRange);
      }

      return () => {
        // oxlint-disable-next-line typescript/no-unnecessary-condition -- CSS.highlights is not available in every supported browser.
        CSS.highlights?.delete(allHighlightName);
        // oxlint-disable-next-line typescript/no-unnecessary-condition -- CSS.highlights is not available in every supported browser.
        CSS.highlights?.delete(activeHighlightName);
      };
    },
  );

  useLayoutEffect(
    () => applyFind({ activeIndex, enabled, findQuery }),
    [activeIndex, applyFind, enabled, findQuery],
  );

  // The reader fills in after the bar can be open: citations, provision
  // history and "load more" insert text later. Each insertion is a new
  // document to match against, so the collection runs again on it.
  const reapplyFind = useLatestCallback(() => {
    applyFind({ activeIndex, enabled, findQuery });
  });
  useExternalSyncEffect(() => {
    const root = contentRef.current;
    if (!enabled || !root) {
      return undefined;
    }
    const observer = new MutationObserver(() => {
      reapplyFind();
    });
    observer.observe(root, {
      characterData: true,
      childList: true,
      subtree: true,
    });
    return () => {
      observer.disconnect();
    };
  }, [contentRef, enabled, reapplyFind]);

  return {
    activeMatchNumber: matchCount === 0 ? 0 : activeIndex + 1,
    clearFind,
    closeFind,
    findOpen,
    findQuery,
    focusRequest,
    highlightKey: safeKey,
    matchCount,
    nextMatch,
    openFind,
    previousMatch,
    setFindQuery,
  };
};

/** Derived from the hook, so the bar cannot drift from what it is handed. */
type InspectorFind = ReturnType<typeof useInspectorFind>;

/**
 * The bar itself, carrying the highlight styles its match ranges paint
 * through. It renders nothing while closed, which is also when no highlight
 * exists.
 */
export const InspectorFindBar = ({ find }: { find: InspectorFind }) => {
  if (!find.findOpen) {
    return null;
  }
  return (
    <ReaderFindBar
      activeIndex={find.activeMatchNumber - 1}
      focusRequest={find.focusRequest}
      matchCount={find.matchCount}
      onClose={find.closeFind}
      onNext={find.nextMatch}
      onPrevious={find.previousMatch}
      onQueryChange={find.setFindQuery}
      query={find.findQuery}
    >
      <style>
        {[
          textMarkHighlightRule({
            name: `stella-inspector-find-${find.highlightKey}`,
            tone: SEARCH_HIT_MARK.tone,
            state: "rest",
          }),
          textMarkHighlightRule({
            name: `stella-inspector-find-active-${find.highlightKey}`,
            tone: SEARCH_HIT_MARK.tone,
            state: "active",
          }),
        ].join("\n")}
      </style>
    </ReaderFindBar>
  );
};

type TextNodeSegment = { node: Node; start: number; end: number };
type TextPiece = { id: string; text: string; nodes: TextNodeSegment[] };

/** Inline markup shares a search piece; paragraph boundaries keep words apart. */
const collectTextRanges = (root: HTMLElement, query: string): Range[] => {
  const pieces: TextPiece[] = [];
  const textRoot = root.matches('[data-slot="reader-document-column"]')
    ? root
    : (root.querySelector<HTMLElement>(
        '[data-slot="reader-document-column"]',
      ) ?? root);
  const walker = document.createTreeWalker(textRoot, NodeFilter.SHOW_TEXT);
  let previousBlock: Element | null = null;
  let piece: TextPiece | undefined;
  while (walker.nextNode()) {
    const node = walker.currentNode;
    const parent = node.parentElement;
    if (
      parent?.closest(
        "[data-reader-chrome], [aria-hidden='true'], .sr-only, script, style",
      )
    ) {
      continue;
    }
    const text = node.textContent ?? "";
    if (text.length === 0) {
      continue;
    }
    const block =
      parent?.closest(
        "p, li, dt, dd, h1, h2, h3, h4, h5, h6, td, th, blockquote, pre, figcaption",
      ) ?? textRoot;
    if (piece === undefined || block !== previousBlock) {
      piece = { id: String(pieces.length), text: "", nodes: [] };
      pieces.push(piece);
      previousBlock = block;
    }
    piece.nodes.push({
      node,
      start: piece.text.length,
      end: piece.text.length + text.length,
    });
    piece.text += text;
  }
  const results = buildSearchResults({ pieces, query });
  const ranges: Range[] = [];
  for (const textPiece of pieces) {
    const pieceRanges = results.rangesByPieceId[textPiece.id];
    if (pieceRanges === undefined) {
      continue;
    }
    for (const match of pieceRanges) {
      const start = textPiece.nodes.find(
        (segment) => match.start >= segment.start && match.start < segment.end,
      );
      const end = textPiece.nodes.find(
        (segment) => match.end > segment.start && match.end <= segment.end,
      );
      if (start === undefined || end === undefined) {
        panic("Reader search match must map to its source text nodes");
      }
      const range = document.createRange();
      range.setStart(start.node, match.start - start.start);
      range.setEnd(end.node, match.end - end.start);
      ranges.push(range);
    }
  }
  return ranges;
};

/**
 * Opens every disclosure the range sits in. A match inside a closed
 * `<details>` (the decision reader folds its reporter apparatus) is counted
 * but has no box to highlight or scroll to until the fold is open.
 */
const revealRange = (range: Range): void => {
  const container = range.commonAncestorContainer;
  let element =
    container instanceof Element ? container : container.parentElement;
  while (element) {
    const details = element.closest("details");
    if (!details) {
      return;
    }
    details.open = true;
    element = details.parentElement;
  }
};

const scrollRangeIntoView = (range: Range): void => {
  revealRange(range);
  const rect = firstVisibleRangeRect(range);
  const root =
    range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
      ? range.commonAncestorContainer
      : range.commonAncestorContainer.parentElement;
  const scrollContainer =
    root instanceof HTMLElement
      ? root.closest<HTMLElement>('[data-slot="scroll-area-viewport"]')
      : null;

  if (rect && scrollContainer) {
    const containerRect = scrollContainer.getBoundingClientRect();
    const targetTop =
      rect.top -
      containerRect.top +
      scrollContainer.scrollTop -
      scrollContainer.clientHeight / 2 +
      rect.height / 2;

    scrollContainer.scrollTo({
      behavior: "smooth",
      top: Math.max(0, targetTop),
    });
    return;
  }

  const container = range.commonAncestorContainer;
  const element =
    container.nodeType === Node.ELEMENT_NODE
      ? container
      : container.parentElement;
  if (element instanceof HTMLElement) {
    element.scrollIntoView({ block: "center", behavior: "smooth" });
  }
};

const firstVisibleRangeRect = (range: Range): DOMRect | undefined => {
  for (const rect of range.getClientRects()) {
    if (rect.width > 0 && rect.height > 0) {
      return rect;
    }
  }

  const rect = range.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0 ? rect : undefined;
};

const sanitizeHighlightKey = (value: string): string =>
  value.replaceAll(/[^a-zA-Z0-9_-]/gu, "_");
