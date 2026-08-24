import { describe, expect, test } from "bun:test";

import { detectCitationCourtHint } from "@/api/handlers/case-law/citation-court-hint";

const hintFor = (sentence: string, number: string): string | null => {
  const index = sentence.indexOf(number);
  expect(index).toBeGreaterThan(0);
  return detectCitationCourtHint(sentence, index);
};

describe("detectCitationCourtHint", () => {
  test("keeps the court a regional judgment is cited with", () => {
    expect(
      hintFor(
        "(srov. rozsudek Krajského soudu v Českých Budějovicích ze dne 21. 5. 2025, č. j. 65 A 3/2025-226, body 99 a 100)",
        "65 A 3/2025",
      ),
    ).toBe("Krajského soudu v Českých Budějovicích");
  });

  test("keeps a supreme court cited without a date", () => {
    expect(
      hintFor(
        "usnesením Nejvyššího soudu sp. zn. 30 Cdo 292/2014, jímž",
        "30 Cdo 292/2014",
      ),
    ).toBe("Nejvyššího soudu");
    expect(
      hintFor(
        "nález Ústavního soudu ze dne 1. 2. 2019, sp. zn. II. ÚS 2766/14",
        "II. ÚS 2766/14",
      ),
    ).toBe("Ústavního soudu");
  });

  test("keeps a branch and a two-word seat", () => {
    expect(
      hintFor(
        "rozsudek Krajského soudu v Ústí nad Labem – pobočky v Liberci ze dne 11. 12. 2019, č. j. 59 A 5/2019-40",
        "59 A 5/2019",
      ),
    ).toBe("Krajského soudu v Ústí nad Labem – pobočky v Liberci");
    expect(
      hintFor(
        "rozsudku Nejvyššího správního soudu ze dne 26. 10. 2007, č. j. 4 As 10/2007-109",
        "4 As 10/2007",
      ),
    ).toBe("Nejvyššího správního soudu");
  });

  test("reads Slovak citing sentences", () => {
    expect(
      hintFor(
        "rozsudok Najvyššieho súdu Slovenskej republiky zo dňa 25. 3. 2015, sp. zn. 3 Cdo 12/2014",
        "3 Cdo 12/2014",
      ),
    ).toBe("Najvyššieho súdu Slovenskej republiky");
    expect(
      hintFor(
        "uznesenie Krajského súdu v Bratislave z 12. 1. 2020, sp. zn. 5 Co 100/2019",
        "5 Co 100/2019",
      ),
    ).toBe("Krajského súdu v Bratislave");
  });

  test("names no court when the sentence does not bind one to the number", () => {
    expect(
      hintFor(
        "viz body 12 až 15 rozsudku č. j. 9 A 20/2023-129",
        "9 A 20/2023",
      ),
    ).toBeNull();
    // An earlier court in the sentence introduced a different number.
    expect(
      hintFor(
        "rozsudek Krajského soudu v Brně ze dne 1. 1. 2020, č. j. 30 A 49/2024-110, potvrzený rozsudkem č. j. 2 As 29/2007-74",
        "2 As 29/2007",
      ),
    ).toBeNull();
    expect(hintFor("srov. sp. zn. 21 Cdo 5/2019", "21 Cdo 5/2019")).toBeNull();
  });
});
