import { describe, expect, test } from "bun:test";

import {
  extractCitations,
  isSelfCitation,
} from "@/api/handlers/case-law/ingestion/citation-extractor";

describe("extractCitations", () => {
  test("deduplicates sp. zn. and č. j. for the same case number", () => {
    const text = "Viz sp. zn. 21 Cdo 1234/2020 a také č. j. 21 Cdo 1234/2020";
    const citations = extractCitations([{ index: 0, text }]);
    expect(citations).toHaveLength(1);
    expect(citations[0]?.citationText).toContain("21 Cdo 1234/2020");
  });

  test("extracts č. j. with space", () => {
    const text = "rozsudek č. j. 5 As 123/2020";
    const citations = extractCitations([{ index: 0, text }]);
    expect(citations).toHaveLength(1);
    expect(citations[0]?.citationText).toBe("č. j. 5 As 123/2020");
  });

  test("extracts č.j. without space", () => {
    const text = "rozsudek č.j. 5 As 123/2020";
    const citations = extractCitations([{ index: 0, text }]);
    expect(citations).toHaveLength(1);
    expect(citations[0]?.citationText).toBe("č.j. 5 As 123/2020");
  });

  test("keeps distinct case numbers from sp. zn. and č. j.", () => {
    const text = "sp. zn. 21 Cdo 1234/2020 a č. j. 5 As 999/2021";
    const citations = extractCitations([{ index: 0, text }]);
    expect(citations).toHaveLength(2);
  });

  test("extracts an unprefixed Polish case number", () => {
    const citations = extractCitations([
      { index: 0, text: "Por. wyrok II CSK 123/20 oraz II ACa 45/20." },
    ]);
    const texts = citations.map((c) => c.citationText);
    expect(texts).toContain("II CSK 123/20");
    expect(texts).toContain("II ACa 45/20");
  });

  test("records the later (reasoning) section for a cross-section citation", () => {
    // The same case is listed bare in the header (section 0) and discussed
    // in the reasoning (section 2). The reasoning context carries polarity,
    // so the citation must be anchored to section 2, not the header.
    const citations = extractCitations([
      { index: 0, text: "Související: sp. zn. 21 Cdo 1234/2020." },
      { index: 1, text: "Skutkový stav bez citací." },
      {
        index: 2,
        text: "Soud se odchýlil od č. j. 21 Cdo 1234/2020 a rozhodl jinak.",
      },
    ]);

    expect(citations).toHaveLength(1);
    expect(citations[0]?.sectionIndex).toBe(2);
    expect(citations[0]?.citationText).toBe("č. j. 21 Cdo 1234/2020");
  });

  test("does not capture Roman-numeral prose as a phantom citation", () => {
    // The unprefixed Polish pattern previously matched any mixed-case word
    // for the division code, so ordinary prose became a citation.
    for (const text of [
      "Article XV See 12/20 for details",
      "see point III the 4/19 below",
      "as in II and 5/20 of the act",
    ]) {
      expect(extractCitations([{ index: 0, text }])).toHaveLength(0);
    }
  });
});

describe("isSelfCitation", () => {
  const decision = {
    caseNumber: "21 Cdo 1234/2020",
    ecli: "ECLI:CZ:NS:2020:21.CDO.1234.2020.1",
  };

  test("detects ECLI self-reference", () => {
    expect(isSelfCitation("ECLI:CZ:NS:2020:21.CDO.1234.2020.1", decision)).toBe(
      true,
    );
  });

  test("detects sp. zn. self-reference", () => {
    expect(isSelfCitation("sp. zn. 21 Cdo 1234/2020", decision)).toBe(true);
  });

  test("detects č. j. self-reference", () => {
    expect(isSelfCitation("č. j. 21 Cdo 1234/2020", decision)).toBe(true);
  });

  test("detects č.j. self-reference (no space)", () => {
    expect(isSelfCitation("č.j. 21 Cdo 1234/2020", decision)).toBe(true);
  });

  test("does not flag a different case number", () => {
    expect(isSelfCitation("sp. zn. 30 Cdo 5678/2019", decision)).toBe(false);
  });

  test("does not flag a different ECLI", () => {
    expect(isSelfCitation("ECLI:CZ:NS:2019:30.CDO.5678.2019.1", decision)).toBe(
      false,
    );
  });

  test("case-insensitive match", () => {
    const d = { caseNumber: "21 cdo 1234/2020" };
    expect(isSelfCitation("sp. zn. 21 Cdo 1234/2020", d)).toBe(true);
  });

  test("detects sygn. akt self-reference (Polish)", () => {
    const d = { caseNumber: "II CSK 123/20" };
    expect(isSelfCitation("sygn. akt II CSK 123/20", d)).toBe(true);
  });

  test("detects sygn. self-reference without akt", () => {
    const d = { caseNumber: "II CSK 123/20" };
    expect(isSelfCitation("sygn. II CSK 123/20", d)).toBe(true);
  });

  test("returns false when decision has no ECLI", () => {
    const d = { caseNumber: "21 Cdo 1234/2020" };
    expect(isSelfCitation("ECLI:CZ:NS:2019:30.CDO.5678.2019.1", d)).toBe(false);
  });
});
