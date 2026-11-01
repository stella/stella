import { describe, expect, test } from "bun:test";

import { hasTabOrderChanged, revealActiveTab } from "./tab-order";

// `hasTabOrderChanged` compares by identity, so distinct objects stand in for
// tab elements; the DOM adds nothing to the invariant.
const makeTabs = (count: number) => Array.from({ length: count }, () => ({}));

describe("tab order change detection", () => {
  test("reports no change when the same elements stay in place", () => {
    const tabs = makeTabs(5);

    expect(hasTabOrderChanged(tabs, [...tabs])).toBe(false);
    expect(hasTabOrderChanged([], [])).toBe(false);
  });

  test("reports every reordering of the same elements", () => {
    const tabs = makeTabs(4);

    // The reorder case is the one Base UI misses, and it moves the same nodes,
    // so only identity order separates the commits. A length-only comparison
    // passes every other test here and fails this one.
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
    expect(hasTabOrderChanged(tabs, [second, third])).toBe(true);
  });

  test("reports the first commit, when nothing has been measured yet", () => {
    expect(hasTabOrderChanged([], makeTabs(3))).toBe(true);
  });
});

describe("revealing the active tab", () => {
  type Edges = { left: number; right: number };

  const stripWith = ({
    tab,
    scrollLeft = 0,
  }: {
    tab: Edges | null;
    scrollLeft?: number;
  }) => ({
    scrollLeft,
    getBoundingClientRect: () => ({ left: 100, right: 300 }),
    querySelector: () =>
      tab === null ? null : { getBoundingClientRect: () => tab },
  });

  test("scrolls a tab past the far edge back in", () => {
    const strip = stripWith({ tab: { left: 280, right: 350 } });
    revealActiveTab(strip);
    expect(strip.scrollLeft).toBe(50);
  });

  test("scrolls a tab before the near edge back in", () => {
    const strip = stripWith({
      scrollLeft: 120,
      tab: { left: 60, right: 130 },
    });
    revealActiveTab(strip);
    expect(strip.scrollLeft).toBe(80);
  });

  test("moves a right-to-left strip by the same edge distance", () => {
    const strip = stripWith({
      scrollLeft: -200,
      tab: { left: 280, right: 350 },
    });
    revealActiveTab(strip);
    expect(strip.scrollLeft).toBe(-150);
  });

  test("leaves a visible tab, and a strip with no active tab, alone", () => {
    const visible = stripWith({
      scrollLeft: 30,
      tab: { left: 150, right: 220 },
    });
    revealActiveTab(visible);
    expect(visible.scrollLeft).toBe(30);

    const empty = stripWith({ scrollLeft: 30, tab: null });
    revealActiveTab(empty);
    expect(empty.scrollLeft).toBe(30);
  });
});
