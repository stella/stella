import { describe, expect, test } from "bun:test";

import {
  CLIPBOARD_ITEM_DRAG_TYPE,
  WEBKIT_DRAG_FALLBACK_TYPE,
  clipboardDraggedItemId,
  clipboardSourceTintIndex,
  filterClipboardItems,
  formatClipboardAge,
  highlightClipboardText,
  nextClipboardIndex,
  quickPasteIndex,
} from "../src/clipboard/clipboard-logic";
import type { ClipboardItem } from "../src/clipboard/clipboard-types";

const TEXT_ITEM = {
  copiedAt: "2026-08-23T10:00:00Z",
  groupId: null,
  id: "one",
  plainText: "Share purchase agreement",
  sourceApp: null,
  type: "text",
} satisfies ClipboardItem;

const FORMATTED_ITEM = {
  copiedAt: "2026-08-23T10:01:00Z",
  groupId: null,
  html: "<strong>Closing date</strong>",
  id: "two",
  plainText: "Closing date",
  sourceApp: null,
  type: "formattedText",
} satisfies ClipboardItem;

const ITEMS = [TEXT_ITEM, FORMATTED_ITEM] satisfies ClipboardItem[];

describe("clipboardDraggedItemId", () => {
  const itemIds = new Set(["one", "two"]);

  test("prefers the stella drag payload", () => {
    const data = new Map([
      [CLIPBOARD_ITEM_DRAG_TYPE, "one"],
      [WEBKIT_DRAG_FALLBACK_TYPE, "two"],
    ]);

    expect(
      clipboardDraggedItemId(
        { getData: (type) => data.get(type) ?? "" },
        itemIds,
      ),
    ).toBe("one");
  });

  test("accepts WebKit's fallback when the item is known", () => {
    const data = new Map([[WEBKIT_DRAG_FALLBACK_TYPE, "two"]]);

    expect(
      clipboardDraggedItemId(
        { getData: (type) => data.get(type) ?? "" },
        itemIds,
      ),
    ).toBe("two");
  });

  test("rejects external or stale drag payloads", () => {
    const data = new Map([[WEBKIT_DRAG_FALLBACK_TYPE, "not-a-history-item"]]);

    expect(
      clipboardDraggedItemId(
        { getData: (type) => data.get(type) ?? "" },
        itemIds,
      ),
    ).toBeNull();
  });
});

describe("clipboard search highlighting", () => {
  test("highlights every query term without changing the original text", () => {
    const text = "Share PURCHASE agreement and purchase price";
    const segments = highlightClipboardText(text, "purchase share");

    expect(segments.filter((segment) => segment.match)).toEqual([
      { match: true, text: "Share" },
      { match: true, text: "PURCHASE" },
      { match: true, text: "purchase" },
    ]);
    expect(segments.map((segment) => segment.text).join("")).toBe(text);
  });

  test("treats punctuation in a query as literal text", () => {
    expect(highlightClipboardText("Price (net) + VAT", "(net) +")).toEqual([
      { match: false, text: "Price " },
      { match: true, text: "(net)" },
      { match: false, text: " " },
      { match: true, text: "+" },
      { match: false, text: " VAT" },
    ]);
  });

  test("returns one plain segment when the query is empty", () => {
    expect(highlightClipboardText("Closing date", "  ")).toEqual([
      { match: false, text: "Closing date" },
    ]);
  });
});

describe("filterClipboardItems", () => {
  test("matches every search term without case sensitivity", () => {
    expect(filterClipboardItems(ITEMS, "PURCHASE share")).toEqual([TEXT_ITEM]);
  });

  test("preserves the source order for an empty query", () => {
    expect(filterClipboardItems(ITEMS, "  ")).toBe(ITEMS);
  });

  test("limits results to the selected group before searching", () => {
    const groupedItem = { ...TEXT_ITEM, groupId: "research" };
    const grouped = [groupedItem, FORMATTED_ITEM];

    expect(filterClipboardItems(grouped, "", "research")).toEqual([
      groupedItem,
    ]);
  });
});

test("source apps receive a stable tint from the bounded palette", () => {
  const sourceApps = [
    "com.apple.Safari",
    "com.microsoft.Word",
    "Code.exe",
    "firefox.exe",
  ];

  for (const sourceApp of sourceApps) {
    const tint = clipboardSourceTintIndex(sourceApp);
    expect(tint).toBeGreaterThanOrEqual(0);
    expect(tint).toBeLessThan(6);
    expect(clipboardSourceTintIndex(sourceApp)).toBe(tint);
  }
  expect(clipboardSourceTintIndex(null)).toBeNull();
});

describe("keyboard indexes", () => {
  test("timeline navigation wraps in either direction", () => {
    expect(nextClipboardIndex(1, "next", 2)).toBe(0);
    expect(nextClipboardIndex(0, "previous", 2)).toBe(1);
  });

  test("quick paste only accepts visible slots one through nine", () => {
    expect(quickPasteIndex("2", 2)).toBe(1);
    expect(quickPasteIndex("3", 2)).toBeNull();
    expect(quickPasteIndex("0", 10)).toBeNull();
  });
});

test("formatClipboardAge uses stable low-noise buckets", () => {
  const now = new Date("2026-08-23T10:02:30Z").getTime();
  expect(formatClipboardAge("2026-08-23T10:02:00Z", now)).toEqual({
    type: "lessThan",
    unit: "minute",
    value: 1,
  });
  expect(formatClipboardAge("2026-08-23T08:02:30Z", now)).toEqual({
    type: "lessThan",
    unit: "hour",
    value: 3,
  });
  expect(formatClipboardAge("2026-08-20T08:02:30Z", now)).toEqual({
    type: "elapsed",
    unit: "day",
    value: 3,
  });
});
