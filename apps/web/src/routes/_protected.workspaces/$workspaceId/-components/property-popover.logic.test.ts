import { describe, expect, test } from "bun:test";

import { getEntityIdsOrderFromRows } from "./property-popover.logic";

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
