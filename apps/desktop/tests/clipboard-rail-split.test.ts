import { describe, expect, test } from "bun:test";
import * as fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import {
  clipboardRailItems,
  clipboardRailSpacers,
  clipboardRailWindow,
  DEFAULT_CLIPBOARD_SEARCH_OPTIONS,
  filterClipboardItems,
} from "../src/clipboard/clipboard-logic";
import type { ClipboardRailDivider } from "../src/clipboard/clipboard-logic";
import type { ClipboardItem } from "../src/clipboard/clipboard-types";

const clip = (
  id: string,
  plainText: string,
  groupId: string | null,
  minute: number,
): ClipboardItem => ({
  copiedAt: `2026-11-23T10:${String(minute).padStart(2, "0")}:00Z`,
  groupId,
  groupedAt:
    groupId === null
      ? null
      : `2026-11-23T11:${String(minute).padStart(2, "0")}:00Z`,
  id,
  name: null,
  plainText,
  sourceApp: null,
  type: "text",
});

// Newest first, as the timeline keeps them.
const HISTORY = [
  clip("lease-draft", "Lease renewal draft", null, 9),
  clip("lease-clause", "Lease termination clause", "clauses", 8),
  clip("nda", "Mutual NDA", "clauses", 7),
  clip("lease-email", "Email about the lease", null, 6),
  clip("lease-template", "Lease template", "templates", 5),
  clip("signature", "Signature block", "clauses", 4),
];

const ids = (items: readonly ClipboardItem[]) => items.map((item) => item.id);

describe("a search inside a group", () => {
  test("lists the group's matches first and every other match after the divider", () => {
    const rail = clipboardRailItems(HISTORY, "lease", "clauses");
    expect(ids(rail.items)).toEqual([
      "lease-clause",
      "lease-draft",
      "lease-email",
      "lease-template",
    ]);
    expect(rail.dividerIndex).toBe(1);
  });

  test("starts at the divider when nothing in the group matches", () => {
    const rail = clipboardRailItems(HISTORY, "template", "clauses");
    expect(ids(rail.items)).toEqual(["lease-template"]);
    expect(rail.dividerIndex).toBe(0);
  });

  test("is not split when nothing outside the group matches", () => {
    const rail = clipboardRailItems(HISTORY, "signature", "clauses");
    expect(ids(rail.items)).toEqual(["signature"]);
    expect(rail.dividerIndex).toBeNull();
  });

  test("without a group or without a search, the rail is as before", () => {
    for (const [query, groupId] of [
      ["lease", null],
      ["", "clauses"],
      ["   ", "clauses"],
      ["", null],
    ] as const) {
      const rail = clipboardRailItems(HISTORY, query, groupId);
      expect(rail.dividerIndex).toBeNull();
      expect(ids(rail.items)).toEqual(
        ids(filterClipboardItems(HISTORY, query, groupId)),
      );
    }
  });

  const generatedHistory = fc
    .uniqueArray(
      fc.record({
        group: fc.constantFrom(null, "clauses", "templates"),
        id: fc.string({ maxLength: 6, minLength: 1 }),
        minute: fc.integer({ max: 59, min: 0 }),
        words: fc.array(fc.constantFrom("lease", "nda", "clause", "draft"), {
          maxLength: 3,
          minLength: 1,
        }),
      }),
      { maxLength: 24, selector: (entry) => entry.id },
    )
    .map((entries) =>
      entries.map(({ group, id, minute, words }) =>
        clip(id, words.join(" "), group, minute),
      ),
    );

  test("holds every match once, the group's own before the divider", () => {
    assertProperty(
      "holds every match once, the group's own before the divider",
      fc.property(
        generatedHistory,
        fc.constantFrom("lease", "nda clause", "draft"),
        fc.constantFrom("clauses", "templates"),
        (history, query, groupId) => {
          const rail = clipboardRailItems(history, query, groupId);
          const everyMatch = filterClipboardItems(history, query, null);
          // Every match appears, and only once.
          expect(ids(rail.items).toSorted()).toEqual(
            ids(everyMatch).toSorted(),
          );
          const inGroup = filterClipboardItems(history, query, groupId);
          const split = rail.dividerIndex ?? rail.items.length;
          // Before the divider: the group's matches in the group's order.
          expect(ids(rail.items.slice(0, split))).toEqual(ids(inGroup));
          // After it: the rest, in timeline order, none of the group's.
          const rest = rail.items.slice(split);
          expect(rest.every((item) => item.groupId !== groupId)).toBe(true);
          expect(ids(rest)).toEqual(
            ids(everyMatch.filter((item) => item.groupId !== groupId)),
          );
          // A divider only ever has matches after it.
          expect(rail.dividerIndex === null || rest.length > 0).toBe(true);
        },
      ),
    );
  });

  test("follows the search options of the group's own matches", () => {
    const rail = clipboardRailItems(HISTORY, "Lease", "clauses", {
      ...DEFAULT_CLIPBOARD_SEARCH_OPTIONS,
      matchCase: true,
    });
    expect(ids(rail.items)).toEqual([
      "lease-clause",
      "lease-draft",
      "lease-template",
    ]);
  });
});

describe("a rail with a divider", () => {
  const stride = 100;
  const gap = 10;
  const divider: ClipboardRailDivider = { advance: 50, index: 5 };

  test("cards past the divider are found where they sit", () => {
    // The viewport starts just past the divider: the first card after it is
    // in view, not the one a plain stride would name.
    const window = clipboardRailWindow({
      activeIndex: 5,
      divider,
      itemCount: 20,
      overscan: 0,
      scrollOffset: 5 * stride + divider.advance + 1,
      stride,
      viewportWidth: 250,
    });
    expect(window.start).toBe(5);
    const beforeDivider = clipboardRailWindow({
      activeIndex: 4,
      divider,
      itemCount: 20,
      overscan: 0,
      scrollOffset: 4 * stride + 1,
      stride,
      viewportWidth: 250,
    });
    expect(beforeDivider.start).toBe(4);
  });

  test("the spacers and what is mounted always add up to the whole rail", () => {
    const itemCount = 20;
    const whole = itemCount * stride + divider.advance - gap;
    for (let start = 0; start < itemCount; start += 1) {
      for (let end = start + 1; end <= itemCount; end += 1) {
        const spacers = clipboardRailSpacers({
          divider,
          gap,
          itemCount,
          stride,
          window: { end, start },
        });
        const mounted =
          (end - start) * stride +
          (spacers.dividerMounted ? divider.advance : 0);
        // Each spacer that exists is followed by the rail's gap.
        const total =
          (spacers.leading > 0 ? spacers.leading + gap : 0) +
          mounted +
          (spacers.trailing > 0 ? spacers.trailing + gap : 0) -
          gap;
        expect([start, end, total]).toEqual([start, end, whole]);
        expect(spacers.dividerMounted).toBe(
          divider.index >= start && divider.index < end,
        );
      }
    }
  });

  test("a plain rail keeps its spacers as before", () => {
    expect(
      clipboardRailSpacers({
        gap,
        itemCount: 10,
        stride,
        window: { end: 6, start: 2 },
      }),
    ).toEqual({ dividerMounted: false, leading: 190, trailing: 390 });
  });
});
