import { describe, expect, test } from "bun:test";

import { leadInNamesCourt } from "@/components/references/citation-lead-in.logic";

const CZ_SUPREME = { court: "Nejvyšší soud", courtShortCode: "NS" };
const CZ_CONSTITUTIONAL = { court: "Ústavní soud", courtShortCode: "ÚS" };
const SK_SUPREME = {
  court: "Najvyšší súd Slovenskej republiky",
  courtShortCode: "NS",
};
const PL_SUPREME = { court: "Sąd Najwyższy", courtShortCode: "SN" };

describe("prose that names the cited court", () => {
  test("in any case of the name", () => {
    expect(leadInNamesCourt("Podle Nejvyššího soudu", CZ_SUPREME)).toBe(true);
    expect(leadInNamesCourt("Shodně s Nejvyšším soudem", CZ_SUPREME)).toBe(
      true,
    );
    expect(leadInNamesCourt("Ústavní soud v nálezu", CZ_CONSTITUTIONAL)).toBe(
      true,
    );
    expect(leadInNamesCourt("Podle Sądu Najwyższego", PL_SUPREME)).toBe(true);
  });

  test("by a longer official name's registry form", () => {
    expect(
      leadInNamesCourt("Rovnako rozhodol Najvyšší súd v uznesení", SK_SUPREME),
    ).toBe(true);
  });

  test("by its abbreviation, inside punctuation", () => {
    expect(
      leadInNamesCourt("Likewise the Supreme Court (NS) in", CZ_SUPREME),
    ).toBe(true);
    expect(leadInNamesCourt("Podle „Nejvyššího soudu“,", CZ_SUPREME)).toBe(
      true,
    );
  });
});

describe("prose that does not name the cited court", () => {
  test("an adjective that shares the name's stem", () => {
    expect(leadInNamesCourt("Nejvyšší soudní rada uvádí", CZ_SUPREME)).toBe(
      false,
    );
  });

  test("another jurisdiction's court under the same abbreviation", () => {
    expect(leadInNamesCourt("Ústavný súd v náleze", CZ_CONSTITUTIONAL)).toBe(
      false,
    );
  });

  test("a different court", () => {
    expect(leadInNamesCourt("Jinak než Ústavní soud rozhodl", CZ_SUPREME)).toBe(
      false,
    );
    expect(leadInNamesCourt("Podle rozsudku", CZ_SUPREME)).toBe(false);
  });
});
