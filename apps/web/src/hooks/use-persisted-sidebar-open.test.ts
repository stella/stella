import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { parsePersistedSidebarOpen } from "./use-persisted-sidebar-open";

describe("persisted sidebar state", () => {
  test("maps persisted values without changing the deterministic default", () => {
    expect(parsePersistedSidebarOpen(null)).toBeNull();
    expect(parsePersistedSidebarOpen("expanded")).toBe(true);
    expect(parsePersistedSidebarOpen("collapsed")).toBe(false);
  });

  test("uses a deterministic server snapshot and reconciles the external store", () => {
    const source = readFileSync(
      new URL("use-persisted-sidebar-open.ts", import.meta.url),
      "utf-8",
    );

    expect(source).toContain("useSyncExternalStore(");
    expect(source).toContain("() => defaultOpen,");
    expect(source).not.toContain("useMountEffect");
    expect(source).not.toContain("useLayoutEffect");
  });
});
