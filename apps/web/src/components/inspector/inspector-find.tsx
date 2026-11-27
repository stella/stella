import { useCallback, useRef, useState } from "react";
import type { RefObject } from "react";

import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { DirectionalIcon } from "@stll/ui/directional-icon";
import {
  useExternalSyncEffect,
  useLatestCallback,
  useLayoutSyncEffect,
  useMountEffect,
} from "@stll/ui/effects";
import { ChevronLeftIcon, ChevronRightIcon, XIcon } from "@stll/ui/icons";
import { Input } from "@stll/ui/input";
import { SEARCH_HIT_MARK, textMarkHighlightRule } from "@stll/ui/text-mark";

import { useFindSurface } from "@/lib/find-owner";
import { revealEnclosingDisclosures } from "@/lib/platform/reveal-disclosures";

import {
  buildReaderFindIndex,
  findReaderMatches,
  rangeOfMatch,
} from "./reader-find-index";
import type { ReaderFindIndex, ReaderFindMatch } from "./reader-find-index";

type InspectorFindOptions = {
  /**
   * The text the bar searches. Its text nodes are read once per version of
   * the text; queries, steps and scrolling reuse that reading.
   */
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

/**
 * Moving the reader is something the reader asks for: a new query, Next or
 * Previous, or opening the bar with terms. Each such command carries a fresh
 * request, answered once by the match collection that sees it. The text
 * changing under an open bar (a provision card unfolds, a disclosure opens, a
 * note arrives) repaints the marks and may move the active index, but never
 * the view.
 */
type RevealRequest = { readonly reveal: true };
const requestReveal = (): RevealRequest => ({ reveal: true });

type FindBarState =
  | { open: false }
  | {
      open: true;
      query: string;
      /**
       * How many matches the query has in the reader's text, or `null` until
       * that text has been counted (a reader opening with search terms
       * counts on its first frame).
       */
      matchCount: number | null;
      activeIndex: number;
      /**
       * Bumped on every awarded find command, so a shortcut pressed while
       * the bar is already open still returns the caret to the query.
       */
      focusRequest: number;
      /** The command still to take the reader to the active match, if any. */
      reveal: RevealRequest | null;
    };

/** What a drawing of the matches reads from the bar. */
type FindInputs = {
  activeIndex: number;
  enabled: boolean;
  findQuery: string;
  reveal: RevealRequest | null;
};

const FIND_CLOSED: FindBarState = { open: false };
const FIND_OPENED: FindBarState = {
  open: true,
  query: "",
  matchCount: 0,
  activeIndex: 0,
  focusRequest: 0,
  reveal: null,
};

/**
 * The page's highlight registry, or nothing in a browser without the CSS
 * Custom Highlight API. Every mark goes through here, so that absence is
 * handled in one place.
 */
const highlightRegistry = (): HighlightRegistry | undefined =>
  // oxlint-disable-next-line typescript/no-unnecessary-condition -- CSS.highlights is not available in every supported browser.
  CSS.highlights ?? undefined;

/** The state after a find command: opened, or open with focus asked for again. */
const findCommanded = (prev: FindBarState): FindBarState =>
  prev.open ? { ...prev, focusRequest: prev.focusRequest + 1 } : FIND_OPENED;

/** The active match, or the first one once the text has fewer. */
const activeWithin = (activeIndex: number, matchCount: number): number =>
  activeIndex < matchCount ? activeIndex : 0;

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
      ? {
          ...FIND_OPENED,
          query: initialQuery.trim(),
          matchCount: null,
          reveal: requestReveal(),
        }
      : FIND_CLOSED,
  );
  const safeKey = sanitizeHighlightKey(highlightKey);
  const allHighlightName = `stella-inspector-find-${safeKey}`;
  const activeHighlightName = `stella-inspector-find-active-${safeKey}`;

  // The text read once, until it changes, and the drawing of the current
  // query's matches over it. Both outlive renders: a keystroke queries the
  // index, a step moves only the active mark, and scrolling draws the
  // matches that come near the viewport.
  const indexRef = useRef<ReaderFindIndex | null>(null);
  const paintRef = useRef<FindPaint | null>(null);
  // The drawing whose match count the bar holds, and the last reveal request
  // answered: a repaint for the same request leaves the view where it is.
  const countedPaintRef = useRef<FindPaint | null>(null);
  const answeredRevealRef = useRef<RevealRequest | null>(null);

  const stopFindPaint = () => {
    stopPaint(paintRef.current);
    paintRef.current = null;
  };

  /**
   * The matches of `query` drawn over the reader's current text, reusing the
   * reading and the drawing while neither changed; `null`, with every mark
   * removed, when there is nothing to search.
   */
  const collect = (query: string, isEnabled: boolean): FindPaint | null => {
    const root = contentRef.current;
    if (!isEnabled || !root || query.length === 0) {
      stopFindPaint();
      highlightRegistry()?.delete(allHighlightName);
      highlightRegistry()?.delete(activeHighlightName);
      return null;
    }
    let textIndex = indexRef.current;
    if (textIndex === null || textIndex.root !== root) {
      textIndex = buildReaderFindIndex(root);
      indexRef.current = textIndex;
    }
    const current = paintRef.current;
    if (
      current?.index === textIndex &&
      current.query === query &&
      current.allName === allHighlightName &&
      current.activeName === activeHighlightName
    ) {
      return current;
    }
    stopFindPaint();
    const paint = startPaint({
      activeName: activeHighlightName,
      allName: allHighlightName,
      index: textIndex,
      query,
    });
    paintRef.current = paint;
    return paint;
  };

  /** Draws the active mark, and takes the reader to it once per request. */
  const drawActive = (
    paint: FindPaint,
    index: number,
    reveal: RevealRequest | null,
  ) => {
    if (paint.matches.length === 0) {
      paint.active = null;
      highlightRegistry()?.delete(activeHighlightName);
      // A request that found nothing is answered: text arriving later
      // repaints in place.
      answeredRevealRef.current = reveal;
      return;
    }
    const activeRange = paintActive(
      paint,
      activeWithin(index, paint.matches.length),
    );
    if (
      activeRange &&
      reveal !== null &&
      reveal !== answeredRevealRef.current
    ) {
      answeredRevealRef.current = reveal;
      scrollRangeIntoView(activeRange);
    }
  };

  /** Hands the bar the count of a drawing; for events outside a render. */
  const publishCount = (paint: FindPaint) => {
    countedPaintRef.current = paint;
    const total = paint.matches.length;
    setFindState((prev) => {
      if (!prev.open) {
        return prev;
      }
      const activeIndex = activeWithin(prev.activeIndex, total);
      return prev.matchCount === total && prev.activeIndex === activeIndex
        ? prev
        : { ...prev, matchCount: total, activeIndex };
    });
  };

  /** Collects a query typed or handed in, counted in the same update. */
  const countFor = (query: string): number => {
    const paint = collect(query, enabled);
    countedPaintRef.current = paint;
    return paint?.matches.length ?? 0;
  };

  // oxlint-disable-next-line no-manual-memo/no-manual-memo -- react/exhaustive-deps cannot see compiler memoization, and this value is an effect dependency
  const clearFind = useCallback(() => {
    setFindState((prev) =>
      prev.open ? { ...prev, query: "", matchCount: 0, activeIndex: 0 } : prev,
    );
    highlightRegistry()?.delete(allHighlightName);
    highlightRegistry()?.delete(activeHighlightName);
  }, [activeHighlightName, allHighlightName]);

  // oxlint-disable-next-line no-manual-memo/no-manual-memo -- react/exhaustive-deps cannot see compiler memoization, and this value is an effect dependency
  const closeFind = useCallback(() => {
    clearFind();
    setFindState(FIND_CLOSED);
  }, [clearFind]);

  const openFind = () => {
    if (!enabled) {
      return;
    }
    setFindState(findCommanded);
  };

  const setFindQuery = (query: string) => {
    if (!findState.open) {
      return;
    }
    const matchCount = countFor(query.trim());
    const reveal = requestReveal();
    setFindState((prev) =>
      prev.open ? { ...prev, query, matchCount, activeIndex: 0, reveal } : prev,
    );
  };

  const openFindAtQuery = (query: string) => {
    if (!enabled) {
      return;
    }
    const trimmed = query.trim();
    const matchCount = countFor(trimmed);
    const reveal = requestReveal();
    setFindState((prev) => ({
      open: true,
      query: trimmed,
      matchCount,
      activeIndex: 0,
      focusRequest: prev.open ? prev.focusRequest : 0,
      reveal,
    }));
  };

  const stepMatch = (step: 1 | -1) => {
    const reveal = requestReveal();
    setFindState((prev) => {
      if (!prev.open || prev.matchCount === null || prev.matchCount === 0) {
        return prev;
      }
      const current = activeWithin(prev.activeIndex, prev.matchCount);
      return {
        ...prev,
        activeIndex: (current + step + prev.matchCount) % prev.matchCount,
        reveal,
      };
    });
  };

  const nextMatch = () => {
    stepMatch(1);
  };

  const previousMatch = () => {
    stepMatch(-1);
  };

  const findOpen = findState.open;
  const findQuery = findState.open ? findState.query : "";
  // A disabled reader has nothing to search; its marks are gone too.
  const matchCount = findState.open && enabled ? findState.matchCount : 0;
  const activeIndex =
    findState.open && matchCount !== null
      ? activeWithin(findState.activeIndex, matchCount)
      : 0;
  const focusRequest = findState.open ? findState.focusRequest : 0;
  const reveal = findState.open ? findState.reveal : null;

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

  // Draws what the bar asks for before the frame paints. A query typed or
  // handed in was counted by its handler; a drawing the bar has not counted
  // (a reader opening with search terms, a reader enabled again) is counted
  // on the next frame. Called with the values rather than closing over them,
  // so the effect below lists what it reads.
  const drawFind = useLatestCallback((inputs: FindInputs) => {
    const paint = collect(inputs.findQuery.trim(), inputs.enabled);
    if (paint === null) {
      return undefined;
    }
    drawActive(paint, inputs.activeIndex, inputs.reveal);
    if (paint === countedPaintRef.current) {
      return undefined;
    }
    const frame = requestAnimationFrame(() => {
      if (paintRef.current === paint) {
        publishCount(paint);
      }
    });
    return () => {
      cancelAnimationFrame(frame);
    };
  });
  useLayoutSyncEffect(
    () => drawFind({ activeIndex, enabled, findQuery, reveal }),
    [activeIndex, drawFind, enabled, findQuery, reveal],
  );

  // The marks belong to this reader: they go when it unmounts.
  useMountEffect(() => () => {
    stopFindPaint();
  });

  // The reader fills in after the bar can be open: citations, provision
  // history and "load more" insert text later. Each insertion is a new
  // version of the text, so it is read again and the query rerun on it.
  const reapplyFind = useLatestCallback(() => {
    indexRef.current = null;
    const paint = collect(findQuery.trim(), enabled);
    if (paint === null) {
      return;
    }
    publishCount(paint);
    drawActive(paint, activeIndex, reveal);
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
    activeMatchNumber:
      matchCount === null || matchCount === 0 ? 0 : activeIndex + 1,
    clearFind,
    closeFind,
    findOpen,
    findQuery,
    focusRequest,
    highlightKey: safeKey,
    matchCount,
    nextMatch,
    openFind,
    openFindAtQuery,
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
  const t = useTranslations();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const {
    activeMatchNumber,
    clearFind,
    closeFind,
    findOpen,
    findQuery,
    focusRequest,
    highlightKey,
    matchCount,
    nextMatch,
    previousMatch,
    setFindQuery,
  } = find;

  // On open, and again on every find command while open: the shortcut
  // pressed from the reader brings the caret back to the query.
  useExternalSyncEffect(() => {
    if (!findOpen) {
      return;
    }
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [findOpen, focusRequest]);

  if (!findOpen) {
    return null;
  }

  const counter = (() => {
    if (!findQuery || matchCount === null) {
      return "";
    }
    if (matchCount === 0) {
      return t("common.noResults");
    }
    return t("folio.findReplace.matchCounter", {
      current: String(activeMatchNumber),
      total: String(matchCount),
    });
  })();

  const dismiss = () => {
    clearFind();
    closeFind();
  };

  return (
    <div className="flex h-10 shrink-0 items-center gap-1 border-b px-2">
      <style>
        {[
          textMarkHighlightRule({
            name: `stella-inspector-find-${highlightKey}`,
            tone: SEARCH_HIT_MARK.tone,
            state: "rest",
          }),
          textMarkHighlightRule({
            name: `stella-inspector-find-active-${highlightKey}`,
            tone: SEARCH_HIT_MARK.tone,
            state: "active",
          }),
        ].join("\n")}
      </style>
      <Input
        aria-label={t("folio.findReplace.findText")}
        className="h-7 flex-1 rounded-md"
        nativeInput
        onChange={(event) => {
          setFindQuery(event.currentTarget.value);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            dismiss();
            return;
          }
          if (event.key !== "Enter") {
            return;
          }
          event.preventDefault();
          if (event.shiftKey) {
            previousMatch();
            return;
          }
          nextMatch();
        }}
        placeholder={t("folio.findReplace.findPlaceholder")}
        ref={inputRef}
        size="sm"
        type="search"
        value={findQuery}
      />
      <span className="text-muted-foreground min-w-14 text-end text-xs tabular-nums">
        {counter}
      </span>
      <Button
        aria-label={t("common.previousMatch")}
        disabled={matchCount === null || matchCount === 0}
        disabledReason={t("workspaces.filters.noMatches")}
        onClick={previousMatch}
        size="icon-xs"
        title={t("folio.findReplace.previousShortcut")}
        variant="ghost"
      >
        <DirectionalIcon className="size-3.5" icon={ChevronLeftIcon} />
      </Button>
      <Button
        aria-label={t("common.nextMatch")}
        disabled={matchCount === null || matchCount === 0}
        disabledReason={t("workspaces.filters.noMatches")}
        onClick={nextMatch}
        size="icon-xs"
        title={t("folio.findReplace.nextShortcut")}
        variant="ghost"
      >
        <DirectionalIcon className="size-3.5" icon={ChevronRightIcon} />
      </Button>
      <Button
        aria-label={t("folio.findReplace.close")}
        onClick={dismiss}
        size="icon-xs"
        variant="ghost"
      >
        <XIcon className="size-3.5" />
      </Button>
    </div>
  );
};

/**
 * One query's matches drawn over one version of the text.
 *
 * The count and the steps cover every match; the marks are drawn only for
 * matches whose block is on screen or near it, so the ranges a reader holds
 * stay proportional to what it shows, not to the document. The active match
 * is drawn wherever it is.
 */
type FindPaint = {
  active: { index: number; range: Range } | null;
  readonly activeName: string;
  readonly all: Highlight;
  readonly allName: string;
  readonly index: ReaderFindIndex;
  readonly matches: readonly ReaderFindMatch[];
  readonly observer: IntersectionObserver;
  readonly query: string;
};

/** How far beyond the visible text marks are drawn ahead of a scroll. */
const PAINT_MARGIN = "100% 0px";

const startPaint = ({
  activeName,
  allName,
  index,
  query,
}: {
  activeName: string;
  allName: string;
  index: ReaderFindIndex;
  query: string;
}): FindPaint => {
  const matches = findReaderMatches(index, query);
  const all = new Highlight();
  highlightRegistry()?.set(allName, all);
  const matchesByBlock = new Map<Element, ReaderFindMatch[]>();
  for (const match of matches) {
    const blockMatches = matchesByBlock.get(match.block);
    if (blockMatches) {
      blockMatches.push(match);
    } else {
      matchesByBlock.set(match.block, [match]);
    }
  }
  const drawn = new Map<Element, Range[]>();
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const block = entry.target;
        const ranges = drawn.get(block);
        if (entry.isIntersecting && ranges === undefined) {
          const blockMatches = matchesByBlock.get(block);
          if (blockMatches === undefined) {
            continue;
          }
          const blockRanges = blockMatches.map(rangeOfMatch);
          for (const range of blockRanges) {
            all.add(range);
          }
          drawn.set(block, blockRanges);
        } else if (!entry.isIntersecting && ranges !== undefined) {
          for (const range of ranges) {
            all.delete(range);
          }
          drawn.delete(block);
        }
      }
    },
    { root: scrollRootOf(index.root), rootMargin: PAINT_MARGIN },
  );
  for (const block of matchesByBlock.keys()) {
    observer.observe(block);
  }
  return {
    active: null,
    activeName,
    all,
    allName,
    index,
    matches,
    observer,
    query,
  };
};

const stopPaint = (paint: FindPaint | null): void => {
  if (paint === null) {
    return;
  }
  paint.observer.disconnect();
  highlightRegistry()?.delete(paint.allName);
  highlightRegistry()?.delete(paint.activeName);
};

/** Draws the active mark, making its range only when the active match moves. */
const paintActive = (paint: FindPaint, index: number): Range | undefined => {
  const match = paint.matches.at(index);
  if (match === undefined) {
    return undefined;
  }
  if (paint.active?.index !== index) {
    paint.active = { index, range: rangeOfMatch(match) };
  }
  const { range } = paint.active;
  // A reader's clear removes the registrations; drawing again restores them.
  highlightRegistry()?.set(paint.allName, paint.all);
  highlightRegistry()?.set(paint.activeName, new Highlight(range));
  return range;
};

/** The element the reader scrolls in: what "near the viewport" is measured in. */
const scrollRootOf = (element: HTMLElement): Element | null => {
  for (
    let current: HTMLElement | null = element;
    current !== null;
    current = current.parentElement
  ) {
    const { overflowY } = getComputedStyle(current);
    if (overflowY === "auto" || overflowY === "scroll") {
      return current;
    }
  }
  return null;
};

/**
 * Opens every disclosure the range sits in. A match inside a closed fold
 * (the decision reader folds its reporter apparatus) is counted but has no
 * box to highlight or scroll to until the fold is open.
 */
const revealRange = (range: Range): void => {
  const container = range.commonAncestorContainer;
  const element =
    container instanceof Element ? container : container.parentElement;
  if (element) {
    revealEnclosingDisclosures(element);
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
