import { describe, expect, test } from "bun:test";

import {
  coverageMatcher,
  stripCitePrefix,
} from "@/api/scripts/citation-probe-coverage";

describe("stripCitePrefix", () => {
  test("drops the case-number prefix and collapses whitespace", () => {
    expect(stripCitePrefix("sp. zn.  3 Cdo   41/2015")).toBe("3 cdo 41/2015");
  });

  test("folds a registry slash to the space spelling", () => {
    expect(stripCitePrefix("sp. zn. 7 C/12/2004")).toBe("7 c 12/2004");
    expect(stripCitePrefix("sp. zn. 21Co/90/2006")).toBe("21 co 90/2006");
  });

  test("leaves spellings without a registry slash unchanged", () => {
    expect(stripCitePrefix("sp. zn. 7 C 12/2004")).toBe("7 c 12/2004");
    expect(stripCitePrefix("I. ÚS 12/03")).toBe("i. ús 12/03");
  });
});

describe("coverageMatcher", () => {
  const covered = coverageMatcher([
    "sp. zn. 7 C 12/2004",
    "sp. zn. 21 Co 90/2006",
  ]);

  test("treats slash and space spellings of one docket as covered", () => {
    expect(covered("sp. zn. 7 C/12/2004")).toBe(true);
    expect(covered("sp. zn. 21 Co/90/2006")).toBe(true);
  });

  test("treats a slash spelling with a sheet suffix as covered", () => {
    expect(covered("sp. zn. 7 C/12/2004-101 zo dňa")).toBe(true);
  });

  test("does not cover a different docket", () => {
    expect(covered("sp. zn. 7 C/13/2004")).toBe(false);
    expect(covered("sp. zn. 8 Co/90/2006")).toBe(false);
  });
});
