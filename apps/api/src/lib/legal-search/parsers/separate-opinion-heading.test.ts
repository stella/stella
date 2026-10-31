import { describe, expect, test } from "bun:test";

import { separateOpinionHeading } from "./separate-opinion-heading";

const NSS_HEADING =
  "Odlišné stanovisko soudce Petra Mikeše dle § 55a soudního řádu správního k rozhodnutí rozšířeného senátu ze dne 30. 6. 2021 ve věci sp. zn. 9 As 264/2020";

describe("separate-opinion headings", () => {
  test.each([
    ["Odlišné stanovisko", ""],
    ["Odlišné stanovisko:", ":"],
    ["Odlišné stanovisko soudce Jana Musila", " soudce Jana Musila"],
    ["Odlišná stanoviska k nálezu pléna", " k nálezu pléna"],
    ["STANOVISKO", ""],
  ])("reads %j as a heading", (line, tail) => {
    expect(separateOpinionHeading(line, 120)?.tail).toBe(tail);
  });

  test("leaves a sentence of the opinion in the text", () => {
    expect(
      separateOpinionHeading("Odlišné stanovisko odůvodňuji takto:", 120)?.tail,
    ).toBeUndefined();
  });

  test("is bounded by the length the court's headings run to", () => {
    expect(separateOpinionHeading(NSS_HEADING, 120)?.tail).toBeUndefined();
    expect(separateOpinionHeading(NSS_HEADING, 300)?.tail).toMatch(/^ soudce/u);
  });
});

test.each([
  "Odlišné stanovisko k této otázce uplatnili dva soudci",
  "Odlišné stanovisko uplatnili dva soudci",
])("prose does not acquire heading structure: %s", (line) => {
  expect(separateOpinionHeading(line, 300)?.tail).toBeUndefined();
});
