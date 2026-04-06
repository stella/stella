import { describe, expect, test } from "bun:test";

import { buildFieldMarkers } from "@/api/mcp/field-markers";

describe("anonymizeTextFields", () => {
  test("regenerates markers when crafted content contains a candidate delimiter", async () => {
    const collidingMarker =
      "[[[__stella_mcp_anonymized_field_00000000-0000-4000-8000-000000000001_1__]]]";
    const uuidSequence = [
      "00000000-0000-4000-8000-000000000001",
      "00000000-0000-4000-8000-000000000002",
    ];
    let randomUUIDCallCount = 0;

    const markers = buildFieldMarkers({
      fieldCount: 2,
      fields: ["Title", `Body ${collidingMarker} tail`],
      randomUUID: () => {
        randomUUIDCallCount += 1;
        const next = uuidSequence.shift();
        if (next === undefined) {
          throw new Error("Expected another UUID");
        }

        return next;
      },
    });

    expect(randomUUIDCallCount).toBe(2);
    expect(markers).toEqual([
      "[[[__stella_mcp_anonymized_field_00000000-0000-4000-8000-000000000002_0__]]]",
      "[[[__stella_mcp_anonymized_field_00000000-0000-4000-8000-000000000002_1__]]]",
    ]);
  });
});
