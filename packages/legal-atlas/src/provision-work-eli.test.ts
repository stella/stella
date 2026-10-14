import { describe, expect, test } from "bun:test";

import { CZ_PROFILE } from "./cz-provision-citation-profile";
import { PROVISION_CITATION_GRAMMARS } from "./provision-citation-grammars";
import {
  provisionWorkEli,
  resolveProvisionCitation,
} from "./provision-citation-resolve";
import { SK_PROFILE } from "./sk-provision-citation-profile";

const TODAY = "2026-10-14";

const eliOf = (
  text: string,
  profile: typeof CZ_PROFILE | typeof SK_PROFILE,
) => {
  const resolved = resolveProvisionCitation({ text, profile, citedOn: TODAY });
  return resolved.status === "resolved"
    ? provisionWorkEli(profile, resolved.work)
    : resolved.status;
};

describe("the ELI a resolved work is stored under", () => {
  test("a Czech act maps to the gazette ELI the grammar reads", () => {
    expect(eliOf("§ 52 zákona č. 262/2006 Sb.", CZ_PROFILE)).toBe(
      PROVISION_CITATION_GRAMMARS.CZE.gazette.eli({
        number: "262",
        year: "2006",
      }),
    );
  });

  test("a Slovak act maps to its Slov-Lex ELI, the federal collection too", () => {
    expect(eliOf("§ 2 ods. 1 zákona č. 311/2001 Z. z.", SK_PROFILE)).toBe(
      "/eli/sk/zz/2001/311",
    );
    expect(eliOf("§ 415 zákona č. 40/1964 Zb.", SK_PROFILE)).toBe(
      "/eli/sk/zz/1964/40",
    );
  });

  test("a collection the corpus holds no statutes of has no ELI", () => {
    expect(
      provisionWorkEli(CZ_PROFILE, {
        number: 2016,
        year: 679,
        collection: "Ú. l.",
      }),
    ).toBeNull();
  });
});
