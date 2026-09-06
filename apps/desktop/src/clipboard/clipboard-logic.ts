import {
  findSearchMatchRanges,
  foldSearchMatchText,
  foldSearchMatchTextWithOffsets,
} from "@stll/text-normalize";
import type { FoldedSearchText, SearchMatchRange } from "@stll/text-normalize";

import type { ClipboardItem, ClipboardSourceApp } from "./clipboard-types";

const CLIPBOARD_SOURCE_TINT_COUNT = 6;

/** What the accent tint is derived from: the page origin, else the app. */
export const clipboardSourceIdentity = (sourceApp: ClipboardSourceApp) =>
  sourceApp.page?.origin ?? sourceApp.identifier ?? sourceApp.name;

/** The page's host for browser copies (without a leading `www.`), else the app. */
export const clipboardSourceLabel = (sourceApp: ClipboardSourceApp) =>
  sourceApp.page ? sourceApp.page.host.replace(/^www\./u, "") : sourceApp.name;

/** The full page URL for browser copies, else the app name. */
export const clipboardSourceTitle = (sourceApp: ClipboardSourceApp) =>
  sourceApp.page?.url ?? sourceApp.name;

export const CLIPBOARD_ITEM_DRAG_TYPE =
  "application/x-stella-clipboard-item-id";

type ClipboardDragData = Record<string | symbol, unknown>;

export type ClipboardTextSegment = {
  match: boolean;
  text: string;
};

type ClipboardModifiers = {
  altGraphKey: boolean;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
};

type ClipboardCopyShortcut = ClipboardModifiers & {
  key: string;
  shiftKey: boolean;
};

type ClipboardInputKey = {
  dataset: Readonly<Record<string, string | undefined>>;
  isComposing: boolean;
  key: string;
};

export const isClipboardNameInput = (
  dataset: Readonly<Record<string, string | undefined>>,
) => Object.hasOwn(dataset, "clipboardNameInput");

export const shouldCopyFromClipboardInput = ({
  dataset,
  isComposing,
  key,
}: ClipboardInputKey) =>
  !isClipboardNameInput(dataset) && key === "Enter" && !isComposing;

/**
 * ArrowUp in the search field hands focus back to the selected card (the rail
 * sits above the search bar). Composition keeps ArrowUp for the IME's
 * candidate list, and a clip name editor keeps its caret.
 */
export const shouldReturnToTimelineFromInput = ({
  dataset,
  isComposing,
  key,
}: ClipboardInputKey) =>
  !isClipboardNameInput(dataset) && key === "ArrowUp" && !isComposing;

/**
 * Command, or Control on Windows and Linux. Alt disqualifies the combination:
 * AltGr reports as Ctrl+Alt there, so a layout that produces a character with
 * AltGr (`@` on AltGr+2, `ć` on AltGr+C) would otherwise fire a shortcut
 * instead of typing.
 */
export const hasClipboardPrimaryModifier = ({
  altGraphKey,
  altKey,
  ctrlKey,
  metaKey,
}: ClipboardModifiers) => (metaKey || ctrlKey) && !altKey && !altGraphKey;

export const isClipboardCopyShortcut = (shortcut: ClipboardCopyShortcut) =>
  hasClipboardPrimaryModifier(shortcut) &&
  !shortcut.shiftKey &&
  shortcut.key.toLocaleLowerCase() === "c";

export const clipboardTimelineKeyAction = (key: string) => {
  switch (key) {
    case "ArrowDown":
      return "focusSearch";
    case "ArrowLeft":
      return "previous";
    case "ArrowRight":
      return "next";
    default:
      return null;
  }
};

export const clipboardDraggedItemId = (
  data: ClipboardDragData,
  itemIds: ReadonlySet<string>,
) => {
  if (data["type"] !== CLIPBOARD_ITEM_DRAG_TYPE) {
    return null;
  }
  const itemId = data["itemId"];
  return typeof itemId === "string" && itemIds.has(itemId) ? itemId : null;
};

/**
 * Deduplicated diacritic-folded query terms, longest first so overlapping
 * terms match whole. The whole query is folded before splitting because
 * compatibility decomposition can itself produce whitespace (NBSP).
 */
const clipboardQueryTerms = (query: string) => {
  const normalizedTerms = foldSearchMatchText(query)
    .split(/\s+/u)
    .filter(Boolean);
  return Array.from(new Set(normalizedTerms)).sort(
    (left, right) => right.length - left.length,
  );
};

export const highlightClipboardText = (text: string, query: string) => {
  const terms = clipboardQueryTerms(query);
  if (terms.length === 0) {
    return [{ match: false, text }] satisfies ClipboardTextSegment[];
  }

  const foldedText = foldSearchMatchTextWithOffsets(text);
  const ranges: SearchMatchRange[] = [];
  for (const term of terms) {
    ranges.push(...findSearchMatchRanges(foldedText, term));
  }
  // Same start prefers the longer term; a range starting inside an already
  // highlighted one is dropped.
  ranges.sort(
    (left, right) => left.start - right.start || right.end - left.end,
  );
  const segments: ClipboardTextSegment[] = [];
  let cursor = 0;
  for (const range of ranges) {
    if (range.start < cursor) {
      continue;
    }
    if (range.start > cursor) {
      segments.push({ match: false, text: text.slice(cursor, range.start) });
    }
    segments.push({ match: true, text: text.slice(range.start, range.end) });
    cursor = range.end;
  }
  if (cursor < text.length) {
    segments.push({ match: false, text: text.slice(cursor) });
  }
  return segments;
};

// The card preview clamps at eight lines of roughly forty characters; a first
// match past either budget would be clipped out of view.
const SEARCH_PREVIEW_PREFIX_CHARACTERS = 96;
const SEARCH_PREVIEW_PREFIX_LINES = 4;
/** Context kept ahead of a distant first match. */
const SEARCH_PREVIEW_LEAD_CHARACTERS = 24;

/**
 * The clamped preview shows ~320 characters at most; text past this budget can
 * never become visible, while rendering a full 64 KiB clip into every card
 * (one highlight span per match) made search repaints crawl.
 */
export const CLIPBOARD_CARD_PREVIEW_MAX_CHARACTERS = 1000;

export type ClipboardSearchPreview = { text: string; truncated: boolean };

type ClipboardSearchPreviewSource = {
  name?: string | null;
  plainText?: string;
};

/**
 * Folding a 64 KiB clip character by character is the expensive step of the
 * windowed preview, and every rendered card repeats it per query change.
 * Keyed weakly by the item object: a snapshot replaces its items wholesale,
 * so stale entries fall away with the old snapshot.
 */
const foldedPlainTextCache = new WeakMap<
  ClipboardSearchPreviewSource,
  FoldedSearchText
>();

const foldedPlainText = (item: ClipboardSearchPreviewSource) => {
  const cached = foldedPlainTextCache.get(item);
  if (cached) {
    return cached;
  }
  const folded = foldSearchMatchTextWithOffsets(item.plainText ?? "");
  foldedPlainTextCache.set(item, folded);
  return folded;
};

/**
 * Text to render for a searched clip: the full text while the first match
 * falls inside the clamped preview, otherwise a window that starts one word
 * boundary ahead of the first match so the highlighted hit is visible.
 */
export const clipboardSearchPreviewText = (
  item: ClipboardSearchPreviewSource,
  query: string,
): ClipboardSearchPreview => {
  const text = item.plainText ?? "";
  const cap = (value: string) =>
    value.slice(0, CLIPBOARD_CARD_PREVIEW_MAX_CHARACTERS);
  const terms = clipboardQueryTerms(query);
  if (terms.length === 0) {
    return { text: cap(text), truncated: false };
  }
  const foldedText = foldedPlainText(item);
  let matchIndex = -1;
  for (const term of terms) {
    const first = findSearchMatchRanges(foldedText, term, {
      maxMatches: 1,
    }).at(0);
    if (first && (matchIndex === -1 || first.start < matchIndex)) {
      matchIndex = first.start;
    }
  }
  if (matchIndex === -1) {
    return { text: cap(text), truncated: false };
  }
  const prefixLines = text.slice(0, matchIndex).split("\n").length - 1;
  if (
    matchIndex <= SEARCH_PREVIEW_PREFIX_CHARACTERS &&
    prefixLines < SEARCH_PREVIEW_PREFIX_LINES
  ) {
    return { text: cap(text), truncated: false };
  }
  // Start at the match's line when it is short enough, otherwise at the first
  // word boundary inside the lead window; without one the fragment of a long
  // word is dropped and the preview starts at the match itself.
  const lineStart = text.lastIndexOf("\n", matchIndex - 1) + 1;
  let start = lineStart;
  if (matchIndex - lineStart > SEARCH_PREVIEW_LEAD_CHARACTERS) {
    const windowStart = matchIndex - SEARCH_PREVIEW_LEAD_CHARACTERS;
    const boundary = text.slice(windowStart, matchIndex).search(/\s\S/u);
    start = boundary === -1 ? matchIndex : windowStart + boundary + 1;
  }
  return { text: cap(text.slice(start).trimStart()), truncated: true };
};

export const clipboardSourceTintIndex = (sourceIdentity: string | null) => {
  if (!sourceIdentity) {
    return null;
  }
  let hash = 0;
  for (const character of sourceIdentity) {
    hash = (hash * 131 + (character.codePointAt(0) ?? 0)) % 2_147_483_647;
  }
  return hash % CLIPBOARD_SOURCE_TINT_COUNT;
};

type ClipboardRailWindowOptions = {
  activeIndex: number;
  itemCount: number;
  overscan: number;
  scrollLeft: number;
  /** Card width plus the gap that follows it. */
  stride: number;
  /** 0 before the rail has been measured. */
  viewportWidth: number;
};

/** Half-open index range `[start, end)` of cards to keep mounted. */
export type ClipboardRailWindow = { end: number; start: number };

type ClipboardRailScrollDeltaOptions = {
  cardEnd: number;
  cardStart: number;
  viewportEnd: number;
  viewportStart: number;
};

export const clipboardRailScrollDelta = ({
  cardEnd,
  cardStart,
  viewportEnd,
  viewportStart,
}: ClipboardRailScrollDeltaOptions) => {
  if (cardStart < viewportStart) {
    return cardStart - viewportStart;
  }
  if (cardEnd > viewportEnd) {
    return cardEnd - viewportEnd;
  }
  return 0;
};

const UNMEASURED_VISIBLE_CARDS = 8;

/**
 * Cards mounted for a horizontal rail: always the ones intersecting the
 * viewport (from `scrollLeft`) plus `overscan` on each side, so pointer
 * scrolling never reveals an unmounted region. The range is extended to
 * include the active card when it sits outside the viewport (keyboard jump,
 * focus after reopen) so it stays in the DOM for focus and scroll-into-view.
 */
export const clipboardRailWindow = ({
  activeIndex,
  itemCount,
  overscan,
  scrollLeft,
  stride,
  viewportWidth,
}: ClipboardRailWindowOptions): ClipboardRailWindow => {
  if (itemCount === 0) {
    return { end: 0, start: 0 };
  }
  const visible =
    viewportWidth > 0
      ? Math.ceil(viewportWidth / stride) + 1
      : UNMEASURED_VISIBLE_CARDS;
  const viewportStart = Math.floor(Math.max(0, scrollLeft) / stride);
  const active = Math.min(Math.max(0, activeIndex), itemCount - 1);
  const start = Math.min(viewportStart, active);
  const end = Math.max(viewportStart + visible, active + 1);
  return {
    end: Math.min(itemCount, end + overscan),
    start: Math.max(0, start - overscan),
  };
};

/**
 * The filter runs on every keystroke over every clip; folding megabytes of
 * history each time dominated search latency. Keyed weakly by the item
 * object: a snapshot replaces its items wholesale, so stale entries fall away
 * with the old snapshot, and an item's text only changes via a new snapshot.
 */
const searchableTextCache = new WeakMap<ClipboardItem, string>();

const clipboardSearchableText = (item: ClipboardItem) => {
  const cached = searchableTextCache.get(item);
  if (cached !== undefined) {
    return cached;
  }
  const searchableText = foldSearchMatchText(
    `${item.name ?? ""}\n${item.type === "image" ? "" : item.plainText}`,
  );
  searchableTextCache.set(item, searchableText);
  return searchableText;
};

export const filterClipboardItems = (
  items: readonly ClipboardItem[],
  query: string,
  groupId: string | null = null,
) => {
  // The timeline follows recency; a group keeps the order clips were added
  // in, so copying a clip again never reshuffles the group.
  const groupedItems = groupId
    ? items
        .filter((item) => item.groupId === groupId)
        .sort((left, right) =>
          (right.groupedAt ?? right.copiedAt).localeCompare(
            left.groupedAt ?? left.copiedAt,
          ),
        )
    : items;
  const terms = clipboardQueryTerms(query);
  if (terms.length === 0) {
    return groupedItems;
  }
  return groupedItems.filter((item) => {
    const searchableText = clipboardSearchableText(item);
    return terms.every((term) => searchableText.includes(term));
  });
};

export type ClipboardPointerPosition = {
  x: number;
  y: number;
};

/**
 * Browsers replay a pointer move at the unchanged screen position after a
 * scroll so hover state follows the content; only a pointer that actually
 * moved may change the selection, or arrow-key scrolling would hand it back to
 * the card that slid under the cursor. The first event after (re)opening only
 * seeds the position: a pointer resting over the rail has not moved either.
 */
export const clipboardPointerMoved = (
  previous: ClipboardPointerPosition | null,
  current: ClipboardPointerPosition,
) =>
  previous !== null && (previous.x !== current.x || previous.y !== current.y);

export const adjacentClipboardIndex = (
  currentIndex: number,
  direction: "next" | "previous",
  itemCount: number,
) => {
  if (itemCount === 0) {
    return null;
  }
  const offset = direction === "next" ? 1 : -1;
  const nextIndex = currentIndex + offset;
  return nextIndex < 0 || nextIndex >= itemCount ? null : nextIndex;
};

/**
 * Quick copy slots follow the physical digit row (`event.code`), not the
 * produced character: layouts such as Czech or French put symbols on the
 * unshifted digit keys, so `event.key` would never be a digit there.
 */
export const quickCopyIndex = (code: string, itemCount: number) => {
  const match = /^(?:Digit|Numpad)([1-9])$/u.exec(code);
  if (!match) {
    return null;
  }
  const index = Number(match[1]) - 1;
  return index < itemCount ? index : null;
};

export const formatClipboardAge = (copiedAt: string, now = Date.now()) => {
  const elapsedSeconds = Math.max(
    0,
    Math.floor((now - new Date(copiedAt).getTime()) / 1000),
  );
  if (elapsedSeconds < 60) {
    return { type: "lessThan", unit: "minute", value: 1 } as const;
  }
  if (elapsedSeconds < 5 * 60) {
    return { type: "lessThan", unit: "minute", value: 5 } as const;
  }
  if (elapsedSeconds < 15 * 60) {
    return { type: "lessThan", unit: "minute", value: 15 } as const;
  }
  if (elapsedSeconds < 30 * 60) {
    return { type: "lessThan", unit: "minute", value: 30 } as const;
  }
  if (elapsedSeconds < 60 * 60) {
    return { type: "lessThan", unit: "hour", value: 1 } as const;
  }
  if (elapsedSeconds < 3 * 60 * 60) {
    return { type: "lessThan", unit: "hour", value: 3 } as const;
  }
  if (elapsedSeconds < 6 * 60 * 60) {
    return { type: "lessThan", unit: "hour", value: 6 } as const;
  }
  if (elapsedSeconds < 12 * 60 * 60) {
    return { type: "lessThan", unit: "hour", value: 12 } as const;
  }
  if (elapsedSeconds < 24 * 60 * 60) {
    return { type: "lessThan", unit: "day", value: 1 } as const;
  }
  return {
    type: "elapsed",
    unit: "day",
    value: Math.floor(elapsedSeconds / (24 * 60 * 60)),
  } as const;
};
