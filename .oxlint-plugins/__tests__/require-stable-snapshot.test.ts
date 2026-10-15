import { describe, expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule";

describe("require-stable-snapshot", () => {
  test("reports newly allocated snapshot objects", async () => {
    expect(
      await lintSingleRule(
        "require-stable-snapshot",
        'import { useSyncExternalStore } from "react";\nuseSyncExternalStore(subscribe, () => ({ count: store.count }));',
      ),
    ).toEqual([2]);
  });
  test("reports fresh server snapshots through namespace imports", async () => {
    expect(
      await lintSingleRule(
        "require-stable-snapshot",
        'import * as React from "react";\nReact.useSyncExternalStore(subscribe, getSnapshot, () => store.items.map(select));',
      ),
    ).toEqual([2]);
  });
  test("accepts cached references", async () => {
    expect(
      await lintSingleRule(
        "require-stable-snapshot",
        'import { useSyncExternalStore as useStore } from "react";\nuseStore(subscribe, () => store.cached, getServerSnapshot);',
      ),
    ).toEqual([]);
  });
  test("accepts primitive and opaque getter snapshots", async () => {
    expect(
      await lintSingleRule(
        "require-stable-snapshot",
        'import { useSyncExternalStore } from "react";\nuseSyncExternalStore(subscribe, () => store.getValue(), () => 0);',
      ),
    ).toEqual([]);
  });
});
