import { describe, expect, test } from "bun:test";

import { CASE_LAW_BROWSE_MAX_PAGES } from "@stll/api-contract/case-law-browse-hubs";

import {
  type CaseLawBrowseTarget,
  createCaseLawBrowsePath,
} from "./browse-path";
import {
  caseLawBrowseDateRange,
  parseCaseLawBrowseSplat,
} from "./browse-path-parse";

const court = "nejvyssi-soud";

const hub = "/law/cze/courts/nejvyssi-soud";

const targets: [CaseLawBrowseTarget, `/law/${string}`][] = [
  [{ level: "court", court }, hub],
  [{ level: "year", court, year: 2023 }, `${hub}/2023`],
  [{ level: "month", court, year: 2023, month: 5, page: 1 }, `${hub}/2023/05`],
  [
    {
      level: "month",
      court,
      year: 2023,
      month: 12,
      page: CASE_LAW_BROWSE_MAX_PAGES,
    },
    `${hub}/2023/12/page/${String(CASE_LAW_BROWSE_MAX_PAGES)}`,
  ],
  [
    { level: "day", court, year: 2024, month: 2, day: 29, page: 1 },
    `${hub}/2024/02/29`,
  ],
  [
    { level: "day", court, year: 2023, month: 1, day: 9, page: 2 },
    `${hub}/2023/01/09/page/2`,
  ],
];

describe("case-law browse paths", () => {
  test.each(targets)(
    "round-trips %o through its one canonical path %s",
    (target, expected) => {
      const path = createCaseLawBrowsePath("cze", target);
      expect(path).toBe(expected);
      const splat = path.slice("/law/cze/courts/".length);
      expect(parseCaseLawBrowseSplat(splat)).toEqual(target);
    },
  );

  test.each([
    "Nejvyssi-Soud",
    `${court}/23`,
    `${court}/2023/5`,
    `${court}/2023/13`,
    `${court}/2023/05/page/1`,
    `${court}/2023/05/page/01`,
    `${court}/2023/05/page/${String(CASE_LAW_BROWSE_MAX_PAGES + 1)}`,
    `${court}/2023/05/page/9007199254740992`,
    `${court}/2023/02/29`,
    `${court}/2023/05/07/extra`,
    `${court}/undated`,
    `${court}/`,
    "",
  ])("refuses the non-canonical or impossible address %j", (splat) => {
    expect(parseCaseLawBrowseSplat(splat)).toBeNull();
  });

  test("a listing covers exactly its month or day", () => {
    expect(
      caseLawBrowseDateRange({
        level: "month",
        court,
        year: 2024,
        month: 2,
        page: 1,
      }),
    ).toEqual({ dateFrom: "2024-02-01", dateTo: "2024-02-29" });
    expect(
      caseLawBrowseDateRange({
        level: "day",
        court,
        year: 2023,
        month: 11,
        day: 3,
        page: 1,
      }),
    ).toEqual({ dateFrom: "2023-11-03", dateTo: "2023-11-03" });
  });
});
