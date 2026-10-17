import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as v from "valibot";

import { deviceStorage } from "@/lib/account/browser-storage";
import {
  definePersistedState,
  keepInAnyScope,
} from "@/lib/persisted-state/registry";

import { readPersistedSidebarOpen } from "./use-persisted-sidebar-open";

const sidebarTestEntry = definePersistedState({
  key: "sidebar_state",
  area: "local",
  version: 1,
  schema: v.nullable(v.boolean()),
  maxBytes: 128,
  defaultValue: () => null,
  scopeCheck: keepInAnyScope,
  restoredUi: true,
});

describe("persisted sidebar state", () => {
  test("falls back when the stored sidebar state is malformed", () => {
    deviceStorage("local").setItem("sidebar_state", "not-json");
    expect(readPersistedSidebarOpen(sidebarTestEntry, {})).toBeNull();
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
