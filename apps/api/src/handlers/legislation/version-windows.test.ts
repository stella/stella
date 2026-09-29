import { describe, expect, test } from "bun:test";

import {
  defectiveJunctions,
  storedWindow,
  windowDisposition,
  windowJunction,
} from "@/api/handlers/legislation/version-windows";
import type { VersionWindow } from "@/api/lib/legal-search/legislation-ingestion-types";

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

describe("a window that cannot apply, stored as stated", () => {
  test("each basis stores the publisher's dates with its disposition", () => {
    const cases = [
      // Closed the day before it opened, because the next version opened
      // that day: an empty window, never in force.
      [
        {
          type: "never-in-force",
          validFrom: "2019-01-01",
          end: { type: "last-day-in-force", on: "2018-12-31" },
          basis: "replaced-same-day",
        },
        { versionValidFrom: "2019-01-01", versionValidTo: "2019-01-01" },
      ],
      // The publisher's own flag, on a version with no dates at all.
      [
        {
          type: "never-in-force",
          validFrom: null,
          end: { type: "open" },
          basis: "publisher-flag",
        },
        { versionValidFrom: null, versionValidTo: null },
      ],
      [
        {
          type: "invalid-window",
          validFrom: "2017-01-01",
          end: { type: "last-day-in-force", on: "2016-06-30" },
          basis: "reversed",
        },
        { versionValidFrom: "2017-01-01", versionValidTo: "2016-07-01" },
      ],
      [
        {
          type: "invalid-window",
          validFrom: "2022-01-01",
          end: { type: "exclusive", on: "2022-01-01" },
          basis: "zero-length-window",
        },
        { versionValidFrom: "2022-01-01", versionValidTo: "2022-01-01" },
      ],
      [
        {
          type: "invalid-window",
          validFrom: null,
          end: { type: "last-day-in-force", on: "2020-03-31" },
          basis: "missing-start",
        },
        { versionValidFrom: null, versionValidTo: "2020-04-01" },
      ],
    ] as const satisfies readonly (readonly [
      VersionWindow,
      ReturnType<typeof storedWindow>,
    ])[];

    for (const [version, stored] of cases) {
      expect(storedWindow(version)).toEqual(stored);
      expect(windowDisposition(version)).toEqual({
        windowDisposition: version.type,
        windowDispositionBasis: version.basis,
      });
    }
    expect(
      windowDisposition({
        type: "consolidation",
        validFrom: "2020-01-01",
        end: { type: "open" },
      }),
    ).toEqual({ windowDisposition: "effective", windowDispositionBasis: null });
  });

  test("a basis its dates contradict is refused", () => {
    const contradicted = [
      // A "reversed" window that holds a day.
      {
        type: "invalid-window",
        validFrom: "2017-01-01",
        end: { type: "exclusive", on: "2017-02-01" },
        basis: "reversed",
      },
      // A "zero-length" window that runs backwards.
      {
        type: "invalid-window",
        validFrom: "2017-01-01",
        end: { type: "exclusive", on: "2016-12-01" },
        basis: "zero-length-window",
      },
      // A "missing-start" window with a start.
      {
        type: "invalid-window",
        validFrom: "2017-01-01",
        end: { type: "open" },
        basis: "missing-start",
      },
      // A "reversed" window with nothing to reverse.
      {
        type: "invalid-window",
        validFrom: null,
        end: { type: "exclusive", on: "2016-12-01" },
        basis: "reversed",
      },
      // Replaced the same day, yet in force for a month.
      {
        type: "never-in-force",
        validFrom: "2019-01-01",
        end: { type: "last-day-in-force", on: "2019-01-31" },
        basis: "replaced-same-day",
      },
    ] as const satisfies readonly VersionWindow[];

    for (const version of contradicted) {
      expect(() => storedWindow(version)).toThrow("does not match its basis");
    }
  });

  test("a window that cannot apply is still read strictly", () => {
    expect(() =>
      storedWindow({
        type: "invalid-window",
        validFrom: "1.1.2017",
        end: { type: "open" },
        basis: "missing-start",
      }),
    ).toThrow("not an ISO calendar day");
    expect(() =>
      storedWindow({
        type: "never-in-force",
        validFrom: null,
        end: { type: "exclusive", on: "2017-01-01T00:00:00Z" },
        basis: "publisher-flag",
      }),
    ).toThrow("not an ISO calendar day");
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
