import { describe, expect, test } from "bun:test";

import {
  adjacentClipboardIndex,
  CLIPBOARD_ITEM_DRAG_TYPE,
  clipboardDraggedItemId,
  clipboardPointerMoved,
  clipboardTimelineKeyAction,
  clipboardRailScrollDelta,
  clipboardRailWindow,
  clipboardSourceTintIndex,
  filterClipboardItems,
  formatClipboardAge,
  highlightClipboardText,
  isClipboardCopyShortcut,
  isClipboardNameInput,
  quickCopyIndex,
  shouldCopyFromClipboardInput,
  shouldReturnToTimelineFromInput,
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
  test("timeline arrows navigate horizontally and Arrow Down focuses search", () => {
    expect(clipboardTimelineKeyAction("ArrowLeft")).toBe("previous");
    expect(clipboardTimelineKeyAction("ArrowRight")).toBe("next");
    expect(clipboardTimelineKeyAction("ArrowDown")).toBe("focusSearch");
    expect(clipboardTimelineKeyAction("ArrowUp")).toBeNull();
  });

  test("timeline navigation has no target beyond either edge", () => {
    expect(adjacentClipboardIndex(0, "next", 2)).toBe(1);
    expect(adjacentClipboardIndex(1, "next", 2)).toBeNull();
    expect(adjacentClipboardIndex(1, "previous", 2)).toBe(0);
    expect(adjacentClipboardIndex(0, "previous", 2)).toBeNull();
    expect(adjacentClipboardIndex(0, "next", 0)).toBeNull();
  });

  test("a pointer move replayed after a scroll does not count as movement", () => {
    expect(clipboardPointerMoved(null, { x: 10, y: 20 })).toBe(false);
    expect(clipboardPointerMoved({ x: 10, y: 20 }, { x: 10, y: 20 })).toBe(
      false,
    );
    expect(clipboardPointerMoved({ x: 10, y: 20 }, { x: 11, y: 20 })).toBe(
      true,
    );
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

  test("ArrowUp in search returns focus to the timeline", () => {
    expect(
      shouldReturnToTimelineFromInput({
        dataset: {},
        isComposing: false,
        key: "ArrowUp",
      }),
    ).toBe(true);
    expect(
      shouldReturnToTimelineFromInput({
        dataset: {},
        isComposing: true,
        key: "ArrowUp",
      }),
    ).toBe(false);
    expect(
      shouldReturnToTimelineFromInput({
        dataset: { clipboardNameInput: "" },
        isComposing: false,
        key: "ArrowUp",
      }),
    ).toBe(false);
    expect(
      shouldReturnToTimelineFromInput({
        dataset: {},
        isComposing: false,
        key: "ArrowDown",
      }),
    ).toBe(false);
  });
});

describe("clipboardRailWindow", () => {
  const base = { overscan: 2, stride: 100, viewportWidth: 450 };

  test("mounts only the cards intersecting the viewport plus overscan", () => {
    expect(
      clipboardRailWindow({
        ...base,
        activeIndex: 0,
        itemCount: 500,
        scrollLeft: 0,
      }),
    ).toEqual({ end: 8, start: 0 });
    expect(
      clipboardRailWindow({
        ...base,
        activeIndex: 250,
        itemCount: 500,
        scrollLeft: 25_000,
      }),
    ).toEqual({ end: 258, start: 248 });
  });

  test("keeps the active card mounted when it is outside the viewport", () => {
    const window = clipboardRailWindow({
      ...base,
      activeIndex: 499,
      itemCount: 500,
      scrollLeft: 0,
    });
    // The viewport is at the head while the selection is at the tail, so the
    // window spans both; the point is that neither is left unmounted.
    expect(window.start).toBe(0);
    expect(window.end).toBe(500);
  });

  test("always mounts the viewport and the active card", () => {
    // The viewport range must stay mounted for every scroll offset, otherwise
    // pointer scrolling reveals an unmounted (blank) region of the rail.
    for (let scrollLeft = 0; scrollLeft <= 50_000; scrollLeft += 731) {
      for (const activeIndex of [0, 1, 7, 8, 9, 250, 498, 499, 900]) {
        const window = clipboardRailWindow({
          ...base,
          activeIndex,
          itemCount: 500,
          scrollLeft,
        });
        expect(window.start).toBeGreaterThanOrEqual(0);
        expect(window.end).toBeLessThanOrEqual(500);

        const firstVisible = Math.floor(scrollLeft / base.stride);
        const lastVisible = Math.min(
          499,
          firstVisible + Math.ceil(base.viewportWidth / base.stride),
        );
        expect(window.start).toBeLessThanOrEqual(firstVisible);
        expect(window.end).toBeGreaterThan(lastVisible);

        const active = Math.min(activeIndex, 499);
        expect(active).toBeGreaterThanOrEqual(window.start);
        expect(active).toBeLessThan(window.end);
      }
    }
  });

  test("stays bounded to the viewport when the selection is in view", () => {
    // Pointer scroll keeps the hovered card selected, so the common case keeps
    // a small window even in a large history.
    const window = clipboardRailWindow({
      ...base,
      activeIndex: 251,
      itemCount: 500,
      scrollLeft: 25_000,
    });
    expect(window.end - window.start).toBeLessThanOrEqual(6 + 2 * 2);
  });

  test("renders a default window before the rail is measured", () => {
    expect(
      clipboardRailWindow({
        activeIndex: 0,
        itemCount: 3,
        overscan: 2,
        scrollLeft: 0,
        stride: 100,
        viewportWidth: 0,
      }),
    ).toEqual({ end: 3, start: 0 });
  });
});

describe("clipboardRailScrollDelta", () => {
  test("does not move a fully visible keyboard target", () => {
    expect(
      clipboardRailScrollDelta({
        cardEnd: 650,
        cardStart: 400,
        viewportEnd: 1000,
        viewportStart: 0,
      }),
    ).toBe(0);
  });

  test("moves only far enough to reveal a target beyond either edge", () => {
    expect(
      clipboardRailScrollDelta({
        cardEnd: 200,
        cardStart: -50,
        viewportEnd: 1000,
        viewportStart: 0,
      }),
    ).toBe(-50);
    expect(
      clipboardRailScrollDelta({
        cardEnd: 1050,
        cardStart: 800,
        viewportEnd: 1000,
        viewportStart: 0,
      }),
    ).toBe(50);
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
