import { createElement } from "react";

import { describe, expect, test } from "bun:test";

import {
  citationTextNamesCase,
  inlineDecisionCitationPresentation,
  presentationBesideCitationText,
} from "@/components/references/decision-citation-chip.logic";
import { DECISION_CITATION_PRESENTATION } from "@/components/references/decision-citation-presentation.logic";

describe("citation text naming its case", () => {
  test("matches the case number whatever the spacing or case", () => {
    expect(citationTextNamesCase("III. ÚS 2429/24", "III.ÚS 2429/24")).toBe(
      true,
    );
    expect(
      citationTextNamesCase(
        "v nálezu iii. ús 2429/24 ze dne",
        "III.ÚS 2429/24",
      ),
    ).toBe(true);
    expect(citationTextNamesCase("27 Cdo 1525/2025", "27 Cdo 1525/2025")).toBe(
      true,
    );
  });

  test("normalises international punctuation, whitespace and registry decoration", () => {
    expect(
      citationTextNamesCase("III.\u00a0ÚS 2429/24", "III.ÚS 2429/24"),
    ).toBe(true);
    for (const [prose, stored] of [
      ["23 Cdo 651/2023", "NS 23 Cdo 651/2023-123"],
      ["3 Cdo 12/2020", "NS SR 3 Cdo 12/2020"],
      ["1 BvR 123/20", "BVerfG, 1 BvR 123/20"],
      ["410 U.S. 113", "SCOTUS 410 U.S. 113"],
    ]) {
      expect(citationTextNamesCase(prose ?? "", stored ?? "")).toBe(true);
    }
  });

  test("extracts rich link text and chooses one closed inline presentation", () => {
    const rich = createElement(
      "span",
      null,
      "rozsudek ",
      createElement("strong", null, "23\u00a0Cdo"),
      createElement("code", null, " 651/2023"),
      " ze dne",
    );
    expect(
      inlineDecisionCitationPresentation(rich, "NS 23 Cdo 651/2023-7"),
    ).toEqual({
      kind: "chip-replaces-text",
      before: "rozsudek ",
      after: " ze dne",
    });
    expect(
      inlineDecisionCitationPresentation("this decision", "23 Cdo 651/2023"),
    ).toEqual({ kind: "chip-after-text", label: "this decision" });
  });

  test("keeps the badge when the prose names another case or none", () => {
    expect(citationTextNamesCase("III. ÚS 2429/23", "III.ÚS 2429/24")).toBe(
      false,
    );
    expect(citationTextNamesCase("tento nález", "III.ÚS 2429/24")).toBe(false);
    expect(citationTextNamesCase("III. ÚS 2429/24", "")).toBe(false);
  });

  test("requires the case number to stand on its own", () => {
    expect(citationTextNamesCase("VIII. ÚS 2429/24", "III.ÚS 2429/24")).toBe(
      false,
    );
    expect(citationTextNamesCase("III. ÚS 2429/240", "III.ÚS 2429/24")).toBe(
      false,
    );
    expect(citationTextNamesCase("(III. ÚS 2429/24).", "III.ÚS 2429/24")).toBe(
      true,
    );
  });

  test("treats registry suffixes as part of the complete identifier", () => {
    expect(
      inlineDecisionCitationPresentation(
        "23 Cdo 651/2023-123",
        "23 Cdo 651/2023-7",
      ),
    ).toEqual({ kind: "chip-after-text", label: "23 Cdo 651/2023-123" });
    expect(
      inlineDecisionCitationPresentation(
        "23 Cdo 651/2023-123 follows",
        "23 Cdo 651/2023",
      ),
    ).toEqual({ kind: "chip-replaces-text", before: "", after: " follows" });
    expect(
      inlineDecisionCitationPresentation(
        "23 Cdo 651/2023 follows",
        "23 Cdo 651/2023-7",
      ),
    ).toEqual({ kind: "chip-replaces-text", before: "", after: " follows" });
    expect(
      inlineDecisionCitationPresentation(
        "23 Cdo 651/2023-7 follows",
        "23 Cdo 651/2023-7",
      ),
    ).toEqual({ kind: "chip-replaces-text", before: "", after: " follows" });
  });

  test("keeps identifier separators significant", () => {
    expect(citationTextNamesCase("see 12/3 here", "1/23")).toBe(false);
    expect(citationTextNamesCase("see 1/23 here", "1/23")).toBe(true);
    expect(citationTextNamesCase("see 1 / 23 here", "1/23")).toBe(true);
    expect(citationTextNamesCase("Nos. 17\u20131618", "17-1618")).toBe(true);
  });

  test("leaves a dash that opens a clause in the prose", () => {
    for (const dash of ["\u2014", "-", "\u2013"]) {
      expect(
        inlineDecisionCitationPresentation(
          `23 Cdo 651/2023${dash}the court held`,
          "23 Cdo 651/2023",
        ),
      ).toEqual({
        kind: "chip-replaces-text",
        before: "",
        after: `${dash}the court held`,
      });
    }
  });

  test("reads every dash variant as a suffix separator", () => {
    for (const dash of ["\u2010", "\u2011", "\u2212", "\u2013"]) {
      const prose = `23 Cdo 651/2023${dash}123`;
      expect(
        inlineDecisionCitationPresentation(prose, "23 Cdo 651/2023-7"),
      ).toEqual({ kind: "chip-after-text", label: prose });
      expect(
        inlineDecisionCitationPresentation(
          `${prose} follows`,
          "23 Cdo 651/2023",
        ),
      ).toEqual({ kind: "chip-replaces-text", before: "", after: " follows" });
    }
  });

  test("never matches a longer hyphenated identifier outside dated dockets", () => {
    expect(inlineDecisionCitationPresentation("A-123-B held", "A-123")).toEqual(
      { kind: "chip-after-text", label: "A-123-B held" },
    );
    expect(
      inlineDecisionCitationPresentation("C-123-B held", "A-123-B"),
    ).toEqual({ kind: "chip-after-text", label: "C-123-B held" });
  });

  test("keeps hyphenated identifiers whole outside dated dockets", () => {
    expect(inlineDecisionCitationPresentation("a decision", "A-123")).toEqual({
      kind: "chip-after-text",
      label: "a decision",
    });
    expect(
      inlineDecisionCitationPresentation("No. 17 of the list", "17-1618"),
    ).toEqual({ kind: "chip-after-text", label: "No. 17 of the list" });
    expect(
      inlineDecisionCitationPresentation("No. 17-1618 held", "17-1618"),
    ).toEqual({ kind: "chip-replaces-text", before: "No. ", after: " held" });
  });

  test("consumes a registry suffix written after a space", () => {
    expect(
      inlineDecisionCitationPresentation(
        "23 Cdo 651/2023 -123",
        "23 Cdo 651/2023-7",
      ),
    ).toEqual({ kind: "chip-after-text", label: "23 Cdo 651/2023 -123" });
    expect(
      inlineDecisionCitationPresentation(
        "23 Cdo 651/2023 \u2013 123 follows",
        "23 Cdo 651/2023",
      ),
    ).toEqual({ kind: "chip-replaces-text", before: "", after: " follows" });
    expect(
      inlineDecisionCitationPresentation(
        "23 Cdo 651/2023 - the court held",
        "23 Cdo 651/2023-7",
      ),
    ).toEqual({
      kind: "chip-replaces-text",
      before: "",
      after: " - the court held",
    });
  });
});

describe("a citation chip beside the text it was found in", () => {
  test("keeps only the court when the text prints the case number", () => {
    expect(
      presentationBesideCitationText({
        caseNumber: "23 Cdo 1192/2019",
        citationText: "sp. zn. 23 Cdo 1192/2019",
        presentation: DECISION_CITATION_PRESENTATION.expanded,
      }),
    ).toBe(DECISION_CITATION_PRESENTATION.compact);
  });

  test("keeps the case number when the text names the decision otherwise", () => {
    expect(
      presentationBesideCitationText({
        caseNumber: "23 Cdo 1192/2019",
        citationText: "rozsudku Nejvyššího soudu ze dne 30. 10. 2019",
        presentation: DECISION_CITATION_PRESENTATION.expanded,
      }),
    ).toBe(DECISION_CITATION_PRESENTATION.expanded);
  });

  test("never expands a compact chip", () => {
    expect(
      presentationBesideCitationText({
        caseNumber: "23 Cdo 1192/2019",
        citationText: "ze dne 30. 10. 2019",
        presentation: DECISION_CITATION_PRESENTATION.compact,
      }),
    ).toBe(DECISION_CITATION_PRESENTATION.compact);
  });
});
