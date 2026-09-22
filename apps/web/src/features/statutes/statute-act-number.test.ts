import { describe, expect, test } from "bun:test";

import {
  statuteActName,
  statuteActNumber,
} from "@/features/statutes/statute-act-number";

describe("an act's number, read off its ELI", () => {
  test("a Czech act prints its collection", () => {
    expect(statuteActNumber("https://www.e-sbirka.cz/eli/cz/sb/2012/89")).toBe(
      "89/2012 Sb.",
    );
  });

  test("a Slovak act prints the collection of its year", () => {
    expect(statuteActNumber("https://www.slov-lex.sk/eli/sk/zz/1964/40")).toBe(
      "40/1964 Zb.",
    );
    expect(statuteActNumber("https://www.slov-lex.sk/eli/sk/zz/2015/300")).toBe(
      "300/2015 Z. z.",
    );
  });

  test("a collection without a known abbreviation prints the bare number", () => {
    expect(statuteActNumber("https://example.org/eli/cz/ul1/2004/12")).toBe(
      "12/2004",
    );
  });

  test("an ELI that names a version still names the act", () => {
    expect(
      statuteActNumber("https://www.e-sbirka.cz/eli/cz/sb/2012/89/2024-01-01"),
    ).toBe("89/2012 Sb.");
  });

  test("an ELI with no act number has none", () => {
    expect(statuteActNumber("CZ/2012/89")).toBeNull();
  });
});

describe("an act's name", () => {
  test("drops the number a Czech title opens with", () => {
    expect(statuteActName("89/2012 Sb., občanský zákoník")).toBe(
      "občanský zákoník",
    );
  });

  test("keeps a title that carries no number", () => {
    expect(statuteActName("Občiansky zákonník")).toBe("Občiansky zákonník");
  });

  test("keeps a number the title quotes later on", () => {
    expect(
      statuteActName(
        "459/2022 Sb., kterým se mění zákon č. 276/2003 Sb., o Antarktidě",
      ),
    ).toBe("kterým se mění zákon č. 276/2003 Sb., o Antarktidě");
  });
});
