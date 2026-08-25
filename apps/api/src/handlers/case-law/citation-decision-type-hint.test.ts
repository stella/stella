import { describe, expect, test } from "bun:test";

import { DECISION_IDENTIFIER_TYPES } from "@stll/legal-ast/decision-identifier";

import {
  CITATION_DECISION_TYPE_HINT,
  CITATION_DECISION_TYPE_HINT_FAMILIES,
  CITATION_DECISION_TYPE_HINTS,
  detectCitationDecisionTypeHint,
} from "@/api/handlers/case-law/citation-decision-type-hint";
import { extractCitations } from "@/api/handlers/case-law/ingestion/citation-extractor";

const hintsOf = (text: string) =>
  Object.fromEntries(
    extractCitations([{ index: 0, text }]).map((citation) => [
      citation.citationText,
      citation.citedDecisionTypeHint,
    ]),
  );

describe("cited decision type hint", () => {
  test("the word right before the number binds, in any inflection", () => {
    expect(hintsOf("srov. nález sp. zn. II. ÚS 2766/14")).toEqual({
      "II. ÚS 2766/14": CITATION_DECISION_TYPE_HINT.MERITS,
    });
    expect(hintsOf("v usnesení sp. zn. II. ÚS 2766/14 soud")).toEqual({
      "II. ÚS 2766/14": CITATION_DECISION_TYPE_HINT.ORDER,
    });
    expect(hintsOf("podle rozsudku č. j. 5 As 123/2020")).toEqual({
      "č. j. 5 As 123/2020": CITATION_DECISION_TYPE_HINT.JUDGMENT,
    });
    expect(hintsOf("stanoviskem pléna sp. zn. Pl. ÚS-st. 45/16")).toEqual({
      "Pl. ÚS-st. 45/16": CITATION_DECISION_TYPE_HINT.OPINION,
    });
  });

  test("the court's name and a date may stand between word and number", () => {
    expect(
      hintsOf(
        "nález Ústavního soudu sp. zn. IV. ÚS 956/09 ze dne 22. 10. 2009",
      ),
    ).toEqual({
      "IV. ÚS 956/09": CITATION_DECISION_TYPE_HINT.MERITS,
    });
    expect(
      hintsOf(
        "proti usnesením Nejvyššího soudu ze dne 11. 6. 2014, č. j. 30 Cdo 292/2014-493",
      ),
    ).toEqual({
      "č. j. 30 Cdo 292/2014": CITATION_DECISION_TYPE_HINT.ORDER,
    });
  });

  test("Slovak forms map to the same families", () => {
    expect(
      hintsOf("uznesením Ústavného súdu SR sp. zn. II. ÚS 123/2019 zo dňa"),
    ).toEqual({
      "II. ÚS 123/2019": CITATION_DECISION_TYPE_HINT.ORDER,
    });
    expect(hintsOf("rozsudkom Najvyššieho súdu sp. zn. 3 Cdo 15/2018")).toEqual(
      { "sp. zn. 3 Cdo 15/2018": CITATION_DECISION_TYPE_HINT.JUDGMENT },
    );
  });

  test("a word that introduced an earlier number does not carry over", () => {
    // The nález introduces IV. ÚS 956/09; 30 Cdo 292/2014 is introduced by
    // nothing (the docket number in between breaks the bond), and the
    // second nález is the only word binding to III. ÚS 84/94.
    expect(
      hintsOf(
        "nález sp. zn. IV. ÚS 956/09 a rozhodnutí ve věci sp. zn. 30 Cdo 292/2014, jakož i nález sp. zn. III. ÚS 84/94",
      ),
    ).toEqual({
      "IV. ÚS 956/09": CITATION_DECISION_TYPE_HINT.MERITS,
      "sp. zn. 30 Cdo 292/2014": null,
      "III. ÚS 84/94": CITATION_DECISION_TYPE_HINT.MERITS,
    });
  });

  test("no word, no hint; an unrelated clause does not bind", () => {
    expect(hintsOf("viz též sp. zn. II. ÚS 2766/14")).toEqual({
      "II. ÚS 2766/14": null,
    });
    expect(
      hintsOf(
        "rozsudek byl doručen stěžovateli, který jej napadl ústavní stížností vedenou pod sp. zn. II. ÚS 2766/14",
      ),
    ).toEqual({ "II. ÚS 2766/14": null });
  });

  test("a hint seen once survives a later bare mention of the same key", () => {
    const citations = extractCitations([
      { index: 0, text: "nález sp. zn. II. ÚS 2766/14" },
      { index: 3, text: "Soud odkazuje na sp. zn. II. ÚS 2766/14 znovu." },
    ]);
    expect(citations).toEqual([
      {
        citationText: "II. ÚS 2766/14",
        sectionIndex: 3,
        citedDecisionTypeHint: CITATION_DECISION_TYPE_HINT.MERITS,
        citedCourtHint: null,
        identifierType: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
      },
    ]);
  });

  test("two different type words for one key leave it without a hint", () => {
    const citations = extractCitations([
      {
        index: 0,
        text: "nález sp. zn. I. ÚS 1/20 a usnesení sp. zn. I. ÚS 1/20",
      },
      { index: 1, text: "viz nález sp. zn. I. ÚS 1/20" },
    ]);
    // The later nález does not revive the hint: the text names two documents.
    expect(citations.map((c) => c.citedDecisionTypeHint)).toEqual([null]);
  });

  test("the same type word repeated keeps the hint", () => {
    const citations = extractCitations([
      {
        index: 0,
        text: "nález sp. zn. I. ÚS 1/20; srov. nález sp. zn. I. ÚS 1/20",
      },
    ]);
    expect(citations.map((c) => c.citedDecisionTypeHint)).toEqual([
      CITATION_DECISION_TYPE_HINT.MERITS,
    ]);
  });

  test("object prototype names are not hint words", () => {
    for (const word of ["constructor", "toString", "__proto__"]) {
      const text = `${word} sp. zn. I. ÚS 1/20`;
      expect(detectCitationDecisionTypeHint(text, text.indexOf("I. ÚS"))).toBe(
        null,
      );
    }
  });

  test("every hint names at least one stored decision type", () => {
    for (const hint of CITATION_DECISION_TYPE_HINTS) {
      expect(CITATION_DECISION_TYPE_HINT_FAMILIES[hint].length).toBeGreaterThan(
        0,
      );
    }
  });
});
