import { describe, expect, test } from "bun:test";

import type { OutlineItem } from "./outline-rail";
import {
  reconcileOutlineItems,
  retainOutlineIdSet,
} from "./outline-rail.logic";

const outline = (): OutlineItem[] => [
  { id: "10", label: "1. Definitions", level: 0, meta: "1" },
  { id: "42", label: "1.1 Scope", level: 1, meta: "1" },
  { id: "90", label: "2. Waiver", level: 0, meta: "3" },
  { id: "120", label: "3. Notices", level: 0, meta: "4" },
];

// A caller rebuilds every entry on each update: equal content, new objects.
const rebuilt = (items: OutlineItem[]): OutlineItem[] =>
  items.map((item) => ({ ...item }));

describe("reconcileOutlineItems", () => {
  test("a rebuild with unchanged content returns the previous items", () => {
    const previous = outline();
    const next = rebuilt(previous);
    expect(next).not.toBe(previous);
    expect(next.at(0)).not.toBe(previous.at(0));

    expect(reconcileOutlineItems(previous, next)).toBe(previous);
  });

  test("only the entries whose content changed get new objects", () => {
    const previous = outline();
    const next = rebuilt(previous).map((item) =>
      item.id === "90" ? { ...item, meta: "4" } : item,
    );

    const reconciled = reconcileOutlineItems(previous, next);

    expect(reconciled).not.toBe(previous);
    expect(reconciled).toEqual(next);
    expect(reconciled.map((item, index) => item === previous[index])).toEqual([
      true,
      true,
      false,
      true,
    ]);
  });

  // Every field the row renders must count as a change, or a row keeps
  // showing stale content.
  const FIELD_CHANGES = {
    label: (item) => ({ ...item, label: "2. Waivers" }),
    title: (item) => ({ ...item, title: "Waiver of rights" }),
    level: (item) => ({ ...item, level: 1 }),
    meta: ({ meta: _meta, ...item }) => item,
    color: (item) => ({ ...item, color: "--option-blue" }),
    emphasis: (item) => ({ ...item, emphasis: "secondary" }),
    id: (item) => ({ ...item, id: "91" }),
  } as const satisfies Record<
    keyof OutlineItem,
    (item: OutlineItem) => OutlineItem
  >;

  for (const [field, change] of Object.entries(FIELD_CHANGES)) {
    test(`a change to ${field} replaces the entry`, () => {
      const previous = outline();
      const next = rebuilt(previous).map((item) =>
        item.id === "90" ? change(item) : item,
      );

      const reconciled = reconcileOutlineItems(previous, next);

      expect(reconciled.at(2)).toBe(next.at(2));
      expect(reconciled.at(2)).not.toBe(previous.at(2));
    });
  }

  test("an inserted heading keeps the identity of the entries around it", () => {
    const previous = outline();
    const inserted: OutlineItem = {
      id: "100",
      label: "2.1 No implied waiver",
      level: 1,
      meta: "3",
    };
    const next = rebuilt(previous);
    next.splice(3, 0, inserted);

    const reconciled = reconcileOutlineItems(previous, next);

    expect(reconciled).toEqual(next);
    expect(reconciled.slice(0, 3)).toEqual(previous.slice(0, 3));
    for (const [index, item] of previous.slice(0, 3).entries()) {
      expect(reconciled[index]).toBe(item);
    }
    expect(reconciled[3]).toBe(inserted);
    expect(reconciled[4]).toBe(previous[3]);
  });

  test("a removed heading leaves the rest untouched", () => {
    const previous = outline();
    const next = rebuilt(previous).filter((item) => item.id !== "42");

    const reconciled = reconcileOutlineItems(previous, next);

    expect(reconciled).toEqual(next);
    expect(reconciled.every((item) => previous.includes(item))).toBe(true);
  });

  test("reconciling is idempotent", () => {
    const previous = outline();
    const next = rebuilt(previous).map((item) =>
      item.id === "10" ? { ...item, meta: "2" } : item,
    );

    const once = reconcileOutlineItems(previous, next);

    expect(reconcileOutlineItems(once, rebuilt(next))).toBe(once);
  });
});

describe("retainOutlineIdSet", () => {
  test("entries that stay keep their state and new ones get the seed", () => {
    const previous = outline();
    const next = [
      ...rebuilt(previous).filter((item) => item.id !== "120"),
      { id: "150", label: "4. Counterparts", level: 0 },
      { id: "160", label: "4.1 Signatures", level: 1 },
    ];

    const retained = retainOutlineIdSet({
      ids: new Set(["42", "120"]),
      knownIds: new Set(previous.map((item) => item.id)),
      seed: (item) => item.level >= 1,
      items: next,
    });

    // "42" stays collapsed, "90" stays open although the seed would collapse
    // nothing at level 0, "120" left, "160" is new and seeded.
    expect([...retained].toSorted()).toEqual(["160", "42"]);
  });

  test("an unchanged set keeps its identity", () => {
    const items = outline();
    const ids = new Set(["42"]);

    expect(
      retainOutlineIdSet({
        ids,
        knownIds: new Set(items.map((item) => item.id)),
        seed: () => true,
        items: rebuilt(items),
      }),
    ).toBe(ids);
  });
});
