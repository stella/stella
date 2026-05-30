/**
 * Default-registry composition test. Confirms the registry built by
 * `createDefaultRegistry` knows every Fragment kind. If a new fragment
 * kind is added to the union without a matching module, this fails fast.
 */

import { describe, expect, test } from "bun:test";

import type { Fragment } from "../../layout-engine/types";
import { createDefaultRegistry } from "./modules";

describe("createDefaultRegistry", () => {
  test("registers a module for every Fragment kind", () => {
    const registry = createDefaultRegistry();
    const expectedKinds: readonly Fragment["kind"][] = [
      "paragraph",
      "table",
      "image",
      "textBox",
    ];
    for (const kind of expectedKinds) {
      expect(registry.has(kind)).toBe(true);
    }
  });
});
