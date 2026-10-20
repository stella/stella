import { describe, expect, test } from "bun:test";

import {
  citationTextNamesCase,
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
