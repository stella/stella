import { describe, expect, test } from "bun:test";

import {
  isBenign,
  standaloneCandidate,
} from "@/api/scripts/citation-probe-candidates";

const residual = (match: string): boolean =>
  !isBenign(standaloneCandidate(match));

describe("citation probe candidates", () => {
  test("a regional-authority file number is benign", () => {
    expect(residual("č. j. KUAB 12345/2020")).toBe(false);
    expect(residual("č.j.: KUJCK 987/2019")).toBe(false);
  });

  test("a court docket followed by an authority number stays a residual", () => {
    const match = "sp. zn. 12 C 345/2020 č. j. KUAB 12345/2020";
    expect(standaloneCandidate(match)).toBe("sp. zn. 12 C 345/2020");
    expect(residual(match)).toBe(true);
    expect(isBenign(match)).toBe(false);
  });

  test("an authority number with a further segment is not benign", () => {
    expect(residual("č. j. KUAB 12345/2020/3")).toBe(true);
    expect(residual("č. j. KUAB 12345/2020-3")).toBe(true);
    expect(residual("č. j. KUAB 12345/2020 ze dne 1. 2. 2020")).toBe(false);
  });

  test("an application number with a continuing suffix is not benign", () => {
    expect(residual("sp. zn. 12345/01A")).toBe(true);
    expect(residual("sygn. akt 12345/01-2")).toBe(true);
    expect(residual("sygn. akt 12345/01 z dnia")).toBe(false);
  });

  test("a numeric application number is benign, a domestic docket is not", () => {
    expect(residual("sygn. akt 12345/01")).toBe(false);
    expect(residual("sp. zn. 12345/01")).toBe(false);
    expect(residual("sygn. akt I ACa 123/01")).toBe(true);
    expect(residual("sp. zn. 12345/2001")).toBe(true);
  });
});
