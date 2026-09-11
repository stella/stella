import { describe, expect, test } from "bun:test";

import { caseLawSectionHeading } from "./case-law-heading";

describe("case-law section heading", () => {
  test("classifies Roman sections and lettered subsections", () => {
    expect(caseLawSectionHeading("VIII. Vlastní přezkum")).toEqual({
      level: 3,
    });
    expect(caseLawSectionHeading("VIII. A) Tzv. data retention")).toEqual({
      level: 4,
    });
  });

  test("leaves prose and implausibly long labels as paragraphs", () => {
    expect(caseLawSectionHeading("Text odůvodnění.")).toBeNull();
    expect(
      caseLawSectionHeading(`I. ${"Velmi dlouhý název ".repeat(20)}`),
    ).toBeNull();
  });
});
