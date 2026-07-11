import { describe, expect, test } from "bun:test";

import {
  resolveEntityActivityDestination,
  resolveAutomaticExpandedMatterId,
  resolveSidebarWorkspaceId,
  selectRecentWorkspaces,
} from "@/components/app-sidebar.logic";

describe("sidebar matter context", () => {
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

  test("keeps an active chat matter inside the fixed recent limit", () => {
    const workspaces = Array.from({ length: 6 }, (_, index) => ({
      id: `matter-${index}`,
      lastActivityAt: `2026-07-0${6 - index}T12:00:00.000Z`,
    }));

    expect(
      selectRecentWorkspaces({
        activeWorkspaceId: "matter-5",
        chatActivityByWorkspaceId: new Map(),
        limit: 5,
        pinnedIds: new Set(),
        workspaces,
      }).map(({ id }) => id),
    ).toEqual(["matter-5", "matter-0", "matter-1", "matter-2", "matter-3"]);
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

describe("sidebar entity activity navigation", () => {
  test("routes non-file entity kinds through the entity route", () => {
    expect(resolveEntityActivityDestination("message")).toEqual({
      type: "entity-route",
    });
    expect(resolveEntityActivityDestination("link")).toEqual({
      type: "entity-route",
    });
  });
});
