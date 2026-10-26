import { describe, expect, test } from "bun:test";

import { parsePersistedSidebarOpen } from "@/components/sidebar/sidebar-state";

describe("persisted sidebar state", () => {
  test("maps persisted values and leaves unknown ones to the default", () => {
    expect(parsePersistedSidebarOpen(undefined)).toBeNull();
    expect(parsePersistedSidebarOpen(null)).toBeNull();
    expect(parsePersistedSidebarOpen("open")).toBeNull();
    expect(parsePersistedSidebarOpen("expanded")).toBe(true);
    expect(parsePersistedSidebarOpen("collapsed")).toBe(false);
  });
});
