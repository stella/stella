import { expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import { createBlockAnchorAllocator } from "./block-anchors";

test("any preferred anchor sequence receives unique document anchors", () => {
  assertProperty(
    "any preferred anchor sequence receives unique document anchors",
    fc.property(
      fc.array(
        fc.oneof(
          fc.string(),
          fc.constantFrom("h-title", "h-title-2", "h-title-3", "p1"),
        ),
        { maxLength: 100 },
      ),
      (preferred) => {
        const allocate = createBlockAnchorAllocator();
        const anchors = preferred.map(allocate);
        expect(new Set(anchors).size).toBe(preferred.length);
      },
    ),
  );
});
