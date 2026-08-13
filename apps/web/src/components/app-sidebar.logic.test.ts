import { describe, expect, test } from "bun:test";

import {
  matterActivityIsKnownEmpty,
  resolveEntityActivityDestination,
  resolveAutomaticExpandedMatterId,
  resolveMatterNavigationTarget,
  resolveSidebarWorkspaceId,
  selectRecentWorkspaces,
} from "@/components/app-sidebar.logic";

describe("sidebar matter context", () => {
  test("opens a matter at its default view without an intermediate redirect", () => {
    expect(
      resolveMatterNavigationTarget({
        defaultViewId: "view-1",
        id: "matter-1",
      }),
    ).toEqual({
      params: { viewId: "view-1", workspaceId: "matter-1" },
      to: "/workspaces/$workspaceId/$viewId",
    });
  });

  test("keeps the bare matter route as the no-view fallback", () => {
    expect(
      resolveMatterNavigationTarget({
        defaultViewId: null,
        id: "matter-1",
      }),
    ).toEqual({
      params: { workspaceId: "matter-1" },
      to: "/workspaces/$workspaceId",
    });
    expect(resolveMatterNavigationTarget({ id: "matter-1" })).toEqual({
      params: { workspaceId: "matter-1" },
      to: "/workspaces/$workspaceId",
    });
  });

  test("uses the matter from a workspace chat route", () => {
    expect(
      resolveSidebarWorkspaceId({
        chatWorkspaceId: "chat-matter",
        workspaceId: undefined,
      }),
    ).toBe("chat-matter");
  });

  test("prefers the active workspace route when both sources exist", () => {
    expect(
      resolveSidebarWorkspaceId({
        chatWorkspaceId: "chat-matter",
        workspaceId: "workspace-matter",
      }),
    ).toBe("workspace-matter");
  });

  test("surfaces an active below-window matter at the bottom without reordering the rest", () => {
    const workspaces = Array.from({ length: 6 }, (_, index) => ({
      id: `matter-${index}`,
      lastActivityAt: `2026-07-0${6 - index}T12:00:00.000Z`,
    }));

    // matter-5 is the OLDEST (ranks below the 5-row window). Selecting it must
    // NOT yank it to the top; the activity-sorted rows above stay put and the
    // active matter is appended last so it remains reachable.
    expect(
      selectRecentWorkspaces({
        activeWorkspaceId: "matter-5",
        chatActivityByWorkspaceId: new Map(),
        limit: 5,
        pinnedIds: new Set(),
        workspaces,
      }).map(({ id }) => id),
    ).toEqual(["matter-0", "matter-1", "matter-2", "matter-3", "matter-5"]);
  });

  test("returns nothing for a non-positive limit even with an active matter", () => {
    expect(
      selectRecentWorkspaces({
        activeWorkspaceId: "matter-0",
        chatActivityByWorkspaceId: new Map(),
        limit: 0,
        pinnedIds: new Set(),
        workspaces: [
          { id: "matter-0", lastActivityAt: "2026-07-06T12:00:00.000Z" },
        ],
      }),
    ).toEqual([]);
  });

  test("does not reorder when the active matter is already within the window", () => {
    const workspaces = Array.from({ length: 6 }, (_, index) => ({
      id: `matter-${index}`,
      lastActivityAt: `2026-07-0${6 - index}T12:00:00.000Z`,
    }));

    // matter-1 already sits at its activity-ranked slot; selecting it changes
    // nothing (no push-to-top).
    expect(
      selectRecentWorkspaces({
        activeWorkspaceId: "matter-1",
        chatActivityByWorkspaceId: new Map(),
        limit: 5,
        pinnedIds: new Set(),
        workspaces,
      }).map(({ id }) => id),
    ).toEqual(["matter-0", "matter-1", "matter-2", "matter-3", "matter-4"]);
  });

  test("does not duplicate an active matter that is already pinned", () => {
    expect(
      selectRecentWorkspaces({
        activeWorkspaceId: "active",
        chatActivityByWorkspaceId: new Map(),
        limit: 5,
        pinnedIds: new Set(["active"]),
        workspaces: [
          { id: "active", lastActivityAt: "2026-07-06T12:00:00.000Z" },
          { id: "recent", lastActivityAt: "2026-07-05T12:00:00.000Z" },
        ],
      }).map(({ id }) => id),
    ).toEqual(["recent"]);
  });

  test("includes matters with recently active workspace chats", () => {
    const workspaces = Array.from({ length: 6 }, (_, index) => ({
      id: `matter-${index}`,
      lastActivityAt: `2026-07-0${6 - index}T12:00:00.000Z`,
    }));

    expect(
      selectRecentWorkspaces({
        activeWorkspaceId: undefined,
        chatActivityByWorkspaceId: new Map([
          ["matter-5", "2026-07-07T12:00:00.000Z"],
        ]),
        limit: 5,
        pinnedIds: new Set(),
        workspaces,
      }).map(({ id }) => id),
    ).toEqual(["matter-5", "matter-0", "matter-1", "matter-2", "matter-3"]);
  });

  test("does not expand an unrelated matter outside matter routes", () => {
    expect(
      resolveAutomaticExpandedMatterId({
        activeMatterIsVisible: false,
        activeWorkspaceId: undefined,
      }),
    ).toBeNull();
  });
});

describe("sidebar matter activity disclosure", () => {
  const knownEmptyInput = (
    pages: { items: readonly unknown[]; nextCursor: string | null }[],
  ) => ({ isInvalidated: false, pages, status: "success" as const });

  test("keeps the disclosure while the activity result is unknown", () => {
    // Never fetched, still loading, or failed: none of these prove the matter
    // is empty, so the toggle stays rather than flickering out under the
    // pointer.
    expect(
      matterActivityIsKnownEmpty({
        isInvalidated: false,
        pages: undefined,
        status: "pending",
      }),
    ).toBe(false);
    expect(
      matterActivityIsKnownEmpty({
        isInvalidated: false,
        pages: [{ items: [], nextCursor: null }],
        status: "error",
      }),
    ).toBe(false);
    expect(matterActivityIsKnownEmpty(knownEmptyInput([]))).toBe(false);
  });

  test("keeps the disclosure once the cached result is invalidated", () => {
    // The sidebar's observer is disabled, so an invalidated empty result is
    // never refetched: a matter that just gained activity would keep a hidden
    // toggle forever.
    expect(
      matterActivityIsKnownEmpty({
        isInvalidated: true,
        pages: [{ items: [], nextCursor: null }],
        status: "success",
      }),
    ).toBe(false);
  });

  test("keeps the disclosure when any page carries an item", () => {
    expect(
      matterActivityIsKnownEmpty(
        knownEmptyInput([
          { items: [], nextCursor: "cursor" },
          { items: [{ id: "a" }], nextCursor: null },
        ]),
      ),
    ).toBe(false);
  });

  test("keeps the disclosure while a continuation cursor remains", () => {
    // An empty page that can still be followed by one holding activity: hiding
    // the toggle here would strand the user with no way to load that page.
    expect(
      matterActivityIsKnownEmpty(
        knownEmptyInput([{ items: [], nextCursor: "cursor" }]),
      ),
    ).toBe(false);
  });

  test("drops the disclosure once a drained result holds no item", () => {
    expect(
      matterActivityIsKnownEmpty(
        knownEmptyInput([{ items: [], nextCursor: null }]),
      ),
    ).toBe(true);
    expect(
      matterActivityIsKnownEmpty(
        knownEmptyInput([
          { items: [], nextCursor: "cursor" },
          { items: [], nextCursor: null },
        ]),
      ),
    ).toBe(true);
  });
});

describe("sidebar entity activity navigation", () => {
  test("routes non-file entity kinds to the all view", () => {
    expect(resolveEntityActivityDestination("message")).toEqual({
      type: "all-view",
    });
    expect(resolveEntityActivityDestination("link")).toEqual({
      type: "all-view",
    });
  });
});
