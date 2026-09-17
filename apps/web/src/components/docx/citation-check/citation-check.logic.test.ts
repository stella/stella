import { describe, expect, test } from "bun:test";

import { CITATION_RELATION_READINGS } from "@stll/api-contract/citation-check";

import {
  CITATION_RELATION_DISPLAY,
  findDecisionReference,
} from "@/components/docx/citation-check/citation-check.logic";

describe("finding a decision reference in a selected sentence", () => {
  test("finds the reference a Czech sentence prints, prefix and all", () => {
    for (const [sentence, expected] of [
      [
        "Nejvyšší soud v rozsudku sp. zn. 21 Cdo 1234/2020 dovodil opak.",
        "21 Cdo 1234/2020",
      ],
      [
        "Srov. rozsudek NSS č. j. 8 Afs 75/2005-130, podle kterého lhůta běží.",
        "8 Afs 75/2005-130",
      ],
      ["Viz nález sp. zn. Pl. ÚS 27/09.", "Pl. ÚS 27/09"],
      ["(sp. zn. I. ÚS 1234/20)", "I. ÚS 1234/20"],
    ] as const) {
      expect(findDecisionReference(sentence)).toBe(expected);
    }
  });

  test("finds a reference an English sentence cites a Czech decision by", () => {
    expect(
      findDecisionReference(
        "The Supreme Court held in 30 Cdo 3130/2021 that the limitation period runs from discovery.",
      ),
    ).toBe("30 Cdo 3130/2021");
  });

  test("finds an ECLI", () => {
    expect(
      findDecisionReference(
        "See ECLI:CZ:NS:2020:21.CDO.1234.2020.1 for the reasoning.",
      ),
    ).toBe("ECLI:CZ:NS:2020:21.CDO.1234.2020.1");
  });

  test("takes the whole reference, not the docket hiding inside it", () => {
    // `Cdo 1234/2020` is itself a well-formed docket, so a scan that stopped
    // at the first thing the grammar accepts would drop the senate number and
    // resolve a different case.
    expect(findDecisionReference("podle 21 Cdo 1234/2020 platí, že ...")).toBe(
      "21 Cdo 1234/2020",
    );
  });

  test("does not offer the action on a statute number", () => {
    // `č. 89/2012` parses as a docket, and a Czech pleading names statutes on
    // every second line. A one-letter register mark is the structural tell.
    expect(
      findDecisionReference(
        "podle § 2894 zákona č. 89/2012 Sb., občanský zákoník",
      ),
    ).toBeNull();
  });

  test("finds nothing in a sentence that cites nothing", () => {
    expect(
      findDecisionReference("The parties agreed to arbitrate."),
    ).toBeNull();
    expect(findDecisionReference("")).toBeNull();
  });
});

describe("how an answer reads", () => {
  test("every relation the endpoint can answer with has a reading", () => {
    expect(Object.keys(CITATION_RELATION_DISPLAY).toSorted()).toEqual(
      [...CITATION_RELATION_READINGS].toSorted(),
    );
  });

  test("supporting is green and contradicting is red", () => {
    expect(CITATION_RELATION_DISPLAY.supports.tone).toBe("success");
    expect(CITATION_RELATION_DISPLAY.contradicts.tone).toBe("destructive");
  });
});
