import { describe, expect, test } from "bun:test";

import { hasTabOrderChanged } from "./tab-order";

// Stand-ins for tab elements. `hasTabOrderChanged` compares by identity, so
// distinct objects are enough; the DOM adds nothing to the invariant.
const makeTabs = (count: number) => Array.from({ length: count }, () => ({}));

describe("tab order change detection", () => {
  test("reports no change when the same elements stay in place", () => {
    const tabs = makeTabs(5);

    expect(hasTabOrderChanged(tabs, [...tabs])).toBe(false);
    expect(hasTabOrderChanged([], [])).toBe(false);
  });

  test("reports every reordering of the same elements", () => {
    const tabs = makeTabs(4);

    // A drag reorder moves the same DOM nodes, so nothing but identity order
    // distinguishes the commits. Cover every swap rather than one example.
    for (let from = 0; from < tabs.length; from++) {
      for (let to = 0; to < tabs.length; to++) {
        const moved = tabs.filter((_, index) => index !== from);
        const dragged = tabs[from];
        if (dragged === undefined) {
          continue;
        }
        moved.splice(to, 0, dragged);

        expect(hasTabOrderChanged(tabs, moved)).toBe(from !== to);
      }
    }
  });

  test("reports insertions and removals", () => {
    const tabs = makeTabs(3);
    const [first, second, third] = tabs;
    if (first === undefined || second === undefined || third === undefined) {
      throw new Error("fixture must have three tabs");
    }

    expect(hasTabOrderChanged(tabs, [first, second])).toBe(true);
    expect(hasTabOrderChanged([first, second], tabs)).toBe(true);
    // A removal that shortens the list still differs at the surviving indexes.
    expect(hasTabOrderChanged(tabs, [second, third])).toBe(true);
  });

  test("reports the first commit, when nothing has been measured yet", () => {
    expect(hasTabOrderChanged([], makeTabs(3))).toBe(true);
  });

  test("reports a swap that preserves the element count", () => {
    const tabs = makeTabs(2);
    const [first, second] = tabs;
    if (first === undefined || second === undefined) {
      throw new Error("fixture must have two tabs");
    }

    // Guards the length-only comparison: same count, different order.
    expect(hasTabOrderChanged(tabs, [second, first])).toBe(true);
  });
});
