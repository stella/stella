import { describe, expect, test } from "bun:test";

import { PUBLIC_LEGISLATION_PAGE_COUNTRIES } from "./legislation-publication";
import { MAGYAR_KOZLONY_WORK_URN_PREFIX } from "./magyar-kozlony-designation";
import {
  STATUTE_ELI_PUBLISHER_ORIGINS,
  STATUTE_WORK_IDENTIFIERS,
  STATUTE_WORK_URN_PREFIXES,
} from "./statute-work-identifier";

describe("statute work identifiers", () => {
  test.each(PUBLIC_LEGISLATION_PAGE_COUNTRIES)(
    "%s, whose statutes are public, declares how its Works are named",
    (country) => {
      expect(STATUTE_WORK_IDENTIFIERS[country].type).not.toBe("undeclared");
    },
  );

  test("ELI publishers and URN prefixes are read off the one table", () => {
    expect(STATUTE_ELI_PUBLISHER_ORIGINS).toEqual({
      cz: "https://www.e-sbirka.cz",
      sk: "https://www.slov-lex.sk",
    });
    expect(STATUTE_WORK_URN_PREFIXES).toEqual([MAGYAR_KOZLONY_WORK_URN_PREFIX]);
  });
});
