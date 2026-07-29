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

  test("extracts two-digit-year citations from real NS prose", () => {
    // Verbatim prose quoted from prod decisions 22 Cdo 1534/2020 and
    // 25 Cdo 2181/2002, whose citations to pre-2000 decisions
    // (2 Cdon 808/97, 9 C 2058/96) use two-digit years.
    const text =
      "usnesení Nejvyššího soudu ze dne 27. 5. 1999, sp. zn. 2 Cdon 808/97, " +
      "vedené u Okresního soudu v Děčíně pod sp. zn. 9 C 2058/96";
    const texts = extractCitations([{ index: 0, text }]).map(
      (c) => c.citationText,
    );
    expect(texts).toContain("sp. zn. 2 Cdon 808/97");
    expect(texts).toContain("sp. zn. 9 C 2058/96");
  });

  test("extracts senate file numbers with diacritic registries", () => {
    const text =
      "usnesení Nejvyššího soudu ze dne 27. 8. 2013, sen. zn. 29 NSČR 55/2013";
    const citations = extractCitations([{ index: 0, text }]);
    expect(citations).toHaveLength(1);
    expect(citations[0]?.citationText).toBe("sen. zn. 29 NSČR 55/2013");
  });

  test("extracts Constitutional Court citations in senate and plenum form", () => {
    const text =
      "nález Ústavního soudu sp. zn. IV. ÚS 23/05 a stanovisko Pl. ÚS 12/94";
    const texts = extractCitations([{ index: 0, text }]).map(
      (c) => c.citationText,
    );
    expect(texts).toContain("IV. ÚS 23/05");
    expect(texts).toContain("Pl. ÚS 12/94");
  });

  test("treats hyphen variants of a CJEU number as one citation and as self", () => {
    const text = "věc C‑128/22 a rozsudek C-128/22";
    const citations = extractCitations([{ index: 0, text }]);
    expect(citations).toHaveLength(1);
    expect(
      isSelfCitation("C‑128/22", { caseNumber: "C-128/22", ecli: null }),
    ).toBe(true);
  });

  test("extracts Civil Service Tribunal case numbers", () => {
    const citations = extractCitations([
      { index: 0, text: "rozsudek F-100/09" },
    ]);
    expect(citations).toHaveLength(1);
    expect(citations[0]?.citationText).toBe("F-100/09");
  });

  test("extracts CJEU case numbers with plain and non-breaking hyphens", () => {
    const text =
      "rozsudek Soudního dvora ve věci C‑283/81 CILFIT a věc T-13/99";
    const texts = extractCitations([{ index: 0, text }]).map(
      (c) => c.citationText,
    );
    expect(texts).toContain("C‑283/81");
    expect(texts).toContain("T-13/99");
  });

  test("extracts letter-first registries without a senate number", () => {
    const text =
      "usnesení sp. zn. Nt 408/2023 a rozhodnutí sp. zn. A 9/2003, " +
      "nikoli spisu Ministerstva sp. zn. MSP-725/2022-ODKA-SPZ/7";
    const texts = extractCitations([{ index: 0, text }]).map(
      (c) => c.citationText,
    );
    expect(texts).toContain("sp. zn. Nt 408/2023");
    expect(texts).toContain("sp. zn. A 9/2003");
    expect(texts).toHaveLength(2);
  });

  test("extracts č. j. with a colon", () => {
    const text = "vyrozumění soudního exekutora č. j.: 137 Ex 1850/23";
    const citations = extractCitations([{ index: 0, text }]);
    expect(citations).toHaveLength(1);
    expect(citations[0]?.citationText).toBe("č. j.: 137 Ex 1850/23");
  });

  test("does not treat statute references as citations", () => {
    const text = "podle § 237 o. s. ř. a zákona č. 40/2009 Sb.";
    expect(extractCitations([{ index: 0, text }])).toHaveLength(0);
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
