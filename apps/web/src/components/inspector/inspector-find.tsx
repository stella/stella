import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { RefObject } from "react";

import { ChevronLeftIcon, ChevronRightIcon, XIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { DirectionalIcon } from "@stll/ui/directional-icon";
import { Input } from "@stll/ui/input";

import { useExternalSyncEffect } from "@/hooks/use-effect";
import { useLatestCallback } from "@/hooks/use-latest-callback";
import { useFindSurface } from "@/lib/find-owner";

type InspectorFindOptions = {
  /** The text the bar searches: every text node under it is walked. */
  contentRef: RefObject<HTMLElement | null>;
  /** While false the surface is not a candidate and its bar cannot open. */
  enabled: boolean;
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
  panelRef,
}: InspectorFindOptions) => {
  const [findState, setFindState] = useState<FindBarState>(FIND_CLOSED);
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
    setFindState(FIND_CLOSED);
  }, []);

  const openFind = useCallback(() => {
    if (!enabled) {
      return;
    }
    setFindState(findCommanded);
  }, [enabled]);

  const setFindQuery = useCallback((query: string) => {
    setFindState((prev) => (prev.open ? { ...prev, query } : prev));
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
      if (enabled && findOpen && event.key === "Escape") {
        event.preventDefault();
        setFindState(FIND_CLOSED);
      }
    };

    document.addEventListener("keydown", handleKeyDown, { capture: true });
    return () => {
      document.removeEventListener("keydown", handleKeyDown, { capture: true });
    };
  }, [enabled, findOpen]);

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
    if (!findQuery) {
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
        {`
          ::highlight(stella-inspector-find-${highlightKey}) {
            background-color: color-mix(in oklab, var(--color-primary) 22%, transparent);
            color: inherit;
          }
          ::highlight(stella-inspector-find-active-${highlightKey}) {
            background-color: color-mix(in oklab, var(--color-primary) 45%, transparent);
            color: inherit;
          }
        `}
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
        disabled={matchCount === 0}
        onClick={previousMatch}
        size="icon-xs"
        title={t("folio.findReplace.previousShortcut")}
        variant="ghost"
      >
        <DirectionalIcon className="size-3.5" icon={ChevronLeftIcon} />
      </Button>
      <Button
        aria-label={t("common.nextMatch")}
        disabled={matchCount === 0}
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
 * Case-folded text whose offsets still address the original: a character
 * whose lowercase form has a different UTF-16 length (`İ` becomes `i̇`)
 * stays as it is, so an index found in the folded text is valid as a range
 * offset in the node it came from.
 */
const foldCase = (text: string): string => {
  const folded = text.toLocaleLowerCase();
  if (folded.length === text.length) {
    return folded;
  }
  let out = "";
  for (const char of text) {
    const lower = char.toLocaleLowerCase();
    out += lower.length === char.length ? lower : char;
  }
  return out;
};

const collectTextRanges = (root: HTMLElement, query: string): Range[] => {
  const ranges: Range[] = [];
  const normalizedQuery = foldCase(query);
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);

  while (walker.nextNode()) {
    const node = walker.currentNode;
    const text = node.textContent ?? "";
    const normalizedText = foldCase(text);
    let from = 0;

    while (from < normalizedText.length) {
      const index = normalizedText.indexOf(normalizedQuery, from);
      if (index === -1) {
        break;
      }

      const range = document.createRange();
      range.setStart(node, index);
      range.setEnd(node, index + normalizedQuery.length);
      ranges.push(range);
      from = index + Math.max(normalizedQuery.length, 1);
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
