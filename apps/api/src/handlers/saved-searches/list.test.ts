import { describe, expect, test } from "bun:test";

import { createSafeId } from "@/api/lib/branded-types";

import { savedSearchCursor } from "./list";

describe("saved search list cursor", () => {
  test("carries the full ordering tuple", () => {
    const id = createSafeId<"savedSearch">();
    const encoded = savedSearchCursor.encode("2026-07-29T10:11:12.123456", id);

    expect(savedSearchCursor.decode(encoded)).toEqual({
      timestamp: {
        type: "pgTimestampCursor",
        value: "2026-07-29T10:11:12.123456",
        precision: "microseconds",
      },
      id,
    });
  });

  test("rejects a cursor that omits the timestamp boundary", () => {
    expect(savedSearchCursor.decode("WyJhYmNkIl0")).toBeNull();
  });
});
