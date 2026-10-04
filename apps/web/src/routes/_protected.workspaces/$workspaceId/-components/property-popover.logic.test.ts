import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { isFileProperty } from "@stll/api-contract/property-policy";
import { assertProperty } from "@stll/property-testing";

import {
  canEditPropertyViaComposer,
  getEntityIdsOrderFromRows,
} from "./property-popover.logic";

test("property composer classification follows the shared file policy", () => {
  assertProperty(
    "property composer classification follows the shared file policy",
    fc.property(fc.oneof(fc.constant("file"), fc.string()), (type) => {
      const content = { type };
      expect(isFileProperty(content)).toBe(type === "file");
      expect(canEditPropertyViaComposer(content, false)).toBe(
        !isFileProperty(content),
      );
      expect(canEditPropertyViaComposer(content, true)).toBe(false);
    }),
  );
});

describe("property popover workflow ordering", () => {
  test("reads entity order only from the active table rows", () => {
    const order = getEntityIdsOrderFromRows([
      { original: { entityId: "visible-1" } },
      { original: { entityId: "visible-2" } },
    ]);

    expect(order).toEqual(["visible-1", "visible-2"]);
  });

  test("deduplicates active rows without reading unrelated caches", () => {
    const order = getEntityIdsOrderFromRows([
      { original: { entityId: "visible-1" } },
      { original: { entityId: "visible-1" } },
      { original: { entityId: "visible-2" } },
    ]);

    expect(order).toEqual(["visible-1", "visible-2"]);
  });
});
