import { describe, expect, test } from "bun:test";

import { stripCitationPrefix } from "./citation-prefix.js";

describe("the bare case number behind a citation prefix", () => {
  test.each([
    ["sp. zn. 21 Cdo 1234/2020", "21 Cdo 1234/2020"],
    ["sp.zn.: 38Csp/281/2025", "38Csp/281/2025"],
    ["sp. zn 5Obdo/23/2016", "5Obdo/23/2016"],
    ["sen. zn. 29 NSČR 55/2013", "29 NSČR 55/2013"],
    ["č. j. 4 Tdo 1323/2020-906", "4 Tdo 1323/2020-906"],
    ["č.j. 5 As 123/2020", "5 As 123/2020"],
    ["čj. 5 As 123/2020", "5 As 123/2020"],
    ["č. k. 4 Obo 48/02", "4 Obo 48/02"],
    ["sygn. akt II CSK 123/20", "II CSK 123/20"],
    ["Sygn. akt: I FSK 1261/07", "I FSK 1261/07"],
  ])("%p reads as %p", (citationText, bare) => {
    expect(stripCitationPrefix(citationText)).toBe(bare);
  });

  test("keeps a number that carries no prefix", () => {
    expect(stripCitationPrefix("I. ÚS 1135/17")).toBe("I. ÚS 1135/17");
  });

  test("spans a line wrap inside the number", () => {
    expect(stripCitationPrefix("sp. zn. 21\nCdo 1234/2020")).toBe(
      "21\nCdo 1234/2020",
    );
  });
});
