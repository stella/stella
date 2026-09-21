import { describe, expect, test } from "bun:test";

import {
  defectiveJunctions,
  storedWindow,
  windowJunction,
} from "@/api/handlers/legislation/version-windows";

describe("the publisher's window in the corpus's terms", () => {
  test("an unversioned work has no window", () => {
    expect(storedWindow({ type: "unversioned" })).toEqual({
      versionValidFrom: null,
      versionValidTo: null,
    });
  });

  test("an open window has no close", () => {
    expect(
      storedWindow({
        type: "consolidation",
        validFrom: "2027-01-01",
        end: { type: "open" },
      }),
    ).toEqual({ versionValidFrom: "2027-01-01", versionValidTo: null });
  });

  test("an exclusive close is stored as given", () => {
    expect(
      storedWindow({
        type: "consolidation",
        validFrom: "2025-06-01",
        end: { type: "exclusive", on: "2026-01-01" },
      }),
    ).toEqual({ versionValidFrom: "2025-06-01", versionValidTo: "2026-01-01" });
  });

  test("a last day in force is stored as the day after, across a month and a year", () => {
    expect(
      storedWindow({
        type: "consolidation",
        validFrom: "2025-01-01",
        end: { type: "last-day-in-force", on: "2025-05-31" },
      }),
    ).toEqual({ versionValidFrom: "2025-01-01", versionValidTo: "2025-06-01" });
    expect(
      storedWindow({
        type: "consolidation",
        validFrom: "2025-06-01",
        end: { type: "last-day-in-force", on: "2025-12-31" },
      }),
    ).toEqual({ versionValidFrom: "2025-06-01", versionValidTo: "2026-01-01" });
  });

  test("a window that closes on or before it opens is refused", () => {
    // Exclusive close on the opening day: an empty window. A last day in
    // force the day before the opening: a reversed one. Neither holds a
    // day, and neither is something the junction check could see.
    expect(() =>
      storedWindow({
        type: "consolidation",
        validFrom: "2025-06-01",
        end: { type: "exclusive", on: "2025-06-01" },
      }),
    ).toThrow("closes on or before it opens");
    expect(() =>
      storedWindow({
        type: "consolidation",
        validFrom: "2025-06-01",
        end: { type: "last-day-in-force", on: "2025-05-30" },
      }),
    ).toThrow("closes on or before it opens");
    // The last day in force ON the opening day is a one-day window, which
    // is real: an act in force for a single day.
    expect(
      storedWindow({
        type: "consolidation",
        validFrom: "2025-06-01",
        end: { type: "last-day-in-force", on: "2025-06-01" },
      }),
    ).toEqual({ versionValidFrom: "2025-06-01", versionValidTo: "2025-06-02" });
  });

  test("every declared date is read strictly, not only the shifted one", () => {
    expect(() =>
      storedWindow({
        type: "consolidation",
        validFrom: "1.6.2025",
        end: { type: "open" },
      }),
    ).toThrow("not an ISO calendar day");
    expect(() =>
      storedWindow({
        type: "consolidation",
        validFrom: "2025-06-01",
        end: { type: "exclusive", on: "2026-01-01T00:00:00Z" },
      }),
    ).toThrow("not an ISO calendar day");
  });

  test("a publisher's inclusive history becomes contiguous windows", () => {
    // The zákoník práce capture around the flexinovela, as eSbírka states it.
    const lastDays = [
      ["2024-08-01", "2024-12-31"],
      ["2025-01-01", "2025-05-31"],
      ["2025-06-01", "2025-12-31"],
      ["2026-01-01", null],
    ] as const;
    const windows = lastDays.map(([validFrom, on]) => {
      const stored = storedWindow({
        type: "consolidation",
        validFrom,
        end: on === null ? { type: "open" } : { type: "last-day-in-force", on },
      });
      return {
        validFrom: stored.versionValidFrom ?? "",
        validTo: stored.versionValidTo,
      };
    });
    expect(defectiveJunctions(windows)).toEqual([]);
    expect(
      defectiveJunctions(
        lastDays.map(([validFrom, validTo]) => ({ validFrom, validTo })),
      ).map(({ junction }) => junction),
    ).toEqual([
      { type: "inclusive-end" },
      { type: "inclusive-end" },
      { type: "inclusive-end" },
    ]);
  });
});

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
