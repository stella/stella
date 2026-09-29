import { describe, expect, test } from "bun:test";

import type {
  LegislationExpressionKind,
  LegislationWindowDisposition,
} from "@stll/api-contract/legislation-expression";

import {
  pickVersionAt,
  versionCoversDate,
} from "@/features/case-law/statute-version";

const version = (
  versionValidFrom: string | null,
  versionValidTo: string | null,
  {
    expressionKind = "consolidation",
    windowDisposition = "effective",
  }: {
    expressionKind?: LegislationExpressionKind;
    windowDisposition?: LegislationWindowDisposition;
  } = {},
) => ({
  expressionKind,
  versionValidFrom,
  versionValidTo,
  windowDisposition,
});

describe("versionCoversDate", () => {
  test("the window opens on its own start date", () => {
    expect(
      versionCoversDate(version("2014-01-01", "2016-01-01"), "2014-01-01"),
    ).toBe(true);
  });

  test("the window closes before its end date, not on it", () => {
    // Half-open: the successor opening on 2016-01-01 is the version in force
    // that day, so the predecessor must not also claim it.
    expect(
      versionCoversDate(version("2014-01-01", "2016-01-01"), "2016-01-01"),
    ).toBe(false);
    expect(
      versionCoversDate(version("2014-01-01", "2016-01-01"), "2015-12-31"),
    ).toBe(true);
  });

  test("a version still in force has no end", () => {
    expect(versionCoversDate(version("2014-01-01", null), "2030-06-01")).toBe(
      true,
    );
  });

  test("a work kept as one unversioned text covers every date", () => {
    expect(versionCoversDate(version(null, null), "1999-01-01")).toBe(true);
  });

  test("a version that cannot apply covers no date, whatever its dates", () => {
    // A null start would otherwise read as an unversioned text covering
    // every date: the disposition, not the dates, decides.
    for (const windowDisposition of [
      "never-in-force",
      "invalid-window",
      "withdrawn",
    ] as const) {
      expect(
        versionCoversDate(
          version(null, null, { windowDisposition }),
          "2015-06-01",
        ),
      ).toBe(false);
      expect(
        versionCoversDate(
          version("2014-01-01", null, { windowDisposition }),
          "2015-06-01",
        ),
      ).toBe(false);
    }
    expect(
      versionCoversDate(
        version("2014-01-01", null, { expressionKind: "promulgated" }),
        "2015-06-01",
      ),
    ).toBe(false);
  });

  test("a date before the window is not covered", () => {
    expect(versionCoversDate(version("2014-01-01", null), "2013-12-31")).toBe(
      false,
    );
  });
});

describe("pickVersionAt", () => {
  // Newest first, the order the versions read returns.
  const current = version("2016-01-01", null);
  const middle = version("2014-01-01", "2016-01-01");
  const oldest = version("2012-03-22", "2014-01-01");
  const versions = [current, middle, oldest];

  test("takes the consolidation in force on the day, not the current one", () => {
    expect(pickVersionAt(versions, "2015-06-01")).toBe(middle);
    // The current version is a different object, so the assertion above is
    // about the match rather than about there being one version.
    expect(pickVersionAt(versions, "2020-06-01")).toBe(current);
    expect(pickVersionAt(versions, "2013-06-01")).toBe(oldest);
  });

  test("skips a newer version that cannot apply for the eligible one", () => {
    const reversed = version("2017-01-01", "2016-12-31", {
      windowDisposition: "invalid-window",
    });
    const neverInForce = version(null, null, {
      windowDisposition: "never-in-force",
    });
    expect(
      pickVersionAt([neverInForce, reversed, middle, oldest], "2015-06-01"),
    ).toBe(middle);
    expect(pickVersionAt([neverInForce, reversed], "2018-06-01")).toBeNull();
  });

  test("answers nothing for a date the corpus holds no version for", () => {
    expect(pickVersionAt(versions, "2000-01-01")).toBeNull();
  });

  test("answers nothing when the corpus holds no versions at all", () => {
    expect(pickVersionAt([], "2015-06-01")).toBeNull();
  });
});
