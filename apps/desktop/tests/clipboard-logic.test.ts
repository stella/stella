import { describe, expect, test } from "bun:test";

import {
  CLIPBOARD_ITEM_DRAG_TYPE,
  clipboardDraggedItemId,
  clipboardSourceTintIndex,
  filterClipboardItems,
  formatClipboardAge,
  highlightClipboardText,
  isClipboardCopyShortcut,
  isClipboardNameInput,
  nextClipboardIndex,
  quickCopyIndex,
  shouldCopyFromClipboardInput,
} from "../src/clipboard/clipboard-logic";
import type { ClipboardItem } from "../src/clipboard/clipboard-types";

const TEXT_ITEM = {
  copiedAt: "2026-08-23T10:00:00Z",
  groupId: null,
  id: "one",
  name: "Acquisition draft",
  plainText: "Share purchase agreement",
  sourceApp: null,
  type: "text",
} satisfies ClipboardItem;

const FORMATTED_ITEM = {
  copiedAt: "2026-08-23T10:01:00Z",
  groupId: null,
  html: "<strong>Closing date</strong>",
  id: "two",
  name: null,
  plainText: "Closing date",
  sourceApp: null,
  type: "formattedText",
} satisfies ClipboardItem;

const ITEMS = [TEXT_ITEM, FORMATTED_ITEM] satisfies ClipboardItem[];

describe("clipboardDraggedItemId", () => {
  const itemIds = new Set(["one", "two"]);

  test("accepts a known stella clipboard item", () => {
    expect(
      clipboardDraggedItemId(
        { itemId: "one", type: CLIPBOARD_ITEM_DRAG_TYPE },
        itemIds,
      ),
    ).toBe("one");
  });

  test("rejects data from another drag source", () => {
    expect(
      clipboardDraggedItemId({ itemId: "one", type: "other" }, itemIds),
    ).toBeNull();
  });

  test("rejects stale clipboard items", () => {
    expect(
      clipboardDraggedItemId(
        {
          itemId: "not-a-history-item",
          type: CLIPBOARD_ITEM_DRAG_TYPE,
        },
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

  test("matches an editable clip name", () => {
    expect(filterClipboardItems(ITEMS, "acquisition draft")).toEqual([
      TEXT_ITEM,
    ]);
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
  test("timeline navigation stops at either edge", () => {
    expect(nextClipboardIndex(0, "next", 2)).toBe(1);
    expect(nextClipboardIndex(1, "next", 2)).toBe(1);
    expect(nextClipboardIndex(1, "previous", 2)).toBe(0);
    expect(nextClipboardIndex(0, "previous", 2)).toBe(0);
  });

  test("quick copy only accepts visible slots one through nine", () => {
    expect(quickCopyIndex("2", 2)).toBe(1);
    expect(quickCopyIndex("3", 2)).toBeNull();
    expect(quickCopyIndex("0", 10)).toBeNull();
  });

  test("copy accepts either platform primary modifier", () => {
    expect(
      isClipboardCopyShortcut({
        altKey: false,
        ctrlKey: false,
        key: "c",
        metaKey: true,
        shiftKey: false,
      }),
    ).toBe(true);
    expect(
      isClipboardCopyShortcut({
        altKey: false,
        ctrlKey: true,
        key: "C",
        metaKey: false,
        shiftKey: false,
      }),
    ).toBe(true);
  });

  test("copy does not consume modified variants", () => {
    expect(
      isClipboardCopyShortcut({
        altKey: false,
        ctrlKey: false,
        key: "c",
        metaKey: false,
        shiftKey: false,
      }),
    ).toBe(false);
    expect(
      isClipboardCopyShortcut({
        altKey: false,
        ctrlKey: true,
        key: "c",
        metaKey: false,
        shiftKey: true,
      }),
    ).toBe(false);
  });
});

describe("clipboard input keyboard handling", () => {
  test("recognizes a clip name editor from its data attribute", () => {
    expect(isClipboardNameInput({ clipboardNameInput: "" })).toBe(true);
    expect(isClipboardNameInput({})).toBe(false);
  });

  test("Enter in a clip name editor never triggers timeline copy", () => {
    expect(
      shouldCopyFromClipboardInput({
        dataset: { clipboardNameInput: "" },
        isComposing: false,
        key: "Enter",
      }),
    ).toBe(false);
  });

  test("Enter in search copies unless an input method is composing", () => {
    expect(
      shouldCopyFromClipboardInput({
        dataset: {},
        isComposing: false,
        key: "Enter",
      }),
    ).toBe(true);
    expect(
      shouldCopyFromClipboardInput({
        dataset: {},
        isComposing: true,
        key: "Enter",
      }),
    ).toBe(false);
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
