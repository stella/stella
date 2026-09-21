import { describe, expect, test } from "bun:test";

import { windowJunction } from "@/api/handlers/legislation/version-windows";

describe("how adjacent consolidation windows meet", () => {
  test("edge to edge is contiguous", () => {
    expect(
      windowJunction(
        { validFrom: "2025-01-01", validTo: "2025-06-01" },
        { validFrom: "2025-06-01" },
      ),
    ).toEqual({ type: "contiguous" });
  });

  test("closing the day before the successor opens is an inclusive end date", () => {
    // eSbírka's `účinnost-znění-do` for the zákoník práce consolidation
    // that the flexinovela replaced: the last day in force, stored as if it
    // were the exclusive bound. 2025-05-31 then belongs to no version.
    expect(
      windowJunction(
        { validFrom: "2025-01-01", validTo: "2025-05-31" },
        { validFrom: "2025-06-01" },
      ),
    ).toEqual({ type: "inclusive-end" });
  });

  test("closing after the successor opens is an overlap", () => {
    expect(
      windowJunction(
        { validFrom: "2025-01-01", validTo: "2025-06-15" },
        { validFrom: "2025-06-01" },
      ),
    ).toEqual({ type: "overlap", days: 14 });
  });

  test("a wider gap is a version not yet ingested", () => {
    expect(
      windowJunction(
        { validFrom: "2024-01-01", validTo: "2024-08-01" },
        { validFrom: "2025-06-01" },
      ),
    ).toEqual({ type: "gap", days: 304 });
  });

  test("an open earlier window says nothing about the junction", () => {
    expect(
      windowJunction(
        { validFrom: "2025-01-01", validTo: null },
        { validFrom: "2025-06-01" },
      ),
    ).toEqual({ type: "open" });
  });
});
