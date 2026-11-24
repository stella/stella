import { describe, expect, test } from "bun:test";

import { CITATION_RELATION_READINGS } from "@stll/api-contract/citation-check";

import {
  CITATION_RELATION_DISPLAY,
  citationCheckKey,
  decideAutomaticCitationCheck,
  findDecisionReference,
  sentenceContaining,
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

describe("the sentence a reference stands in", () => {
  test("sends the sentence that cites, not the paragraph around it", () => {
    const paragraph =
      "Žalobce namítá promlčení. Nejvyšší soud v rozsudku sp. zn. 21 Cdo 1234/2020 dovodil opak. Soud proto návrh zamítl.";
    expect(sentenceContaining(paragraph, "21 Cdo 1234/2020")).toBe(
      "Nejvyšší soud v rozsudku sp. zn. 21 Cdo 1234/2020 dovodil opak.",
    );
  });

  test("does not split a citation prefix off the reference it introduces", () => {
    // `sp. zn.` is a full stop a capital follows, exactly like a sentence
    // end; splitting there would send `Pl. ÚS 27/09.` as the whole claim and
    // the assertion being checked would never reach the endpoint.
    const paragraph =
      "Soud odkázal na nález sp. zn. Pl. ÚS 27/09. Další věta pokračuje.";
    expect(sentenceContaining(paragraph, "Pl. ÚS 27/09")).toBe(
      "Soud odkázal na nález sp. zn. Pl. ÚS 27/09.",
    );
  });

  test("keeps a case number whole when it ends the sentence", () => {
    const paragraph =
      "Na to navazuje rozsudek sp. zn. 20 Cdo 20/2026. Odvolací soud se s tím ztotožnil.";
    expect(sentenceContaining(paragraph, "20 Cdo 20/2026")).toBe(
      "Na to navazuje rozsudek sp. zn. 20 Cdo 20/2026.",
    );
  });

  test("does not split inside an ECLI", () => {
    const paragraph =
      "Srovnej ECLI:CZ:NS:2020:21.CDO.1234.2020.1 a navazující praxi.";
    expect(
      sentenceContaining(paragraph, "ECLI:CZ:NS:2020:21.CDO.1234.2020.1"),
    ).toBe(paragraph);
  });

  test("sends the whole paragraph when nothing in it ends a sentence", () => {
    const paragraph = "podle 21 Cdo 1234/2020 platí, že lhůta běží od zjištění";
    expect(sentenceContaining(paragraph, "21 Cdo 1234/2020")).toBe(paragraph);
  });

  test("sends the whole paragraph when the reference is not in it", () => {
    expect(sentenceContaining("  Text bez odkazu.  ", "21 Cdo 1234/2020")).toBe(
      "Text bez odkazu.",
    );
  });
});

describe("what makes a check the same check", () => {
  test("re-wrapping a line is not a new claim", () => {
    const claim = "Nejvyšší soud v rozsudku 21 Cdo 1234/2020 dovodil opak.";
    expect(
      citationCheckKey({
        citation: "21 Cdo 1234/2020",
        claim: `${claim.replace(" v rozsudku", "\n  v rozsudku")}  `,
      }),
    ).toBe(citationCheckKey({ citation: "21 Cdo 1234/2020", claim }));
  });

  test("the same sentence about another decision is another check", () => {
    const claim = "Soud dovodil opak.";
    expect(citationCheckKey({ citation: "21 Cdo 1234/2020", claim })).not.toBe(
      citationCheckKey({ citation: "30 Cdo 3130/2021", claim }),
    );
  });

  test("a rewritten sentence about the same decision is another check", () => {
    expect(
      citationCheckKey({
        citation: "21 Cdo 1234/2020",
        claim: "Soud dovodil opak.",
      }),
    ).not.toBe(
      citationCheckKey({
        citation: "21 Cdo 1234/2020",
        claim: "Soud dovodil totéž.",
      }),
    );
  });
});

describe("what a settled paragraph asks", () => {
  const CITING_PARAGRAPH =
    "Žalobce namítá promlčení. Nejvyšší soud v rozsudku sp. zn. 21 Cdo 1234/2020 dovodil opak.";

  test("asks about the sentence the reference stands in", () => {
    expect(
      decideAutomaticCitationCheck({
        checked: new Set(),
        paragraphText: CITING_PARAGRAPH,
      }),
    ).toEqual({
      type: "run",
      citation: "21 Cdo 1234/2020",
      claim: "Nejvyšší soud v rozsudku sp. zn. 21 Cdo 1234/2020 dovodil opak.",
      key: citationCheckKey({
        citation: "21 Cdo 1234/2020",
        claim:
          "Nejvyšší soud v rozsudku sp. zn. 21 Cdo 1234/2020 dovodil opak.",
      }),
    });
  });

  test("asks nothing about a paragraph that cites no decision", () => {
    expect(
      decideAutomaticCitationCheck({
        checked: new Set(),
        paragraphText: "Strany se dohodly na rozhodčím řízení.",
      }),
    ).toEqual({ type: "skip", reason: "no_reference" });
  });

  test("asks nothing twice about the same sentence", () => {
    const first = decideAutomaticCitationCheck({
      checked: new Set(),
      paragraphText: CITING_PARAGRAPH,
    });
    if (first.type !== "run") {
      throw new Error("the fixture must produce a check to repeat");
    }
    expect(
      decideAutomaticCitationCheck({
        checked: new Set([first.key]),
        paragraphText: CITING_PARAGRAPH,
      }),
    ).toEqual({ type: "skip", reason: "already_checked" });
  });

  test("an edit to another sentence of the paragraph asks nothing again", () => {
    const first = decideAutomaticCitationCheck({
      checked: new Set(),
      paragraphText: CITING_PARAGRAPH,
    });
    if (first.type !== "run") {
      throw new Error("the fixture must produce a check to repeat");
    }
    const edited = CITING_PARAGRAPH.replace(
      "Žalobce namítá promlčení.",
      "Žalobce v odvolání namítá promlčení nároku.",
    );
    expect(edited).not.toBe(CITING_PARAGRAPH);
    expect(
      decideAutomaticCitationCheck({
        checked: new Set([first.key]),
        paragraphText: edited,
      }),
    ).toEqual({ type: "skip", reason: "already_checked" });
  });

  test("an edit to the citing sentence asks again", () => {
    const first = decideAutomaticCitationCheck({
      checked: new Set(),
      paragraphText: CITING_PARAGRAPH,
    });
    if (first.type !== "run") {
      throw new Error("the fixture must produce a check to repeat");
    }
    const edited = CITING_PARAGRAPH.replace("dovodil opak", "dovodil totéž");
    const second = decideAutomaticCitationCheck({
      checked: new Set([first.key]),
      paragraphText: edited,
    });
    expect(second.type).toBe("run");
    expect(second).not.toEqual(first);
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
