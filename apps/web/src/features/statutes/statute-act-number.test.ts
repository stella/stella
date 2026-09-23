import { describe, expect, test } from "bun:test";

import { statuteActLabel } from "@/features/statutes/statute-act-number";

const numberOf = (eli: string) => statuteActLabel({ eli, title: "x" }).number;

describe("an act's number, read off its ELI", () => {
  test("a Czech act prints its collection", () => {
    expect(numberOf("https://www.e-sbirka.cz/eli/cz/sb/2012/89")).toBe(
      "89/2012 Sb.",
    );
  });

  test("a Slovak act prints the collection of its year", () => {
    expect(numberOf("https://www.slov-lex.sk/eli/sk/zz/1964/40")).toBe(
      "40/1964 Zb.",
    );
    expect(numberOf("https://www.slov-lex.sk/eli/sk/zz/2015/300")).toBe(
      "300/2015 Z. z.",
    );
  });

  test("a collection without a known abbreviation prints the bare number", () => {
    expect(numberOf("https://example.org/eli/cz/ul1/2004/12")).toBe("12/2004");
  });

  test("an ELI that names a version still names the act", () => {
    expect(
      numberOf("https://www.e-sbirka.cz/eli/cz/sb/2012/89/2024-01-01"),
    ).toBe("89/2012 Sb.");
  });

  test("an ELI with no act number has none", () => {
    expect(numberOf("CZ/2012/89")).toBeNull();
  });
});

describe("an act's name", () => {
  const CZ = "https://www.e-sbirka.cz/eli/cz/sb/2012/89";

  test("drops the number a Czech title opens with", () => {
    expect(
      statuteActLabel({ eli: CZ, title: "89/2012 Sb., občanský zákoník" }).name,
    ).toBe("občanský zákoník");
  });

  test("keeps a title that carries no number", () => {
    expect(
      statuteActLabel({
        eli: "https://www.slov-lex.sk/eli/sk/zz/1964/40",
        title: "Občiansky zákonník",
      }).name,
    ).toBe("Občiansky zákonník");
  });

  test("keeps a number the title quotes later on", () => {
    expect(
      statuteActLabel({
        eli: "https://www.e-sbirka.cz/eli/cz/sb/2022/459",
        title:
          "459/2022 Sb., kterým se mění zákon č. 276/2003 Sb., o Antarktidě",
      }).name,
    ).toBe("kterým se mění zákon č. 276/2003 Sb., o Antarktidě");
  });

  test("is left out where the title is only the number", () => {
    expect(
      statuteActLabel({
        eli: "https://www.e-sbirka.cz/eli/cz/sbms/2012/89",
        title: "89/2012 Sb. m. s.",
      }),
    ).toEqual({ number: "89/2012 Sb. m. s.", name: null });
  });
});
