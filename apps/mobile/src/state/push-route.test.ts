import { describe, expect, test } from "bun:test";

import { routeForPush } from "./push-route";

describe("where a tapped notification leads", () => {
  test("a mention in a document opens the document in its matter", () => {
    expect(
      routeForPush({
        entityId: "e1",
        entityType: "entity",
        kind: "mention",
        workspaceId: "w1",
      }),
    ).toEqual({
      params: { entityId: "e1", workspaceId: "w1" },
      pathname: "/matter/[workspaceId]/[entityId]",
    });
  });

  test("anything else in a matter opens the matter", () => {
    expect(
      routeForPush({
        entityId: "run-1",
        entityType: "flow_run",
        kind: "flow_run_awaiting_approval",
        workspaceId: "w1",
      }),
    ).toEqual({
      params: { workspaceId: "w1" },
      pathname: "/matter/[workspaceId]",
    });
  });

  test("a notification outside any matter, or one the app cannot read, opens the app", () => {
    expect(routeForPush({ kind: "announcement", workspaceId: null })).toBe("/");
    expect(routeForPush("garbage")).toBe("/");
    expect(routeForPush(undefined)).toBe("/");
  });
});
