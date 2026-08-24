import type { ClipboardItem } from "./clipboard-types";

const CLIPBOARD_SOURCE_TINT_COUNT = 6;

export const CLIPBOARD_ITEM_DRAG_TYPE =
  "application/x-stella-clipboard-item-id";
export const WEBKIT_DRAG_FALLBACK_TYPE = "text/plain";

type ClipboardDragData = {
  getData: (type: string) => string;
};

export type ClipboardTextSegment = {
  match: boolean;
  text: string;
};

export const clipboardDraggedItemId = (
  data: ClipboardDragData,
  itemIds: ReadonlySet<string>,
) => {
  const itemId =
    data.getData(CLIPBOARD_ITEM_DRAG_TYPE) ||
    data.getData(WEBKIT_DRAG_FALLBACK_TYPE);
  return itemIds.has(itemId) ? itemId : null;
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
    const text = item.plainText.toLocaleLowerCase();
    return terms.every((term) => text.includes(term));
  });
};

export const nextClipboardIndex = (
  currentIndex: number,
  direction: "next" | "previous",
  itemCount: number,
) => {
  if (itemCount === 0) {
    return 0;
  }
  const offset = direction === "next" ? 1 : -1;
  return (currentIndex + offset + itemCount) % itemCount;
};

export const quickPasteIndex = (key: string, itemCount: number) => {
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
