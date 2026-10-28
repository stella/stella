import { describe, expect, test } from "bun:test";

import {
  isMatterInStatusView,
  matterCardDragMode,
  matterRouteView,
} from "./archived-matters.logic";

describe("matter status views", () => {
  test("each recoverable status appears only in its own list", () => {
    expect(isMatterInStatusView("active", "active")).toBe(true);
    expect(isMatterInStatusView("active", "archived")).toBe(false);
    expect(isMatterInStatusView("archived", "active")).toBe(false);
    expect(isMatterInStatusView("archived", "archived")).toBe(true);
    expect(isMatterInStatusView("deleting", "active")).toBe(false);
    expect(isMatterInStatusView("deleting", "archived")).toBe(false);
  });

  test("only active matters can be dragged between clients", () => {
    expect(matterCardDragMode("active", true)).toBe("client-group");
    expect(matterCardDragMode("archived", true)).toBe("none");
    expect(matterCardDragMode("active", false)).toBe("none");
  });

  test("archived matter URLs resolve to a read-only view", () => {
    expect(matterRouteView("archived")).toBe("archived-read-only");
    expect(matterRouteView("active")).toBe("active");
    expect(matterRouteView("deleting")).toBe("unavailable");
  });
});
