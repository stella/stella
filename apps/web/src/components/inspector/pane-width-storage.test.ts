import { describe, expect, test } from "bun:test";

import {
  INSPECTOR_PANE_SURFACES,
  inspectorPaneWidthStorageKey,
} from "@/components/inspector/pane-width-storage";

describe("inspectorPaneWidthStorageKey", () => {
  // Two surfaces sharing a key would make their docks overwrite each other's
  // width on every drag, which is the whole reason the key is parameterized.
  // Adding a surface without widening the key would fail here, not in a
  // reader's browser.
  test("gives every surface a key of its own", () => {
    const keys = INSPECTOR_PANE_SURFACES.map(inspectorPaneWidthStorageKey);

    expect(new Set(keys).size).toBe(INSPECTOR_PANE_SURFACES.length);
  });
});
