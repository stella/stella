import { describe, expect, test } from "bun:test";

import {
  resolveEntityActivityDestination,
  resolveSidebarWorkspaceId,
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
