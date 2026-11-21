import { describe, expect, test } from "bun:test";

import {
  chatActivityByWorkspace,
  selectPinnedThenRecentWorkspaces,
} from "@/components/app-sidebar.logic";

import {
  groupMatterOptions,
  isBrowsingMatters,
  matchesMatterOption,
  MATTER_PICKER_RECENT_LIMIT,
} from "./matter-combobox.logic";

// Eight matters, newest activity first: matter-0 is the most recent.
const workspaces = Array.from({ length: 8 }, (_, index) => ({
  id: `matter-${index}`,
  lastActivityAt: new Date(Date.UTC(2026, 9, 10 - index)),
}));

const recentIds = ({
  chat = new Map<string, string>(),
  pinnedOrder = [],
}: {
  chat?: Map<string, string>;
  pinnedOrder?: string[];
}) =>
  selectPinnedThenRecentWorkspaces({
    chatActivityByWorkspaceId: chat,
    limit: MATTER_PICKER_RECENT_LIMIT,
    pinnedOrder,
    workspaces,
  }).map(({ id }) => id);

describe("recent matters in the picker", () => {
  test("ranks by activity and stops at the limit", () => {
    expect(recentIds({})).toEqual([
      "matter-0",
      "matter-1",
      "matter-2",
      "matter-3",
      "matter-4",
    ]);
  });

  test("leads with pinned matters in pinned order, then the most active rest", () => {
    expect(recentIds({ pinnedOrder: ["matter-6", "matter-2"] })).toEqual([
      "matter-6",
      "matter-2",
      "matter-0",
      "matter-1",
      "matter-3",
    ]);
  });

  test("never offers more than the limit, even with more pins", () => {
    const pinnedOrder = workspaces.map(({ id }) => id).toReversed();
    expect(recentIds({ pinnedOrder })).toEqual(pinnedOrder.slice(0, 5));
  });

  test("ignores a pin whose matter is not in the list", () => {
    expect(recentIds({ pinnedOrder: ["gone", "matter-7"] }).at(0)).toBe(
      "matter-7",
    );
  });

  test("a recent chat lifts its matter like it does in the sidebar", () => {
    const chat = chatActivityByWorkspace({
      workspaces: [
        {
          workspaceId: "matter-7",
          threads: [{ updatedAt: "2026-10-11T08:00:00.000Z" }],
        },
      ],
    });
    expect(recentIds({ chat }).at(0)).toBe("matter-7");
  });
});

describe("grouping picker options", () => {
  const matters = workspaces.map(({ id }) => ({ id }));

  test("puts recent matters first and the rest under all matters, once each", () => {
    const groups = groupMatterOptions({
      matters,
      recentIds: ["matter-5", "matter-1"],
    });
    expect(
      groups.map(({ value, items }) => [value, items.map(({ id }) => id)]),
    ).toEqual([
      ["recent", ["matter-5", "matter-1"]],
      [
        "all",
        [
          "matter-0",
          "matter-2",
          "matter-3",
          "matter-4",
          "matter-6",
          "matter-7",
        ],
      ],
    ]);
  });

  test("leaves out an empty group", () => {
    expect(
      groupMatterOptions({ matters, recentIds: [] }).map(({ value }) => value),
    ).toEqual(["all"]);
    expect(groupMatterOptions({ matters: [], recentIds: [] })).toEqual([]);
  });

  test("groups while browsing and drops them once the reader types", () => {
    expect(isBrowsingMatters({ query: "", selectedName: null })).toBe(true);
    expect(isBrowsingMatters({ query: "  ", selectedName: null })).toBe(true);
    expect(isBrowsingMatters({ query: "nov", selectedName: null })).toBe(false);
    // The field still showing the chosen matter's name is not a search.
    expect(isBrowsingMatters({ query: "Novák", selectedName: "Novák" })).toBe(
      true,
    );
    expect(isBrowsingMatters({ query: "Nová", selectedName: "Novák" })).toBe(
      false,
    );
  });
});

describe("matter option search", () => {
  const matter = { clientName: "Dvořák & Straße s.r.o.", name: "Nájem Łódź" };

  test("matches the name or the client name, ignoring case and accents", () => {
    expect(matchesMatterOption(matter, "najem lodz")).toBe(true);
    expect(matchesMatterOption(matter, "DVORAK")).toBe(true);
    expect(matchesMatterOption(matter, "strasse")).toBe(true);
    expect(matchesMatterOption(matter, "kupní")).toBe(false);
  });

  test("a matter without a client matches on its name only", () => {
    expect(
      matchesMatterOption({ clientName: null, name: "Lease" }, "lea"),
    ).toBe(true);
    expect(matchesMatterOption({ clientName: null, name: "Lease" }, "x")).toBe(
      false,
    );
  });
});
