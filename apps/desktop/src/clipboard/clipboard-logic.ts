import type { ClipboardItem } from "./clipboard-types";

const CLIPBOARD_SOURCE_TINT_COUNT = 6;

export const CLIPBOARD_ITEM_DRAG_TYPE =
  "application/x-stella-clipboard-item-id";

type ClipboardDragData = Record<string | symbol, unknown>;

export type ClipboardTextSegment = {
  match: boolean;
  text: string;
};

type ClipboardCopyShortcut = {
  altKey: boolean;
  ctrlKey: boolean;
  key: string;
  metaKey: boolean;
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

export const isClipboardCopyShortcut = (shortcut: ClipboardCopyShortcut) =>
  (shortcut.metaKey || shortcut.ctrlKey) &&
  !shortcut.altKey &&
  !shortcut.shiftKey &&
  shortcut.key.toLocaleLowerCase() === "c";

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

const escapeRegExp = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

export const highlightClipboardText = (text: string, query: string) => {
  const normalizedTerms = query
    .trim()
    .split(/\s+/u)
    .map((term) => term.toLocaleLowerCase())
    .filter(Boolean);
  const terms = Array.from(new Set(normalizedTerms)).sort(
    (left, right) => right.length - left.length,
  );
  if (terms.length === 0) {
    return [{ match: false, text }] satisfies ClipboardTextSegment[];
  }

  const matcher = new RegExp(terms.map(escapeRegExp).join("|"), "giu");
  const segments: ClipboardTextSegment[] = [];
  let cursor = 0;
  for (const match of text.matchAll(matcher)) {
    const matchedText = match.at(0);
    if (!matchedText) {
      continue;
    }
    if (match.index > cursor) {
      segments.push({ match: false, text: text.slice(cursor, match.index) });
    }
    segments.push({ match: true, text: matchedText });
    cursor = match.index + matchedText.length;
  }
  if (cursor < text.length) {
    segments.push({ match: false, text: text.slice(cursor) });
  }
  return segments;
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

export const filterClipboardItems = (
  items: readonly ClipboardItem[],
  query: string,
  groupId: string | null = null,
) => {
  const groupedItems = groupId
    ? items.filter((item) => item.groupId === groupId)
    : items;
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) {
    return groupedItems;
  }
  const terms = normalizedQuery.split(/\s+/u);
  return groupedItems.filter((item) => {
    const searchableText =
      `${item.name ?? ""}\n${item.plainText}`.toLocaleLowerCase();
    return terms.every((term) => searchableText.includes(term));
  });
};

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

export const quickCopyIndex = (key: string, itemCount: number) => {
  if (!/^[1-9]$/u.test(key)) {
    return null;
  }
  const index = Number(key) - 1;
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
