import { describe, expect, test } from "bun:test";

import {
  isMatterInStatusView,
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

  test("archived matter URLs resolve to a read-only view", () => {
    expect(matterRouteView("archived")).toBe("archived-read-only");
    expect(matterRouteView("active")).toBe("active");
    expect(matterRouteView("deleting")).toBe("unavailable");
  });
});
