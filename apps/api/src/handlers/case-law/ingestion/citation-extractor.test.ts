import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import {
  DECISION_IDENTIFIER_MAX_COUNT,
  DECISION_IDENTIFIER_TYPES,
} from "@stll/legal-ast/decision-identifier";
import type {
  DecisionIdentifierType,
  DecisionIdentifiers,
} from "@stll/legal-ast/decision-identifier";
import { propertyConfig } from "@stll/property-testing";

import {
  normalizeHuBhgyRow,
  readHuBhgySearch,
} from "@/api/handlers/case-law/ingestion/adapters/hu-bhgy";
import { plUokikDecisionIdentifiers } from "@/api/handlers/case-law/ingestion/adapters/pl-uokik";
import {
  bareCitationKey,
  decisionIdentifiersFromMetadata,
  decisionIdentifiersFromStoredMetadata,
  citationKeyOf,
  extractCitations,
  hungarianCitationForm,
  isSelfCitation,
  normalizeDecisionIdentifier,
  normalizeDecisionIdentifierValue,
} from "@/api/handlers/case-law/ingestion/citation-extractor";
import { storeDecisionIdentifiersInMetadata } from "@/api/lib/legal-search/decision-identifier-metadata";

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

  test("extracts the contracted čj. prefix used in Czech judgments", () => {
    const text =
      "Tento závěr je v rozporu s rozsudkem Krajského soudu v Praze ze dne 27. 3. 2015, čj. 52 A 22/2024-32.";
    const citations = extractCitations([{ index: 0, text }]);

    expect(citations).toHaveLength(1);
    expect(citations[0]).toMatchObject({
      citationText: "čj. 52 A 22/2024",
      citedCourtHint: "Krajského soudu v Praze",
    });
    expect(bareCitationKey(citations[0]?.citationText ?? "")).toBe(
      bareCitationKey("č. j. 52 A 22/2024"),
    );
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

  test("extracts a Constitutional Court citation whose mark is decomposed", () => {
    // From 4 Tdo 348/2023, whose text carries "Ú" as U+0055 U+0301. Nothing
    // normalizes a decision on the way in, and a `[ÚU]S` class reads the
    // decomposed spelling as a bare "U" followed by a mark: every
    // Constitutional Court citation in that paragraph went missing.
    const text =
      "současně založit kolizi se zásadami vyjádřenými v hlavě páté Listiny (nález Ústavního soudu sp. zn. I. ÚS 1135/17, ze dne 1. 11. 2017).".normalize(
        "NFD",
      );
    expect(text).not.toBe(text.normalize("NFC"));

    const citations = extractCitations([{ index: 0, text }]);

    expect(citations).toHaveLength(1);
    expect(citations[0]?.citationText).toBe("I. ÚS 1135/17".normalize("NFD"));
    // Either normalization form reaches the resolver as one key, so the
    // decomposed spelling still joins the composed corpus row.
    expect(bareCitationKey(citations[0]?.citationText ?? "")).toBe(
      bareCitationKey("I.ÚS 1135/17"),
    );
  });

  test("extracts Slovak Constitutional Court citations without the senate dot", () => {
    const text = "nález sp. zn. III ÚS 154/2011 z 13. 4. 2011";
    const citations = extractCitations([{ index: 0, text }]);
    expect(citations).toHaveLength(1);
    expect(citations[0]?.citationText).toBe("III ÚS 154/2011");
  });

  test("treats hyphen variants of a CJEU number as one citation and as self", () => {
    const text = "věc C‑128/22 a rozsudek C-128/22";
    const citations = extractCitations([{ index: 0, text }]);
    expect(citations).toHaveLength(1);
    expect(
      isSelfCitation(
        "C‑128/22",
        decisionIdentifiersFromMetadata({ caseNumber: "C-128/22" }),
      ),
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

  test("extracts a CJEU case number whose hyphen is a soft hyphen (U+00AD)", () => {
    // Verbatim from a Slovak Constitutional Court decision citing CJEU
    // Banif Plus Bank v. Csaba Cipani. A PDF-to-text conversion left a
    // soft hyphen (invisible when rendered) standing in for the ordinary
    // separator between "C" and the docket number.
    const text =
      "vo veci Banif Plus Bank Zrt proti Csaba Cipani a spol. sp. zn. " +
      "C­472/11 z 21. februára 2013";
    const texts = extractCitations([{ index: 0, text }]).map(
      (c) => c.citationText,
    );
    expect(texts).toContain("C­472/11");
  });

  test("extracts CJEU case numbers with OCR-noisy hyphen spacing, hyphen still present", () => {
    // Verbatim from a Czech decision citing CJEU C-679/18 three different
    // ways within the same paragraph. A no-hyphen spelling ("C679/18") is
    // deliberately out of scope: it would collide with the Czech civil
    // "C" registry ("21 C 1234/2020").
    const texts = extractCitations([
      { index: 0, text: "Soudní dvůr rozhodl ve věci C -679/18 o otázce" },
    ])
      .concat(
        extractCitations([
          { index: 0, text: "rozsudek ve věci C- 679/18 ze dne 5. 3. 2020" },
        ]),
      )
      .map((c) => c.citationText);
    expect(texts).toContain("C -679/18");
    expect(texts).toContain("C- 679/18");
    expect(
      extractCitations([{ index: 0, text: "ve věci C679/18: společnost" }]),
    ).toHaveLength(0);
  });

  test("extracts CJEU numbers written with unspaced and spaced hyphens", () => {
    // Three distinct case numbers, each with a different real-world hyphen
    // spacing; this proves extraction of every spacing variant, not
    // dedup (see the next test for that).
    const text =
      "rozsudky Súdneho dvora Európskej únie C-679/18, tiež C-449/13, " +
      "C- 303/20";
    const texts = extractCitations([{ index: 0, text }]).map(
      (c) => c.citationText,
    );
    expect(texts).toContain("C-679/18");
    expect(texts).toContain("C-449/13");
    expect(texts).toContain("C- 303/20");
  });

  test("dedupes a CJEU number cited with an unspaced and a spaced hyphen", () => {
    // The same case, "C-679/18", is cited once with the plain hyphen and
    // once with the OCR-noisy spaced hyphen; the dedup key must collapse
    // the whitespace around the hyphen so both resolve to one citation.
    const citations = extractCitations([
      {
        index: 0,
        text: "rozsudok C-679/18 a znovu rozsudok C- 679/18 v odôvodnení",
      },
    ]);
    expect(citations).toHaveLength(1);
  });

  test("does not re-extract a bare CJEU number after a spaced hyphen prefix", () => {
    // The ECLI-anchored bare-number pattern's negative lookbehind must
    // reject the same spaced-hyphen prefix the CJEU C/T/F pattern itself
    // tolerates ("C- 679/18"), not just the tight "C-679/18" form --
    // otherwise "679/18" would also be captured as a phantom bare
    // pre-1989 number just because an ECLI suffix follows.
    const text = "rozsudek ve věci C- 679/18, EU:C:2020:123 ze dne 5. 3. 2020";
    const texts = extractCitations([{ index: 0, text }]).map(
      (c) => c.citationText,
    );
    expect(texts).toContain("C- 679/18");
    expect(texts).toContain("EU:C:2020:123");
    expect(texts).not.toContain("679/18");
  });

  test("extracts a CJEU number written with an en dash", () => {
    // normalizeDashes already canonicalizes en/em dashes for the dedup
    // key, but the matcher itself only accepted a hyphen or the
    // non-breaking hyphen; an en-dash spelling was silently dropped.
    const text = "rozsudok Súdneho dvora C–128/22 z 5. 3. 2020";
    const citations = extractCitations([{ index: 0, text }]);
    expect(citations).toHaveLength(1);
    expect(citations[0]?.citationText).toBe("C–128/22");
  });

  test("extracts CJEU case numbers whose year is written out in full", () => {
    // Verbatim from a Slovak decision on working-time law, which cites the
    // Court of Justice with the four-digit year national courts commonly
    // write rather than the Court's own two-digit form. Both spellings
    // appear in one paragraph, and the spaced-hyphen variant is the same
    // OCR spacing the hyphen tests above cover.
    const text =
      "K pojmu pracovného času poukázal na rozsudok vo veci C- 610/2017 " +
      "zo dňa 19.11.2019. K judikátu C-254/2018 uviedol, že sa jedná o " +
      "rozhodnutie vo veci Francúzskej republiky";
    const texts = extractCitations([{ index: 0, text }]).map(
      (c) => c.citationText,
    );
    expect(texts).toContain("C- 610/2017");
    expect(texts).toContain("C-254/2018");
  });

  test("keeps the two-digit CJEU year unambiguous against a longer number", () => {
    // The year block is a pair, not a 2-4 range: a three- or five-digit
    // trailing number is not a year, and the trailing-digit guard rejects
    // the match outright rather than letting it capture a shortened
    // prefix of itself ("C-254/201", "C-254/2018" from "C-254/20185").
    expect(
      extractCitations([{ index: 0, text: "vo veci C-254/201 uviedol" }]),
    ).toHaveLength(0);
    expect(
      extractCitations([{ index: 0, text: "vo veci C-254/20185 uviedol" }]),
    ).toHaveLength(0);
  });

  test("does not capture a CJEU citation across an over-long whitespace run around the separator", () => {
    // The whitespace around the CJEU separator is bounded (0-3
    // characters) so a stray OCR whitespace run never leaks into the
    // stored citation text; an unrealistically long run simply fails to
    // match rather than being captured with the whitespace baked in.
    const text = "rozsudek C     -679/18 ze dne 5. 3. 2020";
    expect(extractCitations([{ index: 0, text }])).toHaveLength(0);
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

  test("excludes the Spr court-administration agenda alongside an ordinary letter-first registry", () => {
    // Verbatim: "sp. zn. Spr. 2158/03" is the court-administration agenda
    // (správa súdu), not adjudication (deliberately excluded, even though
    // it wears the sp. zn. prefix), while an ordinary letter-first
    // registry in the same text ("Nt 408/2023") is still extracted.
    const text =
      "odpoveď okresného súdu sp. zn. Spr. 2158/03 z 31. júla 2003 na " +
      "jej sťažnosť, viz sp. zn. Nt 408/2023";
    const texts = extractCitations([{ index: 0, text }]).map(
      (c) => c.citationText,
    );
    expect(texts).toEqual(["sp. zn. Nt 408/2023"]);
  });

  test("excludes the Spr court-administration agenda regardless of casing", () => {
    // The Spr exclusion guard must be case-insensitive: "SPR." and
    // "spr." are both real registrar spellings and must escape a
    // case-sensitive literal exclusion just as much as "Spr." does.
    const upper = "sp. zn. SPR. 2158/03 nie je citáciou judikatúry";
    const lower = "sp. zn. spr. 2158/03 nie je citáciou judikatúry";
    expect(extractCitations([{ index: 0, text: upper }])).toHaveLength(0);
    expect(extractCitations([{ index: 0, text: lower }])).toHaveLength(0);
  });

  test("extracts č. j. with the senate number and chamber code joined", () => {
    // Verbatim prose from a prod Nejvyšší správní soud decision: the
    // administrative-court registry code ("Afs") is typeset directly
    // against the senate number, with no space, unlike the civil-court
    // "5 As 123/2020" style already covered above.
    const text =
      "V rozsudku ze dne 15. 12. 2011, č. j. 9Afs 44/2011 – 343, " +
      "Nejvyšší správní soud mimo jiné konstatoval";
    const citations = extractCitations([{ index: 0, text }]);
    expect(citations).toHaveLength(1);
    expect(citations[0]?.citationText).toBe("č. j. 9Afs 44/2011");
  });

  test("dedupes a č.j. case number cited both spaced and glued to its senate digit", () => {
    // Verbatim from a prod decision citing Okresní soud v Blansku's own
    // trial-court file twice in one paragraph: once spaced ("7 C") and
    // once glued to the senate digit ("7C"). Separator canonicalization
    // means both spellings resolve to one dedup key, so only one citation
    // is recorded (the first-seen spelling).
    const text =
      "Okresní soud v Blansku usnesením ze dne 24. března 1999 č. j. " +
      "7 C 840/98-22 zrušil rozsudek pro zmeškání Okresního soudu v " +
      "Blansku ze dne 15. února 1999 č. j. 7C 840/98-20";
    const citations = extractCitations([{ index: 0, text }]);
    expect(citations).toHaveLength(1);
    expect(citations[0]?.citationText).toBe("č. j. 7 C 840/98");
  });

  test("extracts a č.j. administrative-court senate glued to its digit", () => {
    // Verbatim from a prod decision: "6A 242/2016" (Městský soud v Praze,
    // administrative senate) with no space between the senate digit and
    // the registry letter.
    const text = "Městského soudu v Praze č.j. 6A 242/2016-23 ze dne";
    const citations = extractCitations([{ index: 0, text }]);
    expect(citations).toHaveLength(1);
    expect(citations[0]?.citationText).toBe("č.j. 6A 242/2016");
  });

  test("extracts fused senate+registry č.j. case numbers", () => {
    // Verbatim prose quoted from a prod NSS (Nejvyšší správní soud)
    // decision: the senate number fuses directly to the registry code
    // under č.j. ("7Afs"), unlike the space-separated generic č.j. form.
    const text =
      "vyjádřil se v rozsudku č.j. 7Afs 1/2010-53 ze dne 4.2.2010, v němž " +
      "v návaznosti na usnesení rozšířeného senátu NSS č.j. 7Afs 212/2006-74 " +
      "ze dne 19.2.2008 konstatoval";
    const texts = extractCitations([{ index: 0, text }]).map(
      (c) => c.citationText,
    );
    expect(texts).toContain("č.j. 7Afs 1/2010");
    expect(texts).toContain("č.j. 7Afs 212/2006");
  });

  test("extracts joined case numbers from consolidated appeals", () => {
    // Verbatim prose quoted from a prod Nejvyšší soud decision: the
    // appellate court joined two appeals (116 and 119) into one ruling
    // and cited them together under a shared year.
    const text =
      "o dovolání žalobce proti rozsudku Krajského soudu v Praze ze dne " +
      "5. dubna 2007, č. j. 27 Co 116, 119/2007-94, takto:";
    const texts = extractCitations([{ index: 0, text }]).map(
      (c) => c.citationText,
    );
    expect(texts).toContain("č. j. 27 Co 116, 119/2007");
  });

  test("extracts a č.j. consolidated case number joined by a comma with no space", () => {
    // Verbatim from a prod decision consolidating two appellate cases
    // ("36 Co 52/2023" and "36 Co 53/2023") under a shared year and page.
    const text =
      "Městského soudu v Praze ze dne 11. května 2023, č. j. " +
      "36 Co 52,53/2023-116, za účasti Nejvyššího soudu";
    const citations = extractCitations([{ index: 0, text }]);
    expect(citations).toHaveLength(1);
    expect(citations[0]?.citationText).toBe("č. j. 36 Co 52,53/2023");
  });

  test("dedupes a consolidated docket comma cited with and without a space", () => {
    // "36 Co 52,53/2023" (no space after the comma) and "36 Co 52,
    // 53/2023" (spaced) name the same consolidated appeal; the dedup key
    // must strip the whitespace after the comma so both resolve to one
    // citation.
    const citations = extractCitations([
      {
        index: 0,
        text:
          "Městského soudu v Praze ze dne 11. května 2023, č. j. " +
          "36 Co 52,53/2023-116, k tomu opětovně č. j. 36 Co 52, " +
          "53/2023-116, za účasti Nejvyššího soudu",
      },
    ]);
    expect(citations).toHaveLength(1);
  });

  test("dedupes a consolidated docket cited with a comma and with a slash", () => {
    // "36 Co 52,53/2023" (comma-joined) and "36 Co 52/53/2023"
    // (slash-joined) name the same consolidated appeal; the canonicalizer
    // must fold both join spellings to one key regardless of which
    // separator the source uses.
    const citations = extractCitations([
      {
        index: 0,
        text:
          "Městského soudu v Praze ze dne 11. května 2023, č. j. " +
          "36 Co 52,53/2023-116, k tomu opětovně č. j. 36 Co 52/53/2023-116, " +
          "za účasti Nejvyššího soudu",
      },
    ]);
    expect(citations).toHaveLength(1);
  });

  test("extracts a letter-first č.j. registry without a senate number", () => {
    // Verbatim from a prod decision: "Nad 224/2014" (Nejvyšší soud,
    // jurisdiction-delegation register) has no leading senate digit,
    // unlike the ordinary "č. j. 5 As 123/2020" shape.
    const text = "usnesení ze dne 9. 12. 2014, č.j. Nad 224/2014-53.";
    const citations = extractCitations([{ index: 0, text }]);
    expect(citations).toHaveLength(1);
    expect(citations[0]?.citationText).toBe("č.j. Nad 224/2014");
  });

  test("extracts letter-first registry č.j. case numbers with no senate number", () => {
    // Verbatim prose quoted from a prod NSS jurisdiction-conflict decision:
    // the "Konf" register has no leading panel number at all, so neither
    // the digit-first č.j. pattern matched it.
    const text = "srovnej např. usnesení č.j. Konf 4/2011-12 ze dne 20.4.2011";
    const citations = extractCitations([{ index: 0, text }]);
    expect(citations).toHaveLength(1);
    expect(citations[0]?.citationText).toBe("č.j. Konf 4/2011");
  });

  test("extracts a č.j. insolvency case number carrying the issuing court's registry code", () => {
    // Verbatim prose quoted from a prod insolvency decision: "KSCB" is
    // the Krajský soud v Českých Budějovicích registry code, cited before
    // the ordinary senate+INS+docket/year shape. The code must be kept in
    // the citation, since "26 INS 8270/2018" alone is only unique within
    // that one court.
    const text =
      "Usnesením Krajského soudu v Českých Budějovicích ze dne 3. 5. 2018, " +
      "č. j. KSCB 26 INS 8270/2018-A-12, bylo rozhodnuto o úpadku dlužníka.";
    const citations = extractCitations([{ index: 0, text }]);
    expect(citations).toHaveLength(1);
    expect(citations[0]?.citationText).toBe("č. j. KSCB 26 INS 8270/2018");
  });

  test("keeps insolvency case numbers from different courts distinct even with a shared docket", () => {
    const text =
      "č. j. KSCB 26 INS 8270/2018-A-12 a dále č. j. KSHK 26 INS 8270/2018-B-11";
    const citations = extractCitations([{ index: 0, text }]);
    const texts = citations.map((c) => c.citationText);
    expect(texts).toContain("č. j. KSCB 26 INS 8270/2018");
    expect(texts).toContain("č. j. KSHK 26 INS 8270/2018");
    expect(citations).toHaveLength(2);
  });

  test("extracts the glued-registry, slash-separated insolvency spelling on its own", () => {
    const text = "č. j. KSCB 26INS/8270/2018-A-14";
    const citations = extractCitations([{ index: 0, text }]);
    expect(citations).toHaveLength(1);
    expect(citations[0]?.citationText).toBe("č. j. KSCB 26INS/8270/2018");
  });

  test("dedupes a č.j. insolvency case number cited with different accepted separators", () => {
    const text =
      "č. j. KSCB 26 INS 8270/2018-A-12 a dále č. j. KSCB 26INS/8270/2018-A-14";
    const citations = extractCitations([{ index: 0, text }]);
    expect(citations).toHaveLength(1);
  });

  test("extracts a repeated-slash OCR artifact in the insolvency registry-to-docket gap on its own", () => {
    const text = "č. j. KSCB 26 INS//8270/2018-A-14";
    const citations = extractCitations([{ index: 0, text }]);
    expect(citations).toHaveLength(1);
    expect(citations[0]?.citationText).toBe("č. j. KSCB 26 INS//8270/2018");
  });

  test("dedupes an insolvency case number against a repeated-slash OCR artifact of the same docket", () => {
    const text =
      "č. j. KSCB 26 INS 8270/2018-A-12 a dále č. j. KSCB 26 INS//8270/2018-A-14";
    const citations = extractCitations([{ index: 0, text }]);
    expect(citations).toHaveLength(1);
  });

  test("keeps the full case number when a line wrap lands inside the prefix body", () => {
    // stripPrefix's capture must span the newline (dotAll), or "sp. zn.
    // 21\nCdo 1234/2020" truncates to just "21" and the persisted
    // citation key silently drops everything after the line break.
    expect(bareCitationKey("sp. zn. 21\nCdo 1234/2020")).toBe(
      bareCitationKey("sp. zn. 21 Cdo 1234/2020"),
    );
  });

  test("keeps the full court-code-prefixed case number when a line wrap lands inside it", () => {
    expect(bareCitationKey("č. j. KSCB 26 INS\n8270/2018")).toBe(
      bareCitationKey("č. j. KSCB 26 INS 8270/2018"),
    );
  });

  test("recognizes a self-citation to an insolvency case number spelled with a different separator", () => {
    expect(
      isSelfCitation(
        "č. j. KSCB 26INS/8270/2018",
        decisionIdentifiersFromMetadata({
          caseNumber: "KSCB 26 INS 8270/2018",
        }),
      ),
    ).toBe(true);
  });

  test("extracts the slash-joined court-code-prefixed consolidated docket on its own", () => {
    const text = "č. j. KSCB 26 INS 8270/8271/2018-A-14";
    const citations = extractCitations([{ index: 0, text }]);
    expect(citations).toHaveLength(1);
    expect(citations[0]?.citationText).toBe("č. j. KSCB 26 INS 8270/8271/2018");
  });

  test("dedupes a court-code-prefixed consolidated docket cited with different accepted separators", () => {
    const text =
      "č. j. KSCB 26 INS 8270,8271/2018-A-12 a dále č. j. KSCB 26 INS 8270/8271/2018-A-14";
    const citations = extractCitations([{ index: 0, text }]);
    expect(citations).toHaveLength(1);
  });

  test("recognizes a self-citation to an insolvency case number whose stored court code is not uppercase", () => {
    expect(
      isSelfCitation(
        "č. j. MSPH 99 INS 19057/2012",
        decisionIdentifiersFromMetadata({
          caseNumber: "Msph 99 INS 19057/2012",
        }),
      ),
    ).toBe(true);
  });

  test("extracts č. j. with a colon", () => {
    const text = "vyrozumění soudního exekutora č. j.: 137 Ex 1850/23";
    const citations = extractCitations([{ index: 0, text }]);
    expect(citations).toHaveLength(1);
    expect(citations[0]?.citationText).toBe("č. j.: 137 Ex 1850/23");
    expect(
      isSelfCitation(
        "č. j.: 137 Ex 1850/23",
        decisionIdentifiersFromMetadata({ caseNumber: "137 Ex 1850/23" }),
      ),
    ).toBe(true);
  });

  test("does not treat statute references as citations", () => {
    const text = "podle § 237 o. s. ř. a zákona č. 40/2009 Sb.";
    expect(extractCitations([{ index: 0, text }])).toHaveLength(0);
  });

  test("extracts the full Sb. NSS collection code without truncating it to Sb. NS", () => {
    // Verbatim prose quoted from a prod decision: the Nejvyšší správní
    // soud collection is "Sb. NSS", a different court's abbreviation than
    // the Nejvyšší soud collection "Sb. NS"/"Sb. rozh. tr.". Matching the
    // "NS" alternative first truncated it, dropping the trailing "S" and
    // pointing at the wrong court's reporter.
    const text =
      "podle rozsudku Nejvyššího správního soudu ze dne 6. 1. 2010, " +
      "č.j. 3 Ads 110/2009-49, č. 2018/2010 Sb. NSS (všechna rozhodnutí " +
      "Nejvyššího správního soudu citovaná v tomto rozsudku jsou " +
      "publikována na www.nssoud.cz)";
    // The docket and the collection number name one decision, so they are
    // one citation: the entry anchors on the docket and resolves by the
    // collection number.
    const citations = extractCitations([{ index: 0, text }]);
    expect(citations).toHaveLength(1);
    expect(citations[0]).toMatchObject({
      citationText: "č.j. 3 Ads 110/2009",
      citedSheetNumber: "49",
      identifierType: DECISION_IDENTIFIER_TYPES.REPORTER_CITATION,
      identifierValue: "č. 2018/2010 Sb. NSS",
    });
  });

  test("extracts a bare Cpjn plenary-opinion citation without sp. zn.", () => {
    // Verbatim prose quoted from a prod decision (CZE): the Supreme
    // Court's civil/commercial collegium opinion is cited without any
    // "sp. zn." prefix, unlike an ordinary case number.
    const text =
      "srov. např. stanovisko občanskoprávního a obchodního kolegia " +
      "Nejvyššího soudu ze dne 12. 1. 2011, Cpjn 203/2010, uveřejněné pod " +
      "č. 50/2011 Sbírky soudních rozhodnutí a stanovisek";
    const citations = extractCitations([{ index: 0, text }]);
    expect(citations.map((c) => c.citationText)).toContain("Cpjn 203/2010");
  });

  test("dedupes a bare Cpjn mention against the sp. zn.-prefixed one", () => {
    const citations = extractCitations([
      {
        index: 0,
        text:
          "stanovisko sp. zn. Cpjn 206/2010 č. 58/2011 Sb. rozh. civ. ... " +
          "neaktuálnost stanoviska Cpjn 206/2010 jako takového",
      },
    ]);
    expect(citations).toHaveLength(1);
  });

  test("extracts a Constitutional Court plenary opinion (stanovisko pléna)", () => {
    // Verbatim prose quoted from a prod Nejvyšší soud decision citing the
    // Constitutional Court's plenary opinion on the "-st." (stanovisko)
    // series, distinct from the ordinary "Pl. ÚS 12/94" nález numbering.
    const text =
      "srov. stanovisko pléna Ústavního soudu sp. zn. Pl. ÚS-st. 38/14 ze dne " +
      "4. 3. 2014, publikované pod č. 40/2014 Sb.";
    const texts = extractCitations([{ index: 0, text }]).map(
      (c) => c.citationText,
    );
    expect(texts).toContain("Pl. ÚS-st. 38/14");
  });

  test("extracts a Constitutional Court plenary standpoint citation with the -st. infix", () => {
    // Verbatim prose quoted from a prod Ústavní soud decision: a binding
    // plenary "stanovisko" carries a "-st." infix between the court
    // marker and the case number.
    const text =
      "[viz stanovisko pléna Ústavního soudu ze dne 28. 11. 2017 sp. " +
      "zn. Pl. ÚS-st. 45/16 (ST 45/87 SbNU 905; 460/2017 Sb.)]";
    const citations = extractCitations([{ index: 0, text }]);
    expect(citations).toHaveLength(1);
    expect(citations[0]?.citationText).toBe("Pl. ÚS-st. 45/16");
  });

  test("extracts a Czech Constitutional Court plenary opinion cited from Slovak prose", () => {
    // Verbatim from a Slovak Constitutional Court decision quoting Czech
    // constitutional doctrine. "Pl. ÚS-st." / "Pl. ÚS – st." is a distinct
    // plenary-opinion series from ordinary "Pl. ÚS" decisions, with the
    // dash before "st." optionally spaced (hyphen or en-dash).
    const text =
      "stanovisko pléna Ústavného súdu Českej republiky Pl. ÚS – st. 59/23 " +
      "zo dňa 13.09.2023";
    const citations = extractCitations([{ index: 0, text }]);
    expect(citations).toHaveLength(1);
    expect(citations[0]?.citationText).toBe("Pl. ÚS – st. 59/23");
  });

  test("extracts a plenary standpoint citation with a non-breaking hyphen before the infix", () => {
    // "Pl. ÚS‑st. 45/16" with a non-breaking hyphen (U+2011) before "st."
    // must match the standpoint pattern the same way the plain hyphen and
    // en/em dash spellings already do.
    const text =
      "stanovisko pléna Ústavního soudu Pl. ÚS‑st. 45/16 ze dne " +
      "28. 11. 2017";
    const citations = extractCitations([{ index: 0, text }]);
    expect(citations).toHaveLength(1);
    expect(citations[0]?.citationText).toBe("Pl. ÚS‑st. 45/16");
  });

  test("keeps standpoint and plain Constitutional Court citations distinct across spelling variants", () => {
    // The "-st." infix must survive canonicalization for the
    // diacritic-dropped and slash-joined spellings too, or a plenary
    // standpoint ("Pl. ÚS-st. 45/16") would collide with an unrelated
    // ordinary nález sharing the same digits ("Pl. ÚS 45/16").
    const pairs: [string, string][] = [
      ["Pl. ÚS-st. 45/16", "Pl. ÚS 45/16"],
      ["Pl. ÚS – st. 45/16", "Pl. ÚS 45/16"],
      ["II.US-st./251/04", "II.US/251/04"],
      ["III. ÚS-st. 364/2017", "III. ÚS 364/2017"],
    ];
    for (const [standpoint, plain] of pairs) {
      expect(bareCitationKey(standpoint)).not.toBe(bareCitationKey(plain));
    }
  });

  test("extracts Slovak Constitutional Court citations with a slash before the number", () => {
    // Verbatim prose quoted from a prod Ústavný súd decision: a case list
    // mixes the slash shorthand with the ordinary spaced form in the same
    // sentence.
    const text =
      "porovnaj napríklad rozhodnutia ÚS SR II.ÚS/251/04, III.ÚS/209/04, " +
      "II.ÚS 200/09 a podobne";
    const texts = extractCitations([{ index: 0, text }]).map(
      (c) => c.citationText,
    );
    expect(texts).toContain("II.ÚS/251/04");
    expect(texts).toContain("III.ÚS/209/04");
    expect(texts).toContain("II.ÚS 200/09");
  });

  test("extracts a Slovak Constitutional Court citation with the diacritic dropped", () => {
    // Verbatim prose quoted from a prod Slovak decision: "ÚS" typeset as
    // plain "US", likely an encoding fallback upstream of ingestion.
    const text =
      "Z uznesenia Ústavného súdu Slovenskej republiky zo dňa " +
      "30.05.2017, sp. zn.: III.US 364/2017 vyplýva, že preukázanie " +
      "hrozby treba považovať za osobitnú náležitosť návrhu.";
    const citations = extractCitations([{ index: 0, text }]);
    expect(citations).toHaveLength(1);
    expect(citations[0]?.citationText).toBe("III.US 364/2017");
  });

  test("dedupes Constitutional Court citations across the slash/space/dot spelling family", () => {
    // "II.ÚS/251/04" (slash, no space), "II.ÚS 251/04" (space, no slash),
    // and "II. ÚS 251/04" (dot then a second space) all name the same
    // case; the dedup key must fold them to one key regardless of the
    // dot/space/slash boundary after the roman numeral.
    const citations = extractCitations([
      {
        index: 0,
        text:
          "porovnaj rozhodnutia ÚS SR II.ÚS/251/04 a znovu II. ÚS 251/04 " +
          "v odôvodnení",
      },
    ]);
    expect(citations).toHaveLength(1);
  });

  test("dedupes a diacritic-dropped Constitutional Court citation against the accented spelling", () => {
    // "III.US 364/2017" (diacritic dropped) and "III. ÚS 364/2017"
    // (accented) name the same case; the dedup key must fold the
    // diacritic so both resolve to one key, even though the stored
    // citationText for each mention stays verbatim.
    const citations = extractCitations([
      {
        index: 0,
        text:
          "Z uznesenia Ústavného súdu sp. zn.: III.US 364/2017 vyplýva, " +
          "a znovu sp. zn. III. ÚS 364/2017 sa uvádza v odôvodnení",
      },
    ]);
    expect(citations).toHaveLength(1);
  });

  test("extracts an all-caps PL ÚS plenary citation (Slovak spelling)", () => {
    // Verbatim prose quoted from a prod decision (SVK): the Slovak
    // Constitutional Court's own filings write the plenum marker in all
    // caps ("PL"), unlike the Czech title-case "Pl." convention.
    const text =
      "nález sp. zn. PL ÚS 11/2016 zo 07.02.2018, uznesenie Krajského súdu " +
      "v Prešove";
    const citations = extractCitations([{ index: 0, text }]);
    expect(citations).toHaveLength(1);
    expect(citations[0]?.citationText).toBe("PL ÚS 11/2016");
  });

  test("extracts a Slovak extraordinary-review panel case number (M Cdo)", () => {
    // Verbatim prose quoted from a prod decision (SVK): "M" (mimoriadne
    // dovolanie) sits between the chamber digit and the ordinary registry.
    const text =
      "uznesenie Najvyššieho súdu SR z 27. júla 2011, sp. zn. 4 M Cdo " +
      "15/2010";
    const citations = extractCitations([{ index: 0, text }]);
    expect(citations).toHaveLength(1);
    expect(citations[0]?.citationText).toBe("sp. zn. 4 M Cdo 15/2010");
  });

  test("extracts a Slovak grand-chamber (veľký senát) case number", () => {
    // Verbatim from a prod decision: the Slovak Supreme Court's grand
    // chamber inserts "M" before the registry ("M Cdo").
    const text =
      "Podľa uznesenia Najvyššieho súdu SR z 29. mája 2014, sp. zn. " +
      "7 M Cdo 1/2014, ak súd zastavuje konanie";
    const citations = extractCitations([{ index: 0, text }]);
    expect(citations).toHaveLength(1);
    expect(citations[0]?.citationText).toBe("sp. zn. 7 M Cdo 1/2014");
  });

  test("extracts Slovak extraordinary-appeal panel case numbers (M Obdo)", () => {
    // Verbatim prose quoted from a prod Slovak Constitutional Court
    // decision: the Supreme Court's "mimoriadne dovolanie" panel prefixes
    // the ordinary chamber code with an extra "M" as a second word.
    const text =
      "rozsudkom Najvyššieho súdu Slovenskej republiky (ďalej len „NSSR“), " +
      "sp. zn. 2 M Obdo 1/2008 z 28. mája 2008";
    const citations = extractCitations([{ index: 0, text }]);
    expect(citations).toHaveLength(1);
    expect(citations[0]?.citationText).toBe("sp. zn. 2 M Obdo 1/2008");
  });

  test("extracts a Slovak case number with a courthouse workplace-code prefix", () => {
    // Verbatim prose quoted from a prod decision (SVK): the district court
    // workplace code ("B4-") prefixes the ordinary joined chamber+registry
    // shape.
    const text =
      "v konaní vedenom na tunajšom súde pod sp. zn. B4-14Cb/13/2021. 6. " +
      "Z vyššie uvedeného je zrejmé";
    const citations = extractCitations([{ index: 0, text }]);
    expect(citations).toHaveLength(1);
    expect(citations[0]?.citationText).toBe("sp. zn. B4-14Cb/13/2021");
  });

  test("extracts specialist Slovak case numbers without a period after 'zn'", () => {
    // The general Slovak sp. zn. pattern already accepts a missing
    // period after "zn" ("sp. zn 5Obdo/23/2016"); the specialist
    // patterns for the M-insert, PK panel, hyphenated registry, and
    // workplace-code shapes must accept the same no-period spelling.
    const texts = [
      "sp. zn 4 M Cdo 15/2010",
      "sp. zn PK 1 Tš 24/2006",
      "sp. zn 5 Sž-o-KS 94/2005",
      "sp. zn B4-14Cb/13/2021",
    ];
    for (const text of texts) {
      expect(extractCitations([{ index: 0, text }])).toHaveLength(1);
    }
  });

  test("extracts a Slovak Mestský súd (post-2023 reform) case number", () => {
    // Verbatim prose quoted from a prod Mestský súd Košice decision: the
    // reform-era case number hyphenates a court-branch code onto the
    // ordinary senate/registry/number/year.
    const text =
      "zmysle rozsudku Mestského súdu Košice sp. zn. K2-17P/72/2022 zo " +
      "dňa 21.06.2023 v spojení s opravným uznesením Mestského súdu " +
      "Košice sp. zn. K2-17P/72/2022 zo dňa 11.09.2023.";
    const citations = extractCitations([{ index: 0, text }]);
    expect(citations).toHaveLength(1);
    expect(citations[0]?.citationText).toBe("sp. zn. K2-17P/72/2022");
  });

  test("extracts a Slovak hyphenated administrative registry code", () => {
    // Verbatim from a prod Ústavný súd decision quoting a Najvyšší súd
    // judgment in a hyphenated appellate-administrative senate registry.
    const text =
      "rozsudkom Najvyššieho súdu Slovenskej republiky sp. zn. 5 Sž-o-KS 94/2005 " +
      "z 9. mája 2006";
    const citations = extractCitations([{ index: 0, text }]);
    expect(citations).toHaveLength(1);
    expect(citations[0]?.citationText).toBe("sp. zn. 5 Sž-o-KS 94/2005");
  });

  test("extracts a Slovak Special Court case number with the PK panel prefix", () => {
    // Verbatim from a Slovak Constitutional Court decision citing the
    // now-defunct Špeciálny súd v Pezinku (2004-2009).
    const text =
      "rozsudkom Špeciálneho súdu v Pezinku sp. zn. PK 1 Tš 24/2006 z 11. " +
      "februára 2008";
    const citations = extractCitations([{ index: 0, text }]);
    expect(citations).toHaveLength(1);
    expect(citations[0]?.citationText).toBe("sp. zn. PK 1 Tš 24/2006");
  });

  test("extracts a Slovak numeric-chamber case number with slash-joined case/year", () => {
    // Verbatim prose quoted from a prod ústavný súd decision (SVK); the
    // Najvyšší súd chamber format space-separates the numeral from the
    // registry, unlike the no-space "1Cdo/123/2020" form.
    const text =
      "rozsudkom Najvyššieho súdu Slovenskej republiky sp. zn. 3 Sžf/84/2008 " +
      "zo 4. decembra 2008 a takto rozhodol";
    const texts = extractCitations([{ index: 0, text }]).map(
      (c) => c.citationText,
    );
    expect(texts).toContain("sp. zn. 3 Sžf/84/2008");
  });

  test("extracts a Slovak Najvyšší súd administrative case number", () => {
    // Verbatim from a prod Ústavný súd decision (I. ÚS 216/2014) quoting
    // the challenged Najvyšší súd judgment.
    const text =
      "rozsudkom Najvyššieho súdu Slovenskej republiky sp. zn. 8 Sž/14/2013 " +
      "z 21. novembra 2013";
    const citations = extractCitations([{ index: 0, text }]);
    expect(citations).toHaveLength(1);
    expect(citations[0]?.citationText).toBe("sp. zn. 8 Sž/14/2013");
  });

  test("extracts a Slovak case number with the chamber joined to the registry", () => {
    // Verbatim prose quoted from a prod Ústavný súd decision (SVK); the
    // same Krajský súd decision is cited both as "6 CoE 14/2007" (space
    // after the chamber digit) and "6CoE 14/2007" (joined) within one
    // document.
    const text =
      "Ústavný súd Slovenskej republiky zrušuje uznesenie Krajského súdu " +
      "v Košiciach sp. zn. 6CoE 14/2007 zo dňa 13. 3. 2007 a vec mu vracia";
    const texts = extractCitations([{ index: 0, text }]).map(
      (c) => c.citationText,
    );
    expect(texts).toContain("sp. zn. 6CoE 14/2007");
  });

  test("dedupes a Slovak case number written with a space against the slash form", () => {
    // Verbatim from a Slovak Supreme Court decision: the same case is
    // cited once fully spaced ("5 Cdo 260/2008") and once with the number
    // and registry attached, slash-separated ("5Cdo/260/2008"). Without
    // separator canonicalization these produced two dedup keys for one
    // real citation.
    const text =
      "rozsudok najvyššieho súdu z 10. decembra 2008 sp. zn. 5Cdo/260/2008. " +
      "Nadväzujúc na predchádzajúcu judikatúru najvyšší súd v rozsudku " +
      "konštatoval, že (rozsudok najvyššieho súdu sp. zn. 5 Cdo 260/2008).";
    const citations = extractCitations([{ index: 0, text }]);
    expect(citations).toHaveLength(1);
  });

  test("extracts Slovak case numbers with a spaced registry and a two-digit year", () => {
    // Verbatim: "33 Cb/209/2010" (spaced number, slash-attached registry)
    // and "10C/84/97" / "8Co/431/97" (attached registry, two-digit year).
    const text =
      "v konaní vedenom pod sp. zn. 33 Cb/209/2010 a takto. " +
      "vedeného Okresným súdom Nitra pod sp. zn. 10C/84/97 a Krajským " +
      "súdom v Nitre pod sp. zn. 8Co/431/97.";
    const texts = extractCitations([{ index: 0, text }]).map(
      (c) => c.citationText,
    );
    expect(texts).toContain("sp. zn. 33 Cb/209/2010");
    expect(texts).toContain("sp. zn. 10C/84/97");
    expect(texts).toContain("sp. zn. 8Co/431/97");
  });

  test("extracts Slovak registries with diacritics", () => {
    // Verbatim: "8Sžf/8/2014" (Slovak administrative court, "ž" registry
    // letter). An ASCII-only registry class silently dropped this.
    const text =
      "závery Najvyššieho súdu Slovenskej republiky uvedené v rozhodnutí " +
      "sp. zn. 8Sžf/8/2014 zo dňa 29.01.2015";
    const citations = extractCitations([{ index: 0, text }]);
    expect(citations).toHaveLength(1);
    expect(citations[0]?.citationText).toBe("sp. zn. 8Sžf/8/2014");
  });

  test("extracts Slovak case numbers with a diacritic registry or a space before it", () => {
    // Verbatim prose quoted from prod Ústavný súd / Najvyšší súd
    // decisions: the registry can carry a diacritic ("Sži") and can be
    // space-separated from the number instead of glued to it.
    const text =
      "Podľa uznesenia Najvyššieho súdu Slovenskej republiky sp. zn. " +
      "7Sži/4/2014 zo dňa 08.07.2014. Podľa uznesenia Najvyššieho súdu " +
      "Slovenskej republiky sp. zn. 2 Cdo/205/2011 zo dňa 30. 11. 2011.";
    const texts = extractCitations([{ index: 0, text }]).map(
      (c) => c.citationText,
    );
    expect(texts).toContain("sp. zn. 7Sži/4/2014");
    expect(texts).toContain("sp. zn. 2 Cdo/205/2011");
  });

  test("extracts sp. zn.: with a colon (Slovak constitutional-complaint prose)", () => {
    // Verbatim from a prod nález (SVK): "sp. zn.: 4 C 309/01".
    const text =
      "Okresný súd v Bardejove v konaní vedenom pod sp. zn.: 4 C 309/01 " +
      "porušil základné právo";
    const citations = extractCitations([{ index: 0, text }]);
    expect(citations).toHaveLength(1);
    expect(citations[0]?.citationText).toBe("sp. zn.: 4 C 309/01");
  });

  test("extracts sp. zn. with a colon and a space before the registry", () => {
    const text =
      "Okresný súd v Dolnom Kubíne v konaní vedenom pod sp. zn.: 8 Cb 58/2009 " +
      "porušil právo J. Š.";
    const citations = extractCitations([{ index: 0, text }]);
    expect(citations).toHaveLength(1);
    expect(citations[0]?.citationText).toBe("sp. zn.: 8 Cb 58/2009");
  });

  test("extracts a Slovak case number with a space before the slash-separated registry", () => {
    // Verbatim from a Slovak Constitutional Court decision: district and
    // regional courts write the registry code with a space before it and
    // a slash before the sequence number, unlike the no-space
    // "1Cdo/123/2020" form.
    const text =
      "postupmi Okresného súdu Dolný Kubín v konaní vedenom pod sp. zn. " +
      "8 Cb/58/2009 a Krajského súdu v Žiline v konaní vedenom pod sp. zn. " +
      "13 Cob/36/2010";
    const texts = extractCitations([{ index: 0, text }]).map(
      (c) => c.citationText,
    );
    expect(texts).toContain("sp. zn. 8 Cb/58/2009");
    expect(texts).toContain("sp. zn. 13 Cob/36/2010");
  });

  test("extracts Slovak no-space registry codes (post-2016 CSP reform)", () => {
    // Verbatim from a Slovak district-court decision quoting consumer-credit
    // case law under the post-2016 civil-procedure registries (Csp, CoCsp),
    // where the senate digit and registry code run together without a space.
    const text =
      "rozsudok Krajského súdu v Prešove sp. zn. 7CoCsp 16/2021, rozsudok " +
      "Okresného súdu Prešov sp.zn. 9Csp 1/2022, tiež Okresného súdu " +
      "Bardejov sp. zn. 7Csp 80/2020";
    const texts = extractCitations([{ index: 0, text }]).map(
      (c) => c.citationText,
    );
    expect(texts).toContain("sp. zn. 7CoCsp 16/2021");
    expect(texts).toContain("sp.zn. 9Csp 1/2022");
    expect(texts).toContain("sp. zn. 7Csp 80/2020");
  });

  test("extracts Slovak no-space registry codes on older registries too", () => {
    const text = "porovnaj uznesenie sp. zn. 33Cdo 2178/2018 z 25.7.2018";
    const citations = extractCitations([{ index: 0, text }]);
    expect(citations).toHaveLength(1);
    expect(citations[0]?.citationText).toBe("sp. zn. 33Cdo 2178/2018");
  });

  test("extracts sp.zn. with a colon before the case number and no space after zn", () => {
    // Verbatim: "sp.zn.: 38Csp/281/2025". Only the č. j. pattern
    // previously supported a trailing colon; sp. zn. did not.
    const text =
      "Mestský súd Košice dňa 19.11.2025 pod sp.zn.: 38Csp/281/2025, " +
      "č.l. 9 vyzval žalobcu na zaplatenie súdneho poplatku";
    const citations = extractCitations([{ index: 0, text }]);
    expect(citations).toHaveLength(1);
    expect(citations[0]?.citationText).toBe("sp.zn.: 38Csp/281/2025");
  });

  test("extracts a Slovak enforcement (exekútor) case number", () => {
    // Verbatim: "sp.zn. 236EX 687/24" -- chamber number attached to the
    // registry code, then a spaced two-digit-year docket.
    const text = "vedenej súdnym exekútorom pod sp.zn. 236EX 687/24, takto";
    const citations = extractCitations([{ index: 0, text }]);
    expect(citations).toHaveLength(1);
    expect(citations[0]?.citationText).toBe("sp.zn. 236EX 687/24");
  });

  test("extracts a Slovak enforcement (exekúcia) case number glued to its digit", () => {
    // Verbatim from a prod decision: the enforcement court's own case
    // number ("233EX 464/23") has no space between the senate digit and
    // the "EX" registry letter.
    const text =
      "IČO: 31 810 098, pod sp. zn. 233EX 464/23, o návrhu povinného " +
      "na zastavenie exekúcie";
    const citations = extractCitations([{ index: 0, text }]);
    expect(citations).toHaveLength(1);
    expect(citations[0]?.citationText).toBe("sp. zn. 233EX 464/23");
  });

  test("extracts a Slovak exekútor compound file number", () => {
    // Verbatim from a prod Okresný súd Banská Bystrica decision.
    const text =
      "vedenej u súdneho exekútora, ktorý ju vedie pod sp. zn. 242EX 508/25.";
    const citations = extractCitations([{ index: 0, text }]);
    expect(citations).toHaveLength(1);
    expect(citations[0]?.citationText).toBe("sp. zn. 242EX 508/25");
  });

  test("extracts a Slovak slash-form case number with either spelling", () => {
    // Verbatim from a prod decision citing the same case twice: once
    // glued with no period after "zn" ("sp. zn 5Obdo/23/2016") and once
    // with a period and a space before the registry ("sp. zn. 5 Obdo/23/2016").
    const glued = "šieho súdu Slovenskej republiky sp. zn 5Obdo/23/2016.";
    const spaced =
      "eho súdu Slovenskej republiky sp. zn. 5 Obdo/23/2016 žalovaný uviedol";
    expect(extractCitations([{ index: 0, text: glued }])[0]?.citationText).toBe(
      "sp. zn 5Obdo/23/2016",
    );
    expect(
      extractCitations([{ index: 0, text: spaced }])[0]?.citationText,
    ).toBe("sp. zn. 5 Obdo/23/2016");
  });

  test("extracts a Slovak two-slash case number with a two-digit year", () => {
    // Verbatim prose quoted from a prod Slovak Constitutional Court
    // decision: pre-2000s decisions in the two-slash form use a
    // two-digit year, which a four-digit-only year previously rejected.
    const text =
      "vo veci vedenej na Okresnom súde Košice II pod sp. zn. 22 C/26/04. " +
      "Dňa 6. 3. 2006 súd vyzval navrhovateľa";
    const citations = extractCitations([{ index: 0, text }]);
    expect(citations).toHaveLength(1);
    expect(citations[0]?.citationText).toBe("sp. zn. 22 C/26/04");
  });

  test("extracts Slovak č. k. file numbers (číslo konania)", () => {
    // Verbatim prose quoted from a prod Slovak Constitutional Court
    // decision: Slovak courts cite their own file number as "č. k.", the
    // counterpart to the Czech "č. j.". Without a dedicated pattern, a
    // decision known only by its č. k. had no citation extracted at all.
    const text =
      "rozsudkom Najvyššieho súdu Slovenskej republiky č. k. 4 Obo 48/02-260 " +
      "z 27. februára 2003";
    const citations = extractCitations([{ index: 0, text }]);
    expect(citations).toHaveLength(1);
    expect(citations[0]?.citationText).toBe("č. k. 4 Obo 48/02");
    expect(
      isSelfCitation(
        "č. k. 4 Obo 48/02",
        decisionIdentifiersFromMetadata({ caseNumber: "4 Obo 48/02" }),
      ),
    ).toBe(true);
  });

  test("does not let a soft-hyphen page suffix corrupt the case number", () => {
    // Verbatim artifact seen in the corpus: a soft hyphen (U+00AD)
    // standing in for the page-number dash ("2010­370" instead of
    // "2010-370"). It must not leak into the extracted case number.
    const text =
      "Rozsudkom č. k. sp. zn. 33 Cb/209/2010­370 z 25. marca 2014 okresný súd";
    const citations = extractCitations([{ index: 0, text }]);
    expect(citations).toHaveLength(1);
    expect(citations[0]?.citationText).toBe("sp. zn. 33 Cb/209/2010");
  });

  test("dedupes a case number containing a non-breaking space", () => {
    // A non-breaking space (U+00A0) between tokens, as PDF extraction
    // sometimes produces, must dedupe against the plain-space spelling.
    const nbspText = "sp. zn. 21 Cdo 1234/2020";
    const plainText = "sp. zn. 21 Cdo 1234/2020";

    const combined = extractCitations([
      { index: 0, text: nbspText },
      { index: 1, text: plainText },
    ]);
    expect(combined).toHaveLength(1);
  });

  test("dedupes the same case number in differing registry letter case", () => {
    // The registry code's own letter case can vary between an all-caps
    // header citation and an ordinary mixed-case body citation; both must
    // resolve to one dedup key. The "sp. zn." prefix literal itself stays
    // lowercase in both mentions -- the prefix matcher is intentionally
    // case-sensitive, so an all-caps "SP. ZN." header is never extracted
    // in the first place, which would make a dedup assertion here
    // vacuous (it would pass merely because only one mention is ever
    // found). Each mention is checked in isolation first to prove the
    // dedup claim below is not vacuous.
    const header = { index: 0, text: "sp. zn. 21 CDO 1234/2020" };
    const body = {
      index: 1,
      text: "Soud se odchýlil od sp. zn. 21 Cdo 1234/2020 a rozhodl jinak.",
    };
    expect(extractCitations([header])).toHaveLength(1);
    expect(extractCitations([body])).toHaveLength(1);

    const combined = extractCitations([header, body]);
    expect(combined).toHaveLength(1);
    expect(combined[0]?.sectionIndex).toBe(1);
  });

  test("dedupes a case number split across a line wrap", () => {
    // PDF-to-text extraction sometimes wraps a case number across a line
    // break, landing a newline where the source has a plain space. The
    // dedup key must not treat that as a different case number.
    const text =
      "Rozsudek Nejvyššího soudu sp. zn. 21 Cdo 1234/2020 uvedl, že ... " +
      "Později bylo rozhodnutí, sp. zn. 21\nCdo 1234/2020, citováno znovu.";
    const citations = extractCitations([{ index: 0, text }]);
    expect(citations).toHaveLength(1);
  });

  test("matches and dedupes a case number wrapped across a Windows-style CRLF", () => {
    // A CRLF line-wrap ("\r\n") lands two whitespace characters where the
    // source normally has one space or none at all. The shared
    // Czech/Slovak case-number body must still match across the CRLF, and
    // the CRLF-wrapped mention must dedupe against a clean re-quote of the
    // same case elsewhere in the document.
    const text =
      "Rozsudek Nejvyššího soudu sp. zn. 21\r\nCdo 1234/2020 uvedl, že ... " +
      "Později bylo rozhodnutí, sp. zn. 21 Cdo 1234/2020, citováno znovu.";
    const citations = extractCitations([{ index: 0, text }]);
    expect(citations).toHaveLength(1);
  });

  test("extracts the abbreviated ECLI suffix CJEU judgments actually use", () => {
    // Verbatim from a prod EU-jurisdiction judgment: CJEU prose cites its
    // own case-law as "<case>, EU:C:<year>:<number>", never spelling out
    // the literal "ECLI:" prefix that only appears in database identifiers.
    const text =
      "judgments of 11 November 1981, IBM v Commission, 60/81, " +
      "EU:C:1981:264, paragraph 9; of 22 June 2000, Netherlands v " +
      "Commission, C‑147/96, EU:C:2000:335, paragraph 27";
    const texts = extractCitations([{ index: 0, text }]).map(
      (c) => c.citationText,
    );
    expect(texts).toContain("EU:C:1981:264");
    expect(texts).toContain("EU:C:2000:335");
    expect(texts).toContain("C‑147/96");
  });

  test("does not double-extract a full CJEU ECLI as also its own abbreviated suffix", () => {
    // The CJEU's own ECLI country code is "EU" ("ECLI:EU:C:2020:123"), so
    // without a negative lookbehind the abbreviated EU:C:YYYY:NNN pattern
    // would also match the tail of a full ECLI already captured by the
    // dedicated ECLI pattern, producing two entries for one identifier.
    const text = "ve smyslu ECLI:EU:C:2020:123 Soudní dvůr rozhodl";
    const citations = extractCitations([{ index: 0, text }]);
    expect(citations).toHaveLength(1);
    expect(citations[0]?.citationText).toBe("ECLI:EU:C:2020:123");
  });

  test("extracts an ECLI whose court code carries a court number", () => {
    // Verbatim from a prod Slovak decision header, minus the judge field.
    // Slovak cities with several courts of one kind number them, and the
    // number belongs to the ECLI court code ("OSKE3" is Okresný súd
    // Košice-okolie), so a letters-only code class matches no numbered
    // court at all. The pipeline drops this one as a self-citation, which
    // is the point: the same spelling is what other decisions cite it by.
    const text =
      "Súd: Okresný súd Košice okolie Spisová značka: 17C/111/2013 " +
      "Identifikačné číslo súdneho spisu: 7513207505 Dátum vydania " +
      "rozhodnutia: 11. 08. 2014 ECLI: ECLI:SK:OSKE3:2014:7513207505.1 " +
      "ROZSUDOK V MENE SLOVENSKEJ REPUBLIKY";
    const texts = extractCitations([{ index: 0, text }]).map(
      (c) => c.citationText,
    );
    expect(texts).toContain("ECLI:SK:OSKE3:2014:7513207505.1");
  });

  test("extracts a pre-1989 bare CJEU case number anchored by its ECLI", () => {
    // Verbatim, Hungarian: pre-1989 CJEU numbers carry no C-/T- prefix
    // (the Court introduced it in 1989), so "14/83" is only safe to
    // capture because the ECLI suffix immediately follows it.
    const text =
      "1984. április 10‑i von Colson és Kamann ítélet, 14/83, " +
      "EU:C:1984:153, 15. pont";
    const texts = extractCitations([{ index: 0, text }]).map(
      (c) => c.citationText,
    );
    expect(texts).toContain("14/83");
    expect(texts).toContain("EU:C:1984:153");
  });

  test("extracts both numbers of a bare joined-cases citation", () => {
    // Verbatim, English: "France v Commission" joined-cases citation to
    // two pre-1989 bare numbers, both anchored by the trailing ECLI.
    const text =
      "judgments of 7 February 1979, France v Commission, 15/76 and " +
      "16/76, EU:C:1979:29, paragraphs 7 and 8";
    const texts = extractCitations([{ index: 0, text }]).map(
      (c) => c.citationText,
    );
    expect(texts).toContain("15/76");
    expect(texts).toContain("16/76");
    expect(texts).toContain("EU:C:1979:29");
  });

  test("extracts both numbers of a Portuguese 'e'-joined bare citation", () => {
    // Verbatim, Portuguese: "Leussink/Comissão" joined-cases citation.
    const text =
      "tábua rasa dos ensinamentos do Acórdão de 8 de outubro de 1986, " +
      "Leussink/Comissão (169/83 e 136/84, EU:C:1986:371) ao considerar";
    const texts = extractCitations([{ index: 0, text }]).map(
      (c) => c.citationText,
    );
    expect(texts).toContain("169/83");
    expect(texts).toContain("136/84");
    expect(texts).toContain("EU:C:1986:371");
  });

  test("does not re-extract the bare tail of an already-prefixed CJEU number", () => {
    // Verbatim, Portuguese: the bare-number pattern must not also match
    // "48/05" out of "T‑48/05" just because an ECLI follows.
    const text =
      "que deu origem ao Acórdão de 8 de julho de 2008, Franchet e " +
      "Byk/Comissão (T‑48/05, EU:T:2008:257).";
    const texts = extractCitations([{ index: 0, text }]).map(
      (c) => c.citationText,
    );
    expect(texts).toContain("T‑48/05");
    expect(texts).toContain("EU:T:2008:257");
    expect(texts).not.toContain("48/05");
  });

  test("does not treat a directive or report number as a bare CJEU citation", () => {
    // Verbatim shapes from EUR-Lex prose: a Council directive number
    // ("65/65/EEC") and a Court of Auditors report number ("1/96") share
    // the bare N/YY shape with a pre-1989 case number but are never
    // followed by an ECLI, so neither must be captured.
    const texts = [
      "Directiva 98/30/CE (DO 2003, L 176, p. 57)",
      "rapport spécial n° 1/96 de la Cour des comptes",
      "direktiivin 65/65/ETY 7 artiklassa",
    ];
    for (const text of texts) {
      expect(extractCitations([{ index: 0, text }])).toHaveLength(0);
    }
  });

  test("extracts an unprefixed Polish case number", () => {
    const citations = extractCitations([
      { index: 0, text: "Por. wyrok II CSK 123/20 oraz II ACa 45/20." },
    ]);
    const texts = citations.map((c) => c.citationText);
    expect(texts).toContain("II CSK 123/20");
    expect(texts).toContain("II ACa 45/20");
  });

  test("extracts an unprefixed Polish case number with a single-letter chamber", () => {
    // Verbatim from a prod Supreme Court decision: Sąd Najwyższy's civil
    // chamber is numbered "I", not just "II"/"III".
    const text =
      "uchwały Sądu Najwyższego z 14 marca 1996 r. (I PZ 32/95, OSNP 1997/4/48)";
    const citations = extractCitations([{ index: 0, text }]);
    expect(citations).toHaveLength(1);
    expect(citations[0]?.citationText).toBe("I PZ 32/95");
  });

  test("extracts a bare Supreme Court citation with a single-character division", () => {
    // Verbatim prose citing a Supreme Court decision by its own case
    // number, no "sygn. akt" prefix. Chamber I is a single Roman digit.
    const text =
      "W wyroku z dnia 20 maja 2008 r. I CSK 379/08 (OSNC 2009/12/172) " +
      "Sąd Najwyższy stwierdził, że";
    const citations = extractCitations([{ index: 0, text }]);
    expect(citations).toHaveLength(1);
    expect(citations[0]?.citationText).toBe("I CSK 379/08");
  });

  test("extracts a Polish joined division+registry case number", () => {
    // Verbatim prose from a District Court decision: "sygn. akt IC 326/13"
    // joins the division (I) and the single-letter civil registry (C)
    // with no space.
    const text =
      "od wyroku Sądu Rejonowego w Kaliszu z dnia 23 lipca 2013r. " +
      "sygn. akt IC 326/13\n\noddala apelację.";
    const citations = extractCitations([{ index: 0, text }]);
    expect(citations).toHaveLength(1);
    expect(citations[0]?.citationText).toBe("sygn. akt IC 326/13");
  });

  test("extracts a Polish case number with a joined roman numeral and division letter", () => {
    // Verbatim prose quoted from a prod decision (POL).
    const text =
      "od wyroku Sądu Okręgowego w Szczecinie z dnia 24 września 2013 r., " +
      "sygn. akt IC 171/12 uchyla zaskarżony wyrok";
    const citations = extractCitations([{ index: 0, text }]);
    expect(citations).toHaveLength(1);
    expect(citations[0]?.citationText).toBe("sygn. akt IC 171/12");
  });

  test("extracts a Polish citation with the roman numeral glued to the code", () => {
    // Verbatim from a prod decision citing two cases where the roman
    // numeral is glued straight to the division code: "IC 1523/96" and
    // "IA Ca 835/97" (rather than "I C 1523/96", "I A Ca 835/97").
    const glued = "wyrokiem z 4 listopada 1997 r., sygn. akt IC 1523/96 i Sąd";
    const gluedTwoWord =
      "wyrokiem z 25 lutego 1998 r., sygn. akt IA Ca 835/97, oddaliły roszczenie";
    expect(extractCitations([{ index: 0, text: glued }])[0]?.citationText).toBe(
      "sygn. akt IC 1523/96",
    );
    expect(
      extractCitations([{ index: 0, text: gluedTwoWord }])[0]?.citationText,
    ).toBe("sygn. akt IA Ca 835/97");
  });

  test("dedupes a Polish case number cited both glued and spaced", () => {
    // The same civil-division case is cited once with the roman numeral
    // glued to the registry letter ("IC 1523/96") and once spaced ("I C
    // 1523/96") elsewhere in the same document; the dedup key must
    // normalize the roman-to-registry boundary so both resolve to one
    // citation.
    const citations = extractCitations([
      {
        index: 0,
        text:
          "wyrokiem z 4 listopada 1997 r., sygn. akt IC 1523/96 i Sąd " +
          "ponownie powołał się na sygn. akt I C 1523/96 w uzasadnieniu",
      },
    ]);
    expect(citations).toHaveLength(1);
  });

  test("extracts Polish sygn. akt with a no-space roman-numeral/division compound", () => {
    // Verbatim from prod decisions: "sygn. akt IC 1163/11" (civil
    // division) and "sygn. akt XU 740/06" (labor/social-insurance
    // division), both typeset without a space between the chamber roman
    // numeral and the division letters.
    const texts = extractCitations([
      {
        index: 0,
        text: "wyroku Sądu Okręgowego w Warszawie, sygn. akt IC 1163/11:",
      },
    ])
      .concat(
        extractCitations([
          {
            index: 0,
            text: "wyrokiem z dnia 10.05.2007r., sygn. akt XU 740/06",
          },
        ]),
      )
      .map((c) => c.citationText);
    expect(texts).toContain("sygn. akt IC 1163/11");
    expect(texts).toContain("sygn. akt XU 740/06");
  });

  test("extracts Polish Roman-numeral chamber attached to the division code", () => {
    // Verbatim: "sygn. akt XP 3615/05" (X Wydział Pracy) and "sygn. akt
    // VK 145/13" -- Roman numeral and division letter written with no
    // space, which the prefixed pattern always required before.
    const text =
      "Sąd Pracy (sygn. akt XP 3615/05) oddalił powództwo. " +
      "w sprawie o sygn. akt VK 145/13, oskarżony";
    const texts = extractCitations([{ index: 0, text }]).map(
      (c) => c.citationText,
    );
    expect(texts).toContain("sygn. akt XP 3615/05");
    expect(texts).toContain("sygn. akt VK 145/13");
  });

  test("extracts a Polish Roman numeral longer than four characters", () => {
    // Verbatim: "sygn. akt XVIII K 288/11" (18th division). The
    // Roman-numeral bound was capped at four characters, too short for
    // "XVIII".
    const text =
      "Świadek ten był najistotniejszym świadkiem w sprawie toczącej się " +
      "przed Sądem Okręgowym w Warszawie o sygn. XVIII K 288/11, gdzie";
    const citations = extractCitations([{ index: 0, text }]);
    expect(citations).toHaveLength(1);
    expect(citations[0]?.citationText).toBe("sygn. XVIII K 288/11");
  });

  test("extracts Polish division codes glued to the Roman numeral", () => {
    // Verbatim prose quoted from a prod Sąd Okręgowy decision: the
    // labor/social-insurance division "U" is typeset directly against the
    // Roman numeral, with no space.
    const text =
      "Sąd zarządził połączenie spraw IIIU 860/12 i IIIU 1113/13 do " +
      "wspólnego rozpoznania i rozstrzygnięcia pod sygn. IIIU 860/12.";
    const texts = extractCitations([{ index: 0, text }]).map(
      (c) => c.citationText,
    );
    // "IIIU 860/12" is cited both bare and with "sygn."; the prefixed
    // form wins dedup, but both patterns must match the glued division
    // code for either to be recorded at all.
    expect(texts).toContain("sygn. IIIU 860/12");
    expect(texts).toContain("IIIU 1113/13");
  });

  test("extracts a Polish two-word division code with an internal space", () => {
    // Verbatim from a prod decision citing the same appellate-labor case
    // under two spellings: space-joined ("A Ua") and merged ("AUa").
    const spaced =
      "Sądu Apelacyjnego we Wrocławiu z 7 listopada 2003 r., sygn. akt " +
      "III A Ua 2389/02";
    const merged =
      "podniesione w wyroku z 31 października 2006 r. (sygn. akt III AUa 2296/05)";
    expect(
      extractCitations([{ index: 0, text: spaced }])[0]?.citationText,
    ).toBe("sygn. akt III A Ua 2389/02");
    expect(
      extractCitations([{ index: 0, text: merged }])[0]?.citationText,
    ).toBe("sygn. akt III AUa 2296/05");
  });

  test("dedupes a Polish two-word division code cited both spaced and merged", () => {
    // The same appellate-labor case is cited once with the two-word
    // division spaced ("A Ua") and once merged ("AUa") elsewhere in the
    // document; the dedup key must normalize the internal division
    // boundary the same way it does for the roman-to-registry boundary.
    const citations = extractCitations([
      {
        index: 0,
        text:
          "Sądu Apelacyjnego we Wrocławiu z 7 listopada 2003 r., sygn. akt " +
          "III A Ua 2389/02, ponownie sygn. akt III AUa 2389/02 w uzasadnieniu",
      },
    ]);
    expect(citations).toHaveLength(1);
  });

  test("matches a two-token division split by a double space or line wrap", () => {
    // The gap between the two division tokens ("A" and "Ua") is a bounded
    // whitespace/slash run, not a single character, so a double space or
    // a line-wrap still matches, mirroring the bound already used for the
    // shared Czech/Slovak case-number body.
    const doubleSpace =
      "Sądu Apelacyjnego we Wrocławiu z 7 listopada 2003 r., sygn. akt " +
      "III A  Ua 2389/02";
    const lineWrap =
      "Sądu Apelacyjnego we Wrocławiu z 7 listopada 2003 r., sygn. akt " +
      "III A\nUa 2389/02";
    expect(extractCitations([{ index: 0, text: doubleSpace }])).toHaveLength(1);
    expect(extractCitations([{ index: 0, text: lineWrap }])).toHaveLength(1);
  });

  test("dedupes a Polish two-word division code across every accepted separator spelling", () => {
    // "III A Ua 2389/02" (spaced), "III AUa 2389/02" (merged), and
    // "III A/Ua 2389/02" (slash-joined, which the matcher's division-gap
    // class already accepts) all name the same case; the canonicalizer
    // must fold every accepted separator spelling to one key.
    const citations = extractCitations([
      {
        index: 0,
        text:
          "Sądu Apelacyjnego we Wrocławiu z 7 listopada 2003 r., sygn. akt " +
          "III A Ua 2389/02, ponownie sygn. akt III AUa 2389/02, oraz " +
          "sygn. akt III A/Ua 2389/02 w uzasadnieniu",
      },
    ]);
    expect(citations).toHaveLength(1);
  });

  test("extracts Polish fused division+department case numbers", () => {
    // Verbatim prose quoted from a prod Polish labour-court decision:
    // "X Wydział Pracy" (10th labour division) case numbers fuse the
    // division numeral and department letter with no separating space
    // ("XP"), unlike the spaced Polish chamber codes ("II CSK") already
    // covered.
    const text =
      "od wyroku Sądu Rejonowego dla Wrocławia-Śródmieścia X Wydział Pracy " +
      "i Ubezpieczeń Społecznych z dnia 11 września 2013 r. sygn. akt XP 1054/12";
    const citations = extractCitations([{ index: 0, text }]);
    expect(citations).toHaveLength(1);
    expect(citations[0]?.citationText).toBe("sygn. akt XP 1054/12");
  });

  test("extracts Polish fused division codes with a colon after 'akt'", () => {
    // Verbatim prose quoted from a prod Polish appellate decision: "sygn.
    // akt: IC 119/13" fuses the roman division numeral to the department
    // letter and additionally punctuates "akt" with a colon.
    const text =
      "na postanowienie Sądu Rejonowego w Świeciu z dnia 18 lipca 2013 r., " +
      "sygn. akt: IC 119/13";
    const citations = extractCitations([{ index: 0, text }]);
    expect(citations).toHaveLength(1);
    expect(citations[0]?.citationText).toBe("sygn. akt: IC 119/13");
  });

  test("extracts a Polish fused division code with a colon and a glued case number", () => {
    // Verbatim from a prod Sąd Najwyższy / Sąd Rejonowy labor decision:
    // "sygn. akt: IV P648/03" where the division letter "P" runs directly
    // into the case number with no space.
    const texts = extractCitations([
      { index: 0, text: "postępowanie karne, pod sygn. akt: II K 372/02." },
    ])
      .concat(
        extractCitations([
          {
            index: 0,
            text: "uchylony przez Sąd Najwyższy, sygn. akt: I PK 107/02",
          },
        ]),
      )
      .concat(
        extractCitations([
          {
            index: 0,
            text: "wyrok z 2001 r. sygn. akt: IV P648/03 został uchylony",
          },
        ]),
      )
      .map((c) => c.citationText);
    expect(texts).toContain("sygn. akt: II K 372/02");
    expect(texts).toContain("sygn. akt: I PK 107/02");
    expect(texts).toContain("sygn. akt: IV P648/03");
  });

  test("dedupes a Polish citation cited with the division glued and spaced to the docket", () => {
    // "sygn. akt: IV P648/03" (division letter glued directly to the
    // docket digits) and "sygn. akt IV P 648/03" (spaced) name the same
    // case; the dedup key must fold the division-to-docket boundary the
    // same way it already folds the roman-to-division boundary.
    const citations = extractCitations([
      {
        index: 0,
        text:
          "wyrok z 2001 r. sygn. akt: IV P648/03 został uchylony, " +
          "ponownie sygn. akt IV P 648/03 w uzasadnieniu",
      },
    ]);
    expect(citations).toHaveLength(1);
  });

  test("extracts a Polish administrative-court case number with a city code", () => {
    // Verbatim from a prod decision: Wojewódzki Sąd Administracyjny case
    // numbers join the court and city codes with a slash ("SA/Wa").
    const text =
      "ździernika 2006 r. (sygn. akt VI SA/Wa 1161/06) oraz w wyroku";
    const citations = extractCitations([{ index: 0, text }]);
    expect(citations).toHaveLength(1);
    expect(citations[0]?.citationText).toBe("sygn. akt VI SA/Wa 1161/06");
  });

  test("extracts NSA/WSA slash-registry citations", () => {
    // Verbatim prose citing Voivodeship Administrative Court decisions:
    // the registry joins the court type and location with a slash
    // ("SA/Wa" = WSA Warszawa).
    const text =
      "wyrok Wojewódzkiego Sądu Administracyjnego w Warszawie z dnia 13 " +
      "czerwca 2006 r., II SA/Wa 2016/05, Lex nr 219349 oraz z dnia 2 " +
      "października 2003 r. (sygn. akt SA/Po 4584/01)";
    const texts = extractCitations([{ index: 0, text }]).map(
      (c) => c.citationText,
    );
    expect(texts).toContain("II SA/Wa 2016/05");
    expect(texts).toContain("sygn. akt SA/Po 4584/01");
  });

  test("extracts an NSA/WSA citation with a non-ASCII location code", () => {
    // "SA/Łd" (WSA Łódź) contains "Ł", outside the ASCII-only [A-Za-z]
    // class the location-code alternation previously used.
    const text =
      "wyrok Wojewódzkiego Sądu Administracyjnego w Łodzi, II SA/Łd 123/20";
    const citations = extractCitations([{ index: 0, text }]);
    expect(citations).toHaveLength(1);
    expect(citations[0]?.citationText).toBe("II SA/Łd 123/20");
  });

  test("extracts Polish administrative-court citations in their cited forms", () => {
    const cases: [text: string, expected: string[]][] = [
      [
        "wyrok NSA z dnia 12 czerwca 2024 r., sygn. akt II FSK 1226/21",
        ["sygn. akt II FSK 1226/21"],
      ],
      [
        "wyrok WSA w Warszawie z 10.03.2020 r., III SA/Wa 1234/19",
        ["III SA/Wa 1234/19"],
      ],
      [
        "uchwała składu siedmiu sędziów NSA z dnia 5 czerwca 2017 r., II GPS 1/17",
        ["II GPS 1/17"],
      ],
      [
        "por. II SAB/Wa 11/04, II SPP/Wa 1/20 oraz I SO/Kr 3/21",
        ["II SAB/Wa 11/04", "II SPP/Wa 1/20", "I SO/Kr 3/21"],
      ],
      [
        "uchwały z 1999 r., FPS 1/99, i z 1998 r., OPS 3/98, a także OPK 1/97",
        ["FPS 1/99", "OPS 3/98", "OPK 1/97"],
      ],
      // A divided resolution mark is one citation, not also its bare tail.
      ["uchwała NSA, I OPS 3/22", ["I OPS 3/22"]],
      // Pre-2004 forms: the `Ł` seat, a joined range, a glued division.
      ["wyrok NSA z 1998 r., SA/Ł 1234/98", ["SA/Ł 1234/98"]],
      [
        "wyrok NSA, sygn. akt I SA 1234-1236/98",
        ["sygn. akt I SA 1234-1236/98"],
      ],
      ["wyrok NSA, IISA/WR 12/01", ["IISA/WR 12/01"]],
      // A leading register number is not part of the docket.
      ["akta 12/II SA/Po 1234/99", ["II SA/Po 1234/99"]],
      // Transitional forms: a seatless range, a division-less NSA mark.
      ["wyrok WSA, IV SA 123-125/04", ["IV SA 123-125/04"]],
      ["postanowienie NSA, sygn. akt FSK 123/04", ["sygn. akt FSK 123/04"]],
      ["uchwały NSA z 1998 r., OPK 12-14/98", ["OPK 12-14/98"]],
    ];
    for (const [text, expected] of cases) {
      expect(
        extractCitations([{ index: 0, text }]).map((c) => c.citationText),
      ).toEqual(expected);
    }
  });

  test("does not read common prose or unknown seats as administrative dockets", () => {
    for (const text of [
      // A welfare office's letters, a bare mark after the reform, a
      // three-digit number: none is a pre-2004 resolution.
      "pismo MOPS 12/99 oraz OPS 3/05 i OPS 123/98",
      // No administrative court sits at `Xy`.
      "sprawa SA/Xy 12/20",
      // A company name ending in `SA`, with no `sygn.` label.
      "umowa z Bank Polski SA 12/99",
    ]) {
      expect(extractCitations([{ index: 0, text }])).toEqual([]);
    }
  });

  test("keys a non-ASCII seat the way it keys an ASCII one", () => {
    expect(bareCitationKey("sygn. akt II SA/Łd 123/20")).toBe(
      bareCitationKey("II SA / Łd 123/20"),
    );
    expect(bareCitationKey("II SA/Łd 123/20")).toBe("iisałd 123/20");
    expect(bareCitationKey("II SA/Wa 123/20")).toBe("iisawa 123/20");
  });

  test("keys administrative-court spelling variants as one docket", () => {
    const cases: [variant: string, canonical: string][] = [
      ["IISA/WR 12/01", "II SA/Wr 12/01"],
      ["12/II SA/Po 1234/99", "II SA/Po 1234/99"],
      ["I SA 1234–1236/98", "I SA 1234-1236/98"],
      ["SA/Ł 1234/98", "SA / Ł 1234/98"],
    ];
    for (const [variant, canonical] of cases) {
      expect(bareCitationKey(variant)).toBe(bareCitationKey(canonical));
    }
    // A range is one docket, not its first number.
    expect(bareCitationKey("I SA 1234-1236/98")).not.toBe(
      bareCitationKey("I SA 1234/98"),
    );
    // A leading number stays where no administrative docket follows it.
    expect(bareCitationKey("12/II C 1/20")).not.toBe(
      bareCitationKey("II C 1/20"),
    );
  });

  test("extracts Polish division + proceeding-type case numbers", () => {
    // Verbatim prose quoted from a prod Polish district-court decision:
    // "GNc upr" is a two-word chamber-plus-proceeding-type code (commercial
    // writ-of-payment proceedings), which single-token patterns cannot
    // capture.
    const text =
      "od nakazu zapłaty w postępowaniu upominawczym Sądu Rejonowego w " +
      "Jeleniej Górze z dnia 10.06.2013r. sygn. akt V GNc upr 936/13, " +
      "który utracił moc w całości";
    const citations = extractCitations([{ index: 0, text }]);
    expect(citations).toHaveLength(1);
    expect(citations[0]?.citationText).toBe("sygn. akt V GNc upr 936/13");
  });

  test("extracts a Polish sygn. akt citation with a colon after akt", () => {
    // Verbatim prose quoted from a prod decision (POL): "sygn. akt:" with
    // a colon, not just "sygn. akt " with a space.
    const text =
      "powołując się na wyrok Sądu Okręgowego w Warszawie z dnia 10 grudnia " +
      "2002 r. (sygn. akt: V Ca 1514/02)";
    const citations = extractCitations([{ index: 0, text }]);
    expect(citations).toHaveLength(1);
    expect(citations[0]?.citationText).toBe("sygn. akt: V Ca 1514/02");
  });

  test("extracts sygn. akt with a colon (Polish)", () => {
    const text =
      "wyrok Sądu Apelacyjnego w Katowicach z dnia 17.12.2007 r., " +
      "sygn. akt: V ACa 483/08.";
    const citations = extractCitations([{ index: 0, text }]);
    expect(citations).toHaveLength(1);
    expect(citations[0]?.citationText).toBe("sygn. akt: V ACa 483/08");
  });

  test("extracts sygn. akt with a colon (NSA)", () => {
    const text =
      "w postanowieniu z dnia 9 października 2007 r. (sygn. akt: I FSK 1261/07; " +
      "LEX nr 440637) uznał, że";
    const citations = extractCitations([{ index: 0, text }]);
    expect(citations).toHaveLength(1);
    expect(citations[0]?.citationText).toBe("sygn. akt: I FSK 1261/07");
  });

  test("extracts a Polish sygn. akt citation with a period after akt", () => {
    // Verbatim prose quoted from a prod decision (POL): "sygn. akt." with
    // a trailing period.
    const text =
      "skazanym wyrokiem Sądu Rejonowego w Oławie z dnia 17 grudnia 2008 r., " +
      "sygn. akt. II K 145/08 za czyn z art. 13 § 1 k.k.";
    const citations = extractCitations([{ index: 0, text }]);
    expect(citations).toHaveLength(1);
    expect(citations[0]?.citationText).toBe("sygn. akt. II K 145/08");
  });

  test("extracts a Polish citation with a dot after 'akt' and a single-letter division", () => {
    // Verbatim prose quoted from a prod Sąd Okręgowy decision: "akt"
    // itself carries a trailing dot, and the division is a single Roman
    // numeral ("V").
    const text =
      "wskazane orzeczenie (sygn. akt. V Ca 222/03). Odwołujący " +
      "argumentował, że jego stanowisko znajduje pełne";
    const citations = extractCitations([{ index: 0, text }]);
    expect(citations).toHaveLength(1);
    expect(citations[0]?.citationText).toBe("sygn. akt. V Ca 222/03");
  });

  test("extracts Polish sygn. akt. with a trailing dot before the case number", () => {
    // Verbatim from a prod Sąd Apelacyjny decision: "sygn. akt. II S 2/13"
    // and "sygn. akt. I FPP 1/13" both use "akt." (with a dot).
    const texts = extractCitations([
      {
        index: 0,
        text: "tak SA we Wrocławiu w postanowieniu sygn. akt. II S 2/13",
      },
    ])
      .concat(
        extractCitations([
          { index: 0, text: "w sprawie sygn. akt. I FPP 1/13" },
        ]),
      )
      .map((c) => c.citationText);
    expect(texts).toContain("sygn. akt. II S 2/13");
    expect(texts).toContain("sygn. akt. I FPP 1/13");
  });

  test("extracts a Polish citation with a capitalized 'Akt'", () => {
    // Verbatim from a prod decision: "sygn. Akt X Ga 109/05/P1" (the
    // trailing "/P1" sub-index is not part of the case number).
    const text = "iwicach z 10.06.2005 r. sygn. Akt X Ga 109/05/P1, Wyrok";
    const citations = extractCitations([{ index: 0, text }]);
    expect(citations).toHaveLength(1);
    expect(citations[0]?.citationText).toBe("sygn. Akt X Ga 109/05");
  });

  test("keeps the raw line-wrap newline in the stored citation text", () => {
    // citationText is stored verbatim so exact-passage anchoring can find
    // it in the source document; the embedded newline from the line-wrap
    // must survive, even though the dedup key (see the next test) still
    // collapses it against a clean re-quote of the same case.
    const text = "sygn.\nakt III CZP 55/84";
    const citations = extractCitations([{ index: 0, text }]);
    expect(citations).toHaveLength(1);
    expect(citations[0]?.citationText).toBe("sygn.\nakt III CZP 55/84");
  });

  test("dedupes a line-wrapped citation against a clean re-quote of the same case", () => {
    const citations = extractCitations([
      {
        index: 0,
        text:
          "por. uchwałę Sądu najwyższego, sygn.\nakt III CZP 55/84 " +
          "oraz ponownie sygn. akt III CZP 55/84 w uzasadnieniu",
      },
    ]);
    expect(citations).toHaveLength(1);
  });

  test("keeps a line-wrapped citation's raw newline verbatim", () => {
    // Verbatim from a prod decision where the case number wraps onto the
    // next line ("sygn. akt\nIV U 120/13"); the stored citation text is
    // the exact source spelling, newline included, so it remains
    // source-locatable for exact-passage anchoring.
    const text =
      "wydanym w sprawie o sygn. akt\nIV U 120/13 Sąd Rejonowy – Sąd Pracy";
    const citations = extractCitations([{ index: 0, text }]);
    expect(citations).toHaveLength(1);
    expect(citations[0]?.citationText).toBe("sygn. akt\nIV U 120/13");
  });

  test("extracts a Polish Constitutional Tribunal case number", () => {
    // Verbatim prose quoted from a prod decision (POL): the Trybunał
    // Konstytucyjny registry ("K" for abstract review) has no
    // roman-numeral panel prefix, unlike ordinary court division codes.
    const text =
      "wniosku Rzecznika Praw Obywatelskich o stwierdzenie konstytucyjności " +
      "niektórych przepisów ustawy (sygn. akt K 20/03)";
    const citations = extractCitations([{ index: 0, text }]);
    expect(citations).toHaveLength(1);
    expect(citations[0]?.citationText).toBe("sygn. akt K 20/03");
  });

  test("extracts Polish Constitutional Tribunal case numbers", () => {
    // Verbatim prose quoted from a prod TK postanowienie citing its own
    // prior case law.
    const texts = extractCitations([
      {
        index: 0,
        text: "postanowieniu z 20 listopada 2008 r., sygn. P 18/08 (OTK ZU nr 9/A/2008)",
      },
    ])
      .concat(
        extractCitations([
          { index: 0, text: "wyroki TK: z 6 maja 1998 r., sygn. K 37/97" },
        ]),
      )
      .concat(
        extractCitations([
          { index: 0, text: "z 9 października 2001 r., sygn. SK 8/00" },
        ]),
      )
      .map((c) => c.citationText);
    expect(texts).toContain("sygn. P 18/08");
    expect(texts).toContain("sygn. K 37/97");
    expect(texts).toContain("sygn. SK 8/00");
  });

  test("extracts Polish Constitutional Tribunal short-form case numbers", () => {
    const text =
      "Wyrokiem z 30 października 2006 r., w sprawie o sygn. P 10/06 " +
      "(OTK ZU nr 9/A/2006, poz. 128), Trybunał Konstytucyjny orzekł";
    const citations = extractCitations([{ index: 0, text }]);
    expect(citations).toHaveLength(1);
    expect(citations[0]?.citationText).toBe("sygn. P 10/06");
  });

  test("extracts a Polish Constitutional Tribunal code with a trailing dot", () => {
    // Verbatim from a 1993 Supreme Court decision citing an early
    // Trybunał Konstytucyjny ruling, which dotted the code letter.
    const text =
      "Orzeczenie Trybunału Konstytucyjnego z 26 października 1993 r., " +
      "sygn. U. 15/92 uznające, że przepisy";
    const citations = extractCitations([{ index: 0, text }]);
    expect(citations).toHaveLength(1);
    expect(citations[0]?.citationText).toBe("sygn. U. 15/92");
  });

  test("distinguishes Polish Constitutional Tribunal codes Kp and K", () => {
    const text = "sygn. SK 9/06 oraz sygn. Kp 3/08";
    const texts = extractCitations([{ index: 0, text }]).map(
      (c) => c.citationText,
    );
    expect(texts).toContain("sygn. SK 9/06");
    expect(texts).toContain("sygn. Kp 3/08");
  });

  test("extracts Polish division codes glued to the Roman numeral (double bare/prefixed)", () => {
    const text =
      "orzekania Trybunału Konstytucyjnego w wyroku z 25 maja 1998 r. " +
      "(sygn. U. 19/97). postanowienia Trybunału Konstytucyjnego z 24 " +
      "lutego 1998 r., sygn. Ts 19/97, OTK ZU Nr 2/1998 poz. 24";
    const texts = extractCitations([{ index: 0, text }]).map(
      (c) => c.citationText,
    );
    expect(texts).toContain("sygn. U. 19/97");
    expect(texts).toContain("sygn. Ts 19/97");
  });

  test("extracts Polish Constitutional Tribunal preliminary-review case numbers", () => {
    // Verbatim: "Tw" (a citizens' petition's preliminary examination) is a
    // fourth Trybunał Konstytucyjny chamber code alongside K/P/U/SK/Kp.
    const text =
      "postanowienie z 27 listopada 2002 r., sygn. Tw 25/02, OTK ZU nr 4/B/2002";
    const citations = extractCitations([{ index: 0, text }]);
    expect(citations).toHaveLength(1);
    expect(citations[0]?.citationText).toBe("sygn. Tw 25/02");
  });

  test("extracts Constitutional Tribunal citations without a Roman division", () => {
    const text =
      "wyroku Trybunału Konstytucyjnego z dnia 20 lipca 2004 r. (SK 19/02, " +
      "OTK-A- 2004, nr 7, poz. 67) oraz z 8 maja 2000 r., K 36/98, OTK ZU " +
      "nr 3/1999, poz. 40, a także w sprawie P 13/11 i Sygn. akt P 20/03";
    const texts = extractCitations([{ index: 0, text }]).map(
      (c) => c.citationText,
    );
    expect(texts).toContain("SK 19/02");
    // A bare single-letter symbol is read only near a Tribunal cue: the
    // Tribunal named just before "K 36/98", but too far back for
    // "P 13/11" (they collide with prose and district-court registries).
    expect(texts).toContain("K 36/98");
    expect(texts).not.toContain("P 13/11");
    expect(texts).toContain("Sygn. akt P 20/03");
  });

  test("does not phantom-duplicate an ordinary K/P registry as a bare TK citation", () => {
    // "K" (criminal) and "P" (labor) are also ordinary district-court
    // registries. Without excluding a Roman division immediately before
    // them, the Constitutional Tribunal pattern would additionally match
    // the tail of an ordinary case number as if it were a bare TK
    // citation, e.g. "sygn. akt II K 796/13" producing a phantom
    // duplicate "K 796/13".
    for (const text of [
      "sygn. akt II K 796/13",
      "w sprawie sygn. akt VI P 100/12",
    ]) {
      expect(extractCitations([{ index: 0, text }])).toHaveLength(1);
    }
  });

  test("does not phantom-duplicate a bare TK citation after a double space", () => {
    // The phantom-duplicate lookbehind must tolerate the same bounded
    // whitespace run the prefixed pattern itself accepts, not just a
    // single space, or a double-spaced roman+symbol run ("II  SK 12/20")
    // slips through the guard and produces a phantom bare "SK 12/20".
    const text = "sygn. akt II  SK 12/20";
    expect(extractCitations([{ index: 0, text }])).toHaveLength(1);
  });

  test("does not read a bare TK citation after a four-space gap", () => {
    // The combining patterns (PL_PREFIXED_PATTERN and the bare Polish
    // pattern) accept at most three characters between the roman numeral
    // and the division code, so a four-space gap leaves the docket unread.
    // The Tribunal matchers reject the roman numeral across any run, so the
    // tail is not read as a Tribunal docket either: "II SK" is a Supreme
    // Court mark, and "SK 12/20" would be a different case.
    const text = "sygn. akt II    SK 12/20";
    expect(extractCitations([{ index: 0, text }])).toEqual([]);
  });

  test("extracts a bare Polish Constitutional Tribunal citation list", () => {
    // Verbatim from a Trybunał Konstytucyjny opinion citing its own prior
    // case law as a bare comma-separated run, with no "sygn." anywhere
    // nearby. The multi-letter symbol (SK) is a safe bare match; this
    // decided design captures single-letter symbols (P, K) bare too when
    // not immediately preceded by a Roman-numeral division, which is the
    // only phantom-duplicate risk the lookbehind guards against.
    const text =
      "art. 31 ust. 3 powinien pełnić rolę podstawową (wyroki TK z: 12 " +
      "stycznia 1999 r., P 2/98, OTK ZU nr 1/1999, poz. 2, 25 lutego 1999 " +
      "r., K. 23/98, OTK ZU nr 2/1999, poz. 25, 23 kwietnia 2002 r., K " +
      "2/01, OTK ZU nr 3/A/2002, poz. 27, 5 marca 2002 r., SK 22/00, OTK " +
      "ZU nr 2/A/2002, poz. 12).";
    const texts = extractCitations([{ index: 0, text }]).map(
      (c) => c.citationText,
    );
    expect(texts).toContain("SK 22/00");
  });

  test("does not match a bare-symbol citation without the sygn. prefix", () => {
    // The bare-symbol pattern is anchored on "sygn." precisely because an
    // unanchored 1-3 uppercase letters + digits/year shape is far too
    // common in ordinary prose (initials, abbreviations, addresses).
    const text = "Delivered by K on the 8/00 shift, then P handled 12/03.";
    expect(extractCitations([{ index: 0, text }])).toHaveLength(0);
  });

  test("does not capture a Tribunal citation across an over-long whitespace run after 'sygn.'", () => {
    // The whitespace after "sygn." is bounded so an OCR whitespace run
    // does not get swallowed into a phantom Tribunal match; an
    // unrealistically long run is never captured with the whitespace baked
    // in. The docket itself still reads bare, the label being its cue.
    const text = "orzeczenie sygn.     K 20/03 Trybunału Konstytucyjnego";
    expect(
      extractCitations([{ index: 0, text }]).map((c) => c.citationText),
    ).toEqual(["K 20/03"]);
  });

  test("does not capture a Tribunal citation across an over-long whitespace run before the docket", () => {
    // The whitespace between a Tribunal symbol and its own docket is
    // bounded the same way; an unrealistically long run between "SK" and
    // the docket digits fails to match rather than being captured with
    // the whitespace baked into citationText.
    const text = "sygn. SK     12/20";
    expect(extractCitations([{ index: 0, text }])).toHaveLength(0);
  });

  test("extracts Polish Constitutional Tribunal and disciplinary bare-symbol citations", () => {
    // Verbatim from a Trybunał Konstytucyjny opinion citing its own prior
    // case law, plus a Sąd Najwyższy disciplinary-chamber (SNO) citation:
    // a bare 1-3 letter symbol with no Roman-numeral chamber, sometimes
    // with a trailing dot, anchored to "sygn.".
    const text =
      "dotychczasowe orzecznictwo TK wskazało (sygn. P 8/00, OTK ZU " +
      "nr 6/2000); orzeczenie sygn. K. 7/95 - OTK ZU Nr 6/1996; " +
      "postanowienia z: sygn. K 35/00; wyrok sygn. SK 51/04; " +
      "wyrokiem Sądu Najwyższego z dnia 5 września 2006 r., sygn. SNO 45/06.";
    const texts = extractCitations([{ index: 0, text }]).map(
      (c) => c.citationText,
    );
    expect(texts).toContain("sygn. P 8/00");
    expect(texts).toContain("sygn. K. 7/95");
    expect(texts).toContain("sygn. K 35/00");
    expect(texts).toContain("sygn. SK 51/04");
    expect(texts).toContain("sygn. SNO 45/06");
  });

  test("reads a bare single-letter Tribunal docket only near a Tribunal cue", () => {
    const cases: [text: string, expected: string[]][] = [
      ["wyrok TK z dnia 3 marca 2026 r., K 2/26", ["K 2/26"]],
      ["postanowienie Trybunału Konstytucyjnego, Ts 123/19", ["Ts 123/19"]],
      ["wyrok z dnia 12 maja 2017 r., Kpt 1/17", ["Kpt 1/17"]],
      [
        "por. orzecznictwo TK: W 3/94, S 1/05, T 20/97",
        ["W 3/94", "S 1/05", "T 20/97"],
      ],
      ["uchwała TK, Uw 7/92, oraz Kw 2/93", ["Uw 7/92", "Kw 2/93"]],
      // No cue: a lone capital and a number are not a Tribunal docket.
      ["pozycja K 2/26 w wykazie, punkt W 3/20", []],
      // A common court's division keeps its docket whole.
      [
        "wyrok Sądu Rejonowego z dnia 1 lutego 2020 r., sygn. akt II K 12/20",
        ["sygn. akt II K 12/20"],
      ],
    ];
    for (const [text, expected] of cases) {
      expect(
        extractCitations([{ index: 0, text }]).map((c) => c.citationText),
      ).toEqual(expected);
    }
  });

  test("reads KIO dockets as the search grammar does", () => {
    const cases: [text: string, expected: string[]][] = [
      ["wyrok KIO z dnia 3 marca 2024 r., KIO 1234/24", ["KIO 1234/24"]],
      ["por. wyrok z 2008 r., KIO/UZP 1188/08", ["KIO/UZP 1188/08"]],
      [
        "wyrok w sprawach połączonych KIO 2845/25, KIO 2846/25.",
        ["KIO 2845/25, KIO 2846/25"],
      ],
      // Not a KIO docket: a longer word, a four-digit year.
      ["KIOSK 12/20 i KIO 2845/2025", []],
    ];
    for (const [text, expected] of cases) {
      expect(
        extractCitations([{ index: 0, text }]).map((c) => c.citationText),
      ).toEqual(expected);
    }
    expect(bareCitationKey("KIO UZP 1188/08")).toBe(
      bareCitationKey("KIO/UZP 1188/08"),
    );
    expect(bareCitationKey("KIO 2845/25,KIO 2846/25")).toBe(
      bareCitationKey("KIO 2845/25, KIO 2846/25"),
    );
  });

  test("never reads the tail of a divided docket as a Tribunal one", () => {
    // Every whitespace run between a Roman division and a Tribunal-shaped
    // symbol, including the ones too wide for the docket to read whole.
    const gaps = [
      " ",
      "  ",
      "   ",
      "    ",
      "      ",
      "\t",
      "\n",
      "\n\n\n\n",
      " ",
      " \t \n ",
    ];
    for (const roman of ["II", "IV", "VIII"]) {
      for (const gap of gaps) {
        for (const prefix of [
          "K",
          "P",
          "U",
          "W",
          "S",
          "T",
          "Uw",
          "Kw",
          "SK",
          "Kp",
          "Pp",
          "Kpt",
          "Ts",
          "Tw",
        ]) {
          const tail = `${prefix} 12/20`;
          const texts = extractCitations([
            { index: 0, text: `sygn. akt ${roman}${gap}${tail}` },
          ]).map((c) => c.citationText);
          expect(texts).not.toContain(tail);
        }
      }
    }
  });

  test("never reads an administrative docket with its division cut off", () => {
    // A division too wide from its register, or one the court does not
    // have ("IX", "XII"), leaves no docket read from the register onward.
    const gaps = [" ", "   ", "    ", "      ", "\t", "\n\n\n\n", " "];
    for (const roman of ["II", "IX", "XII"]) {
      for (const gap of gaps) {
        for (const tail of [
          "SA/Wa 1/20",
          "SAB/Wa 1/20",
          "SO/Kr 3/21",
          "OPS 3/98",
        ]) {
          for (const lead of ["", "sygn. akt "]) {
            const texts = extractCitations([
              { index: 0, text: `${lead}${roman}${gap}${tail}` },
            ]).map((c) => c.citationText);
            expect(texts).not.toContain(tail);
            expect(texts).not.toContain(`sygn. akt ${tail}`);
          }
        }
      }
    }
    // The division in range and in reach still reads whole.
    expect(
      extractCitations([{ index: 0, text: "wyrok WSA, VIII SA/Wa 5/20" }]).map(
        (c) => c.citationText,
      ),
    ).toEqual(["VIII SA/Wa 5/20"]);
  });

  test("reads Tribunal cues in any capitalisation", () => {
    const cases: [text: string, expected: string[]][] = [
      ["Sygn.: P. 12/98, P. 8/99", ["Sygn.: P. 12/98", "P. 8/99"]],
      // An all-caps label is no citation prefix, but it is still a cue.
      ["SYGN. AKT K 1/20, oraz U 2/20", ["K 1/20", "U 2/20"]],
      ["Wyrok z dnia 1 maja 2020 r., K 2/19", ["K 2/19"]],
      ["WYROK Z DNIA 1 MAJA 2020 R., W 3/19", ["W 3/19"]],
      ["TRYBUNAŁ KONSTYTUCYJNY orzekł, S 1/05", ["S 1/05"]],
    ];
    for (const [text, expected] of cases) {
      expect(
        extractCitations([{ index: 0, text }]).map((c) => c.citationText),
      ).toEqual(expected);
    }
  });

  test("reads an authority file number only after its cue", () => {
    const cases: [text: string, expected: string[]][] = [
      [
        "decyzja Prezesa UODO z dnia 5 marca 2024 r., DKN.5131.6.2024.",
        ["DKN.5131.6.2024"],
      ],
      ["znak sprawy: ZSOŚS.440.82.2019", ["ZSOŚS.440.82.2019"]],
      // No cue: another body numbers its files the same way.
      ["pismo nr DKE.561.1.2020 w aktach", []],
      // A statute reference and a tax-ruling signature, even when cued.
      ["UODO, Dz.U.2024.1061 oraz art. 5.1", []],
      ["znak sprawy 0114-KDIP1-2.4012.123.2024.1.AB", []],
    ];
    for (const [text, expected] of cases) {
      expect(
        extractCitations([{ index: 0, text }]).map((c) => c.citationText),
      ).toEqual(expected);
    }
  });

  test("reads a competition authority decision number only after its cue", () => {
    const cases: [text: string, expected: string[]][] = [
      [
        "decyzji Prezesa UOKiK nr DOK-1/2020 z dnia 5 marca 2020 r.",
        ["DOK-1/2020"],
      ],
      [
        "na skutek odwołania od decyzji Prezesa Urzędu Ochrony Konkurencji i Konsumentów z 29 lutego 2024 r. Nr DOZIK 3/2024",
        ["DOZIK 3/2024"],
      ],
      ["decyzja Prezesa UOKiK nr RŁO-7/2025", ["RŁO-7/2025"]],
      ["decyzją Prezesa UOKiK nr DIH-II-34/2026", ["DIH-II-34/2026"]],
      ["decyzji Prezesa UOKiK (DNR-1-20/2026)", ["DNR-1-20/2026"]],
      ["UOKiK, decyzja nr RGD- 16/2024", ["RGD- 16/2024"]],
      ["Prezes UOKiK wydał decyzję DKK – 212/2026", ["DKK – 212/2026"]],
      // The author named right after the number.
      ["w decyzji nr DOK-1/2020 Prezesa UOKiK", ["DOK-1/2020"]],
      [
        "decyzja nr RKT-12/2019 Prezesa Urzędu Ochrony Konkurencji i Konsumentów",
        ["RKT-12/2019"],
      ],
      // No cue: other bodies number their files the same way.
      ["pismo MZDR 6206/2025 w aktach", []],
      ["decyzja nr DOK-1/2020", []],
      // A cue far past the number belongs to something else.
      [
        "decyzja nr DOK-1/2020 z dnia 5 marca 2020 r. w sprawie, o której mowa w piśmie z dnia 1 czerwca, a później Prezes UOKiK",
        [],
      ],
      // Cued, but not a decision number: a two-digit year, lower case, a
      // unit code too short, a number running on.
      ["Prezes UOKiK, RKR 51/06", []],
      ["Prezes UOKiK, dok-1/2020", []],
      ["Prezes UOKiK, DO-1/2020", []],
      ["Prezes UOKiK, DOK-1/2020/3", []],
      // Cued, but the tail of a court docket: the docket alone is cited.
      [
        "odwołanie od decyzji Prezesa UOKiK, wyrok SN z dnia 5 marca 2020 r., I CSK 123/2019",
        ["I CSK 123/2019"],
      ],
      [
        "Prezes UOKiK; sygn. akt III  CZP 12/2020",
        ["sygn. akt III  CZP 12/2020"],
      ],
    ];
    for (const [text, expected] of cases) {
      expect(
        extractCitations([{ index: 0, text }]).map((c) => c.citationText),
        text,
      ).toEqual(expected);
    }
  });

  test("a cited competition authority decision keys like the identifiers its row stores", () => {
    const units = fc.constantFrom("DOK", "DKK", "RŁO", "DOZIK", "RKT");
    const divisions = fc.option(fc.constantFrom("II", "III", "1", "2"), {
      nil: undefined,
    });
    fc.assert(
      fc.property(
        units,
        divisions,
        fc.integer({ min: 1, max: 9999 }),
        fc.integer({ min: 1990, max: 2099 }),
        fc.constantFrom("-", " - ", "–", " "),
        (unit, division, ordinal, year, separator) => {
          const register = `${unit}${division === undefined ? "" : `-${division}`}-${ordinal}/${year}`;
          const cited = `${unit}${division === undefined ? "" : `-${division}`}${separator}${ordinal}/${year}`;
          const [citation] = extractCitations([
            { index: 0, text: `decyzja Prezesa UOKiK nr ${cited} z dnia` },
          ]);
          expect(citation?.citationText).toBe(cited);
          const held = plUokikDecisionIdentifiers(register).map((identifier) =>
            normalizeDecisionIdentifier(identifier),
          );
          expect(held).toContain(bareCitationKey(citation?.citationText ?? ""));
        },
      ),
      propertyConfig(),
    );
  });

  test("keys a Tribunal docket with its dot and letter case ignored", () => {
    for (const [variant, canonical] of [
      ["U. 4/86", "U 4/86"],
      ["U.4/86", "U 4/86"],
      ["KPT 1/17", "Kpt 1/17"],
      ["sygn. akt K. 2/26", "K 2/26"],
    ] as const) {
      expect(bareCitationKey(variant)).toBe(bareCitationKey(canonical));
    }
    expect(bareCitationKey("K 2/26")).not.toBe(bareCitationKey("II K 2/26"));
  });

  test("extracts a Polish Constitutional Tribunal citation after 'sygn.:'", () => {
    // Verbatim from a prod decision: "sygn.: P. 12/98" has a colon
    // directly after the period. The second, comma-joined case number ("P.
    // 8/99") has no "sygn." of its own; the label just before it is the
    // Tribunal cue that lets the bare single-letter symbol read.
    const text =
      "ustalona linia orzecznicza (wyroki o sygn.: P. 12/98, P. 8/99.";
    const texts = extractCitations([{ index: 0, text }]).map(
      (c) => c.citationText,
    );
    expect(texts).toContain("sygn.: P. 12/98");
    expect(texts).toContain("P. 8/99");
  });

  test("extracts a Polish Constitutional Tribunal case number split across sygn. akt/bare spellings", () => {
    // Verbatim from a prod Trybunał Konstytucyjny decision citing its own
    // case number and its cited constitutional complaints (SK) and
    // abstract review (K) proceedings.
    const own = "z dnia 16 lipca 2008 r.\nSygn. akt SK 6/08";
    const cited = "r. postanowienie z 21 września 2006 r., sygn. SK 10/06, OTK";
    const kSymbol =
      "regulacji (wyrok TK z 22 czerwca 1999 r., sygn. K. 5/99, OTK ZU nr 5/1999)";
    expect(extractCitations([{ index: 0, text: own }])[0]?.citationText).toBe(
      "Sygn. akt SK 6/08",
    );
    expect(extractCitations([{ index: 0, text: cited }])[0]?.citationText).toBe(
      "sygn. SK 10/06",
    );
    expect(
      extractCitations([{ index: 0, text: kSymbol }])[0]?.citationText,
    ).toBe("sygn. K. 5/99");
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

describe("stored decision identifier projection", () => {
  test("recovers publisher case-number aliases from stored metadata", () => {
    expect(
      decisionIdentifiersFromStoredMetadata({
        caseNumber: "I ACa 1/24",
        ecli: "ECLI:PL:TEST:1",
        metadata: {
          additionalCaseNumbers: ["I ACz 2/24", "I ACa 1/24"],
        },
      }),
    ).toEqual([
      {
        type: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
        value: "I ACa 1/24",
      },
      {
        type: DECISION_IDENTIFIER_TYPES.ECLI,
        value: "ECLI:PL:TEST:1",
      },
      {
        type: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
        value: "I ACz 2/24",
      },
    ]);
  });

  test("recovers legacy reporter citations from publisher metadata", () => {
    expect(
      decisionIdentifiersFromStoredMetadata({
        caseNumber: "1 As 2/2024",
        ecli: null,
        metadata: { citation: "12 Test Reporter 34" },
      }),
    ).toEqual([
      {
        type: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
        value: "1 As 2/2024",
      },
      {
        type: DECISION_IDENTIFIER_TYPES.REPORTER_CITATION,
        value: "12 Test Reporter 34",
      },
    ]);
  });

  test("reserves identifier capacity for a legacy reporter citation", () => {
    const identifiers = decisionIdentifiersFromStoredMetadata({
      caseNumber: "1 As 2/2024",
      ecli: null,
      metadata: {
        additionalCaseNumbers: Array.from(
          { length: DECISION_IDENTIFIER_MAX_COUNT },
          (_, index) => `alias ${index}/2024`,
        ),
        citation: "12 Test Reporter 34",
      },
    });

    expect(identifiers).toHaveLength(DECISION_IDENTIFIER_MAX_COUNT);
    expect(identifiers.at(-1)).toEqual({
      type: DECISION_IDENTIFIER_TYPES.REPORTER_CITATION,
      value: "12 Test Reporter 34",
    });
  });

  test("reads the exact identifier set persisted by ingestion", () => {
    const metadata = storeDecisionIdentifiersInMetadata(
      { citation: "legacy reporter spelling" },
      [
        {
          type: DECISION_IDENTIFIER_TYPES.NEUTRAL_CITATION,
          value: "[2024] Test 12",
        },
      ],
    );
    expect(
      decisionIdentifiersFromStoredMetadata({
        caseNumber: "1 As 2/2024",
        ecli: null,
        metadata,
      }),
    ).toEqual([
      {
        type: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
        value: "1 As 2/2024",
      },
      {
        type: DECISION_IDENTIFIER_TYPES.NEUTRAL_CITATION,
        value: "[2024] Test 12",
      },
    ]);
  });

  test("expands a persisted NSS composite label into its citable collection reference", () => {
    const metadata = storeDecisionIdentifiersInMetadata({}, [
      {
        type: DECISION_IDENTIFIER_TYPES.REPORTER_CITATION,
        value: "1 Azs 4/2026-79, č. 4600/2026 Sb. NSS",
      },
    ]);

    expect(
      decisionIdentifiersFromStoredMetadata({
        caseNumber: "1 Azs 4/2026",
        ecli: null,
        metadata,
      }),
    ).toEqual([
      {
        type: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
        value: "1 Azs 4/2026",
      },
      {
        type: DECISION_IDENTIFIER_TYPES.REPORTER_CITATION,
        value: "č. 4600/2026 Sb. NSS",
      },
    ]);
  });

  test("omits optional identifiers with no searchable normalized value", () => {
    expect(
      decisionIdentifiersFromMetadata({
        caseNumber: "A-123",
        ecli: "!!!",
        identifiers: [
          {
            type: DECISION_IDENTIFIER_TYPES.NEUTRAL_CITATION,
            value: "...",
          },
          {
            type: DECISION_IDENTIFIER_TYPES.REPORTER_CITATION,
            value: "12 Example Reports 34",
          },
        ],
      }),
    ).toEqual([
      {
        type: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
        value: "A-123",
      },
      {
        type: DECISION_IDENTIFIER_TYPES.REPORTER_CITATION,
        value: "12 Example Reports 34",
      },
    ]);
  });
});

describe("court hint", () => {
  test("keeps the court the citing sentence names", () => {
    const citations = extractCitations([
      {
        index: 1,
        text: "srov. rozsudek Krajského soudu v Českých Budějovicích ze dne 21. 5. 2025, č. j. 65 A 3/2025-226, body 99 a 100",
      },
    ]);

    expect(citations).toHaveLength(1);
    expect(citations[0]?.citedCourtHint).toBe(
      "Krajského soudu v Českých Budějovicích",
    );
  });

  test("a later occurrence that names the court fills a bare first mention", () => {
    const citations = extractCitations([
      { index: 0, text: "sp. zn. 65 A 3/2025" },
      {
        index: 3,
        text: "rozsudek Krajského soudu v Brně ze dne 2. 6. 2025, č. j. 65 A 3/2025-30",
      },
    ]);

    expect(citations).toHaveLength(1);
    expect(citations[0]?.citedCourtHint).toBe("Krajského soudu v Brně");
  });

  test("two courts for one number leave no hint", () => {
    const citations = extractCitations([
      {
        index: 1,
        text: "rozsudek Krajského soudu v Brně ze dne 2. 6. 2025, č. j. 65 A 3/2025-30",
      },
      {
        index: 2,
        text: "rozsudek Krajského soudu v Ostravě ze dne 28. 5. 2025, č. j. 65 A 3/2025-40",
      },
    ]);

    expect(citations).toHaveLength(1);
    expect(citations[0]?.citedCourtHint).toBeNull();
  });
});

describe("isSelfCitation", () => {
  const decision = decisionIdentifiersFromMetadata({
    caseNumber: "21 Cdo 1234/2020",
    ecli: "ECLI:CZ:NS:2020:21.CDO.1234.2020.1",
  });

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
    const d = decisionIdentifiersFromMetadata({
      caseNumber: "21 cdo 1234/2020",
    });
    expect(isSelfCitation("sp. zn. 21 Cdo 1234/2020", d)).toBe(true);
  });

  test("detects sygn. akt self-reference (Polish)", () => {
    const d = decisionIdentifiersFromMetadata({ caseNumber: "II CSK 123/20" });
    expect(isSelfCitation("sygn. akt II CSK 123/20", d)).toBe(true);
  });

  test("detects sygn. self-reference without akt", () => {
    const d = decisionIdentifiersFromMetadata({ caseNumber: "II CSK 123/20" });
    expect(isSelfCitation("sygn. II CSK 123/20", d)).toBe(true);
  });

  test("returns false when decision has no ECLI", () => {
    const d = decisionIdentifiersFromMetadata({
      caseNumber: "21 Cdo 1234/2020",
    });
    expect(isSelfCitation("ECLI:CZ:NS:2019:30.CDO.5678.2019.1", d)).toBe(false);
  });

  test("detects any parallel reporter citation", () => {
    const identifiers = [
      {
        type: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
        value: "A-123",
      },
      {
        type: DECISION_IDENTIFIER_TYPES.REPORTER_CITATION,
        value: "12 Example Reports 34",
      },
      {
        type: DECISION_IDENTIFIER_TYPES.REPORTER_CITATION,
        value: "56 Parallel Reports 78",
      },
    ] as const satisfies DecisionIdentifiers;

    expect(isSelfCitation("56 Parallel Reports 78", identifiers)).toBe(true);
  });

  test("detects a neutral citation", () => {
    const identifiers = [
      {
        type: DECISION_IDENTIFIER_TYPES.NEUTRAL_CITATION,
        value: "[2026] Example Court 12",
      },
    ] as const satisfies DecisionIdentifiers;

    expect(isSelfCitation("[2026] Example Court 12", identifiers)).toBe(true);
  });
});

describe("the sheet number and date a citation names", () => {
  // One docket names a case file, and a court can rule in it more than once,
  // so what the sentence adds to the docket is what identifies the decision.
  const CITED =
    "rozsudek Nejvyššího správního soudu ze dne 17. 2. 2021, č. j. 8 As 287/2020";

  test("keeps the sheet number and the date beside the docket", () => {
    const citations = extractCitations([{ index: 0, text: `${CITED}-33` }]);

    expect(citations).toHaveLength(1);
    expect(citations[0]).toMatchObject({
      // The docket alone stays the text and the key: the same judgment cites
      // this decision as "sp. zn. 8 As 287/2020" where it invokes the ruling.
      citationText: "č. j. 8 As 287/2020",
      citedSheetNumber: "33",
      citedDecisionDate: "2021-02-17",
    });
  });

  test("reads every dash a court typesets the separator with", () => {
    for (const dash of ["-", "‐", "‑", "‒", "–", "−"]) {
      const citations = extractCitations([
        { index: 0, text: `${CITED}${dash}33` },
      ]);
      expect(citations.map((citation) => citation.citedSheetNumber)).toEqual([
        "33",
      ]);
    }
  });

  test("a dash joining two dockets is not a sheet number", () => {
    const citations = extractCitations([
      { index: 0, text: "srov. rozsudek č. j. 5 As 123/2020 – 5 As 124/2020" },
    ]);

    expect(citations.map((citation) => citation.citedSheetNumber)).toEqual([
      null,
    ]);
  });

  test("two sheets or two dates for one docket leave it with neither", () => {
    const citations = extractCitations([
      { index: 0, text: `${CITED}-33` },
      {
        index: 1,
        text:
          "rozsudek Nejvyššího správního soudu ze dne 25. 3. 2021, " +
          "č. j. 8 As 287/2020-48",
      },
    ]);

    expect(citations).toHaveLength(1);
    expect(citations[0]).toMatchObject({
      citedSheetNumber: null,
      citedDecisionDate: null,
    });
  });

  test("a date the calendar does not have is no hint", () => {
    const citations = extractCitations([
      { index: 0, text: "rozsudek ze dne 31. 2. 2021, č. j. 8 As 287/2020-33" },
    ]);

    expect(citations.map((citation) => citation.citedDecisionDate)).toEqual([
      null,
    ]);
  });
});

describe("captures the docket grammar rejects", () => {
  test("a ministry file number under č. j. is not a case-law citation", () => {
    // Verbatim shape from a prod decision: a Czech ministry labels its own
    // file number with the same "č. j." a court labels a docket with.
    const text =
      "rozhodnutí Ministerstva zdravotnictví ze dne 1. 4. 2025, " +
      "č. j. MZDR 6206/2025";

    expect(extractCitations([{ index: 0, text }])).toHaveLength(0);
    expect(
      extractCitations([{ index: 0, text: "usnesení sp. zn. MZDR 6206/2025" }]),
    ).toHaveLength(0);
  });

  test("a court's own letter-first registry still is one", () => {
    const texts = extractCitations([
      {
        index: 0,
        text: "usnesení č.j. Nad 224/2014-53 a rozhodnutí sp. zn. A 9/2003",
      },
    ]).map((citation) => citation.citationText);

    expect(texts).toEqual(["sp. zn. A 9/2003", "č.j. Nad 224/2014"]);
  });
});

describe("Hungarian citations", () => {
  // Verbatim from the recorded Kúria decision Gfv.VI.30.197/2024/4
  // (`parsers/__fixtures__/hu-bhgy-decision.docx`), paragraphs [14] and [15].
  const KURIA_PROSE =
    "a BH-k alapjául szolgáló kúriai határozatok egy része a BHGY-ban " +
    "közzétételre került (BH2019. 19. alapjául szolgáló Kúria Pfv. " +
    "20.187/2017/12. sz. határozat, a BH2023. 129. alapjául szolgáló " +
    "Pfv.20626/2022/4. sz. határozat, a BH2022. 332. alapjául szolgáló " +
    "Mfv.10043/2022/5. sz. határozat), így ezek figyelembe vehetők. " +
    "(Kúria Pfv.V.20.675/2022/2., Pfv.V.21.323/2022/2. - BH2023. 71., PK " +
    "vélemény 1. pont)";

  const extract = (text: string) => extractCitations([{ index: 0, text }]);

  /**
   * The keys one cited spelling carries into `case_law_citations`, as the
   * pipeline derives them: the typed identifier the resolver joins on, and
   * `citation_key`.
   */
  const citedKeys = (text: string) => {
    const citations = extract(text);
    expect(citations).toHaveLength(1);
    const [citation] = citations;
    if (citation === undefined) {
      throw new Error(`nothing extracted from ${text}`);
    }
    return {
      type: citation.identifierType,
      identifier: normalizeDecisionIdentifierValue(
        citation.identifierType,
        citation.identifierValue,
      ),
      citationKey: citationKeyOf(citation.citationText),
    };
  };

  /**
   * The keys a stored case number carries into `case_law_decisions` and
   * `case_law_decision_identifiers`, as ingestion and the identifier backfill
   * derive them.
   */
  const storedKeys = (caseNumber: string) => {
    const [identifier] = decisionIdentifiersFromMetadata({ caseNumber });
    return {
      type: identifier.type,
      identifier: normalizeDecisionIdentifier(identifier),
      citationKey: citationKeyOf(caseNumber),
    };
  };

  test("reads every docket and reporter entry of real Kúria prose", () => {
    const citations = extract(KURIA_PROSE);

    expect(
      citations.map(({ citationText, identifierType }) => [
        citationText,
        identifierType,
      ]),
    ).toEqual([
      ["Pfv. 20.187/2017/12", DECISION_IDENTIFIER_TYPES.CASE_NUMBER],
      ["Pfv.20626/2022/4", DECISION_IDENTIFIER_TYPES.CASE_NUMBER],
      ["Mfv.10043/2022/5", DECISION_IDENTIFIER_TYPES.CASE_NUMBER],
      ["Pfv.V.20.675/2022/2", DECISION_IDENTIFIER_TYPES.CASE_NUMBER],
      ["Pfv.V.21.323/2022/2", DECISION_IDENTIFIER_TYPES.CASE_NUMBER],
      ["BH2019. 19", DECISION_IDENTIFIER_TYPES.CASE_NUMBER],
      ["BH2023. 129", DECISION_IDENTIFIER_TYPES.CASE_NUMBER],
      ["BH2022. 332", DECISION_IDENTIFIER_TYPES.CASE_NUMBER],
      ["BH2023. 71", DECISION_IDENTIFIER_TYPES.CASE_NUMBER],
    ]);
  });

  test("lower-court dockets in a legacy decision, but not the prosecutor's file", () => {
    // Verbatim from the recorded Győri Ítélőtábla decision Bhar.31/2009/6
    // (`parsers/__fixtures__/hu-bhgy-decision.rtf`). The prosecution office
    // numbers its files in the court shape and adds a dashed suffix.
    const text =
      "A Komárom-Esztergom Megyei Bíróság a 2009. január 13. napján kelt " +
      "1.Bf.327/2008/6. számú ítéletével a Komáromi Városi Bíróság " +
      "5.B.19/2008/4. számú ítéletét annyiban változtatta meg. A Győri " +
      "Fellebbviteli Főügyészség a Bf.90/2009/1-I. számú átiratában a " +
      "helybenhagyását indítványozta.";

    expect(extract(text).map((citation) => citation.citationText)).toEqual([
      "1.Bf.327/2008/6",
      "5.B.19/2008/4",
    ]);
  });

  test("every printed spelling of a docket keys to the spelling the publisher lists", () => {
    // The listing stores `Gfv.30091/2025/4`; the document prints
    // `Gfv.VI.30.091/2025/4.` (hu-bhgy.research.md). Each decoration is one
    // axis, and every combination of them must land on the listed key.
    const listed = "Pfv.20123/2019/5";
    const leads = ["", "3.", "3. "];
    const numerals = ["", "III.", "III. "];
    const registers = ["20123", "20.123"];
    const registryGaps = ["", " "];
    const contexts = [
      (docket: string) => `a Kúria ${docket}. számú ítélete`,
      (docket: string) => `a Fővárosi Ítélőtábla ${docket}. sz. végzése`,
      (docket: string) => `(Kúria ${docket}.)`,
      (docket: string) => `a ${docket} számú határozat`,
    ];

    for (const lead of leads) {
      for (const numeral of numerals) {
        for (const register of registers) {
          for (const gap of registryGaps) {
            for (const context of contexts) {
              const docket = `${lead}Pfv.${gap}${numeral}${register}/2019/5`;
              expect(
                extract(context(docket)).map((c) => c.citationText),
              ).toEqual([docket]);
              expect(bareCitationKey(docket)).toBe(bareCitationKey(listed));
            }
          }
        }
      }
    }
  });

  test("the key of a listed docket is the key stored for it today", async () => {
    // `citation_key` and the case-number identifier rows of stored Hungarian
    // decisions were written from the listed docket when its key was the
    // docket lowercased. A key that moved would orphan them.
    const raw: unknown = JSON.parse(
      await Bun.file(
        new URL(
          "adapters/__fixtures__/hu-bhgy-listing-2000-gazdasagi.json",
          import.meta.url,
        ),
      ).text(),
    );
    const dockets = (readHuBhgySearch(raw)?.rows ?? [])
      .map((row) => normalizeHuBhgyRow(row).Azonosito)
      .filter((docket) => docket !== undefined)
      .filter((docket) => hungarianCitationForm(docket)?.type === "docket");

    expect(dockets.length).toBeGreaterThan(0);
    for (const docket of dockets) {
      expect(bareCitationKey(docket)).toBe(docket.toLowerCase());
    }
  });

  test("the printed and listed dockets are one identity of the decision", () => {
    const identifiers = decisionIdentifiersFromMetadata({
      caseNumber: "Gfv.30197/2024/4",
      identifiers: [
        { type: "case-number", value: "Gfv.30197/2024/4" },
        { type: "case-number", value: "Gfv.VI.30.197/2024/4" },
      ],
    });

    expect(identifiers).toEqual([
      { type: "case-number", value: "Gfv.30197/2024/4" },
    ]);
    expect(isSelfCitation("Gfv.VI.30.197/2024/4", identifiers)).toBe(true);
    expect(isSelfCitation("Gfv.VI.30.198/2024/4", identifiers)).toBe(false);
  });

  test("another document of the file, or another registry, is another decision", () => {
    expect(bareCitationKey("Pfv.III.20.123/2019/5")).not.toBe(
      bareCitationKey("Pfv.III.20.123/2019/6"),
    );
    expect(bareCitationKey("Pfv.III.20.123/2019/5")).not.toBe(
      bareCitationKey("Pf.III.20.123/2019/5"),
    );
  });

  test("every registry the courts use, with and without a panel", () => {
    const dockets = [
      "Pfv.III.20.123/2019/5",
      "Kfv.I.35.456/2020/8",
      "Bfv.II.1.234/2021/9",
      "Gfv.VII.30.091/2025/4",
      "Mfv.X.10.123/2019/6",
      "Kpkf.IV.39.123/2020/2",
      "Pkf.25.123/2020/3",
      "Pf.20.123/2019/4",
      "Kf.650.123/2019/7",
      "Bf.339/2013/6",
      "Gf.30.329/2007/6",
      "Mf.30.123/2020/5",
      "5.Pf.20.123/2019/4",
      "2.Kf.650.123/2019/7",
      "14.G.40.123/2020/12",
      "B.61/2013/37",
    ];

    for (const docket of dockets) {
      expect(extract(`a ${docket}. számú határozat`)).toMatchObject([
        {
          citationText: docket,
          identifierType: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
        },
      ]);
    }
  });

  test("a cited uniformity decision or opinion reaches the row the listing stores", () => {
    // Stored spellings and keys read from the production listing rows.
    const cases = [
      {
        stored: "4.2008.BJE",
        key: "4.2008.bje",
        cited: [
          "4/2008. BJE",
          "BJE 4/2008",
          "4/2008. Büntető jogegységi határozat",
        ],
      },
      {
        stored: "1.2007.PJE",
        key: "1.2007.pje",
        cited: [
          "1/2007. PJE",
          "PJE 1/2007",
          "1/2007. Polgári jogegységi határozat",
          "1/2007. (VI. 28.) PJE",
        ],
      },
      {
        stored: "2.2004.KJE",
        key: "2.2004.kje",
        cited: ["2/2004. KJE", "2/2004. közigazgatási jogegységi határozat"],
      },
      {
        stored: "1.2019.KMPJE",
        key: "1.2019.kmpje",
        cited: ["1/2019. KMPJE", "KMPJE 1/2019"],
      },
      {
        stored: "2.2009.PK",
        key: "2.2009.pk",
        cited: ["2/2009. PK vélemény", "PK vélemény 2/2009"],
      },
      {
        stored: "3.2008.PK",
        key: "3.2008.pk",
        cited: ["3/2008. PK vélemény", "PK vélemény 3/2008"],
      },
    ];

    for (const { stored, key, cited } of cases) {
      const target = storedKeys(stored);
      expect(target).toEqual({
        type: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
        identifier: key,
        citationKey: key,
      });
      for (const spelling of cited) {
        expect(citedKeys(`a ${spelling} szerint`)).toEqual(target);
      }
    }
    expect(
      citedKeys("a 1/2021. Közigazgatási-munkaügyi jogegységi határozat")
        .identifier,
    ).toBe("1.2021.kmje");
  });

  test("a cited reporter entry reaches the row the listing stores, closing dot or not", () => {
    // Stored spellings read from the production listing rows: the listing
    // writes the closing dot on some rows and not on others.
    const cases = [
      {
        stored: ["EBH.2018.K.17.", "EBH.2018.K.17"],
        key: "ebh.2018.k.17",
        cited: [
          "EBH 2018.K.17.",
          "EBH2018. K.17.",
          "EBH.2018.K.17.",
          "EBH 2018. K. 17",
        ],
      },
      {
        stored: ["EBH.2015.K.38", "EBH.2015.K.38."],
        key: "ebh.2015.k.38",
        cited: ["EBH 2015.K.38."],
      },
      {
        stored: ["EBD.2012.B.19."],
        key: "ebd.2012.b.19",
        cited: ["EBD 2012.B.19.", "EBD2012. B. 19."],
      },
      {
        stored: ["EBH.2016.M.29."],
        key: "ebh.2016.m.29",
        cited: ["EBH 2016.M.29"],
      },
      {
        stored: ["EBH..2013.K.32."],
        key: "ebh.2013.k.32",
        cited: ["EBH 2013.K.32.", "EBH..2013.K.32."],
      },
    ];

    // Two stored rows carry an `EBHH` series this rule does not read; their
    // key stays the verbatim lowercase one they hold.
    expect(citationKeyOf("EBHH.2012.K.1.")).toBe("ebhh.2012.k.1.");

    for (const { stored, key, cited } of cases) {
      for (const spelling of stored) {
        expect(storedKeys(spelling)).toEqual({
          type: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
          identifier: key,
          citationKey: key,
        });
      }
      for (const spelling of cited) {
        expect(citedKeys(`lásd ${spelling} alatt`)).toEqual({
          type: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
          identifier: key,
          citationKey: key,
        });
      }
    }
  });

  test("series without stored rows key the same way, and stay apart", () => {
    // No BH, BDT, KGD or ÍH row is stored today; their citations key in the
    // same dotted form so a row added later answers without a rewrite.
    const spellings = [
      ["BH 2019.123.", "BH2019. 123."],
      ["BH 2019.19", "BH2019. 19."],
      ["BH 2019.1.9", "BH 2019. 1. 9."],
      ["BH 2020.7.201", "BH 2020. 7. 201."],
      ["EBH2011. 2345.", "EBH 2011.2345"],
      ["BDT 2019.4012.", "BDT2019. 4012."],
      ["KGD 2020.15.", "KGD2020. 15."],
      ["ÍH 2018.45.", "ÍH2018. 45."],
    ];
    const keys = spellings.map((group) => {
      const groupKeys = new Set(
        group.map((spelling) => citedKeys(`lásd ${spelling} alatt`).identifier),
      );
      expect(groupKeys.size).toBe(1);
      return [...groupKeys][0];
    });

    expect(keys).toEqual([
      "bh.2019.123",
      "bh.2019.19",
      "bh.2019.1.9",
      "bh.2020.7.201",
      "ebh.2011.2345",
      "bdt.2019.4012",
      "kgd.2020.15",
      "íh.2018.45",
    ]);
  });

  test("every Hungarian key reads back as itself", () => {
    // A key is also what a reader types into an exact-identity lookup, which
    // canonicalizes again: a key that moved under its own canonicalization
    // would miss the row it names.
    const texts = [
      "Pfv.III.20.123/2019/5",
      "5.Gf.40.014/2023/15",
      "4/2021. Polgári jogegységi határozat",
      "PK vélemény 1/2014",
      "1.2019.KMPJE",
      "EBH..2013.K.32.",
      "BH 2020. 7. 201.",
      "ÍH2018. 45.",
    ];

    for (const text of texts) {
      const key = bareCitationKey(text);
      expect(bareCitationKey(key)).toBe(key);
    }
  });

  test("Constitutional Court decisions key by number and year", () => {
    const spellings = [
      [
        "3123/2019. (V. 30.) AB határozat",
        "3123/2019. (V.30.) AB határozat",
        "3123/2019. AB határozat",
        "3123/2019. (V. 30.) AB végzés",
      ],
      ["12/2020. (VI. 22.) AB határozat"],
    ];
    const keys = spellings.map((group) => {
      const groupKeys = new Set(
        group.map((spelling) => {
          const cited = citedKeys(`a ${spelling}ban`);
          expect(cited.type).toBe(DECISION_IDENTIFIER_TYPES.REPORTER_CITATION);
          return cited.identifier;
        }),
      );
      expect(groupKeys.size).toBe(1);
      return [...groupKeys][0];
    });

    expect(new Set(keys).size).toBe(spellings.length);
  });

  test("a docket beside its reporter entry stays two citations", () => {
    // A Czech collection number folds into the docket beside it; a Hungarian
    // docket already names one decision, and so does its reporter entry.
    const citations = extract("Kúria Pfv.20626/2022/4, BH2023. 129");

    expect(citations.map(({ citationText }) => citationText)).toEqual([
      "Pfv.20626/2022/4",
      "BH2023. 129",
    ]);
  });

  test("statutes, dates, decrees and editorial series are not decision citations", () => {
    const texts = [
      "a Polgári Törvénykönyvről szóló 2013. évi V. törvény (Ptk.) 6:519. §-a",
      "Budapest, 2019. május 30.",
      "Budapest, 2024.05.06.",
      "a 9/2006. (II.27.) IM rendelet 34. § (1) bekezdése",
      "a 15/1990. BM rendelet",
      "a BH-k alapjául szolgáló határozatok",
      "GK.34 és EBH számmal megjelölt határozatok",
      "a Pfv.20.123/2019. számú ügyben",
      "a jogegységi határozat szerint",
      "PK vélemény 1. pont",
    ];

    for (const text of texts) {
      expect(extract(text)).toEqual([]);
    }
  });

  test("Czech, Slovak, Polish and EU citations never read as Hungarian", () => {
    const foreign = [
      "sp. zn. 22 Cdo 1234/2019",
      "č. j. 8 As 287/2020-33",
      "sp. zn. 5Obdo/23/2016",
      "sp. zn. 36 Co 52/53/2023",
      "sygn. akt II CSK 123/19",
      "II CSK 123/19",
      "IV. ÚS 23/05",
      "C-283/81",
      "č. 123/2020 Sb. rozh. tr.",
    ];

    for (const text of foreign) {
      const citations = extract(text);
      expect(citations).toHaveLength(1);
      expect(
        citations.map((citation) =>
          hungarianCitationForm(citation.citationText),
        ),
      ).toEqual([null]);
    }
  });
});

describe("Constitutional Court rulings by their collection numbers", () => {
  // Pl. ÚS 18/01 as NALUS lists it: the gazette number the ruling was
  // published under, then its reporter entry.
  const ruling = {
    caseNumber: "Pl. ÚS 18/01",
    ecli: "ECLI:CZ:US:2002:Pl.US.18.01",
    metadata: { parallelQuotation: "234/2002 Sb.\nN 53/26 SbNU 73" },
  };
  const rulingIdentifiers = decisionIdentifiersFromStoredMetadata(ruling);
  const reaches = (citation: {
    identifierType: DecisionIdentifierType;
    identifierValue: string;
  }): boolean =>
    rulingIdentifiers.some(
      (identifier) =>
        identifier.type === citation.identifierType &&
        normalizeDecisionIdentifier(identifier) ===
          normalizeDecisionIdentifierValue(
            citation.identifierType,
            citation.identifierValue,
          ),
    );

  test("derives both parallel citations from stored metadata", () => {
    expect(rulingIdentifiers).toEqual([
      { type: DECISION_IDENTIFIER_TYPES.CASE_NUMBER, value: "Pl. ÚS 18/01" },
      { type: DECISION_IDENTIFIER_TYPES.ECLI, value: ruling.ecli },
      {
        type: DECISION_IDENTIFIER_TYPES.REPORTER_CITATION,
        value: "234/2002 Sb.",
      },
      {
        type: DECISION_IDENTIFIER_TYPES.REPORTER_CITATION,
        value: "N 53/26 SbNU 73",
      },
    ]);
  });

  test("reads the record card's cells the same way, once each", () => {
    expect(
      decisionIdentifiersFromStoredMetadata({
        ...ruling,
        metadata: {
          ...ruling.metadata,
          parallelCitationLaws: "234/2002 Sb.",
          parallelCitationReports: ["N 53/26 SbNU 73"],
        },
      }),
    ).toEqual(rulingIdentifiers);
  });

  test("a parallel citation in neither form is no identifier", () => {
    expect(
      decisionIdentifiersFromStoredMetadata({
        ...ruling,
        metadata: { parallelQuotation: "NALUS 14/24" },
      }),
    ).toHaveLength(2);
  });

  test("a ruling's gazette number is read after the ruling is named, never an act's", () => {
    const text =
      "Ustanovení § 31 odst. 4 zákona č. 82/1998 Sb., ve znění nálezu " +
      "Ústavního soudu č. 234/2002 Sb., bylo …";
    const citations = extractCitations([{ index: 0, text }]);
    expect(citations).toHaveLength(1);
    expect(citations[0]).toMatchObject({
      citationText: "234/2002 Sb.",
      identifierType: DECISION_IDENTIFIER_TYPES.REPORTER_CITATION,
    });
    expect(citations.every(reaches)).toBe(true);
  });

  test("an amendment list reads only the ruling among the acts", () => {
    const text =
      "ve znění zákonů č. 585/2006 Sb., č. 181/2007 Sb., č. 261/2007 Sb., " +
      "č. 296/2007 Sb. a č. 362/2007 Sb., nálezu Ústavního soudu č. " +
      "116/2008 Sb., a zákonů č. 121/2008 Sb., č. 126/2008 Sb.";
    expect(
      extractCitations([{ index: 0, text }]).map((c) => c.citationText),
    ).toEqual(["116/2008 Sb."]);
  });

  test("an act named after the ruling is not read as the ruling", () => {
    const text =
      "V nálezu Ústavního soudu ve věci zákona č. 82/1998 Sb. se uvádí";
    expect(extractCitations([{ index: 0, text }])).toEqual([]);
  });

  test("the court's own announcement of its number is a self-citation", () => {
    const text =
      "jako vedlejších účastníků řízení (nález byl vyhlášen pod č. " +
      "437/2012 Sb.). I. Ustanovení";
    const [citation] = extractCitations([{ index: 0, text }]);
    expect(citation?.citationText).toBe("437/2012 Sb.");
    expect(
      isSelfCitation(
        citation?.citationText ?? "",
        decisionIdentifiersFromStoredMetadata({
          caseNumber: "Pl. ÚS 1/12",
          ecli: null,
          metadata: {
            parallelCitationLaws: "437/2012 Sb.",
            parallelCitationReports: "N 195/67 SbNU 333",
          },
        }),
      ),
    ).toBe(true);
  });

  test("a docket followed by its reporter entry stays one citation of the docket", () => {
    const text =
      "srov. nález ze dne 22. března 1994 sp. zn. Pl. ÚS 37/93 (N 9/1 SbNU " +
      "61; 86/1994 Sb.); nález ze dne 7. června 1994 sp. zn. I. ÚS 2/93 " +
      "(N 37/1 SbNU 267)]. Všechny";
    expect(
      extractCitations([{ index: 0, text }]).map((c) => [
        c.citationText,
        c.identifierType,
        c.identifierValue,
      ]),
    ).toEqual([
      ["Pl. ÚS 37/93", DECISION_IDENTIFIER_TYPES.CASE_NUMBER, "Pl. ÚS 37/93"],
      ["I. ÚS 2/93", DECISION_IDENTIFIER_TYPES.CASE_NUMBER, "I. ÚS 2/93"],
    ]);
  });

  test("a docket followed by the gazette number it was published under stays one citation of the docket", () => {
    const text =
      "nálezem pléna Ústavního soudu ze dne 13. 3. 2002, sp. zn. Pl. ÚS " +
      "18/01, vyhlášeným pod č. 234/2002 Sb., bylo zrušeno";
    const citations = extractCitations([{ index: 0, text }]);
    expect(citations).toHaveLength(1);
    expect(citations[0]).toMatchObject({
      citationText: "Pl. ÚS 18/01",
      identifierType: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
    });
    expect(citations.every(reaches)).toBe(true);
  });

  test("every inflection of the published-under words introduces the gazette number", () => {
    for (const participle of [
      "publikovaného",
      "publikovaným",
      "publikovaný",
      "vyhlášeného",
      "uveřejněného",
    ]) {
      const text = `v rozporu s nálezem Ústavního soudu ${participle} pod č. 234/2002 Sb. se`;
      expect(
        extractCitations([{ index: 0, text }]).map((c) => c.citationText),
      ).toEqual(["234/2002 Sb."]);
    }
  });

  test("the spelled-out volume and number reach the entry without its page", () => {
    const text =
      "srov. např. Sbírka nálezů a usnesení Ústavního soudu, svazek 26, " +
      "nález č. 53";
    const citations = extractCitations([{ index: 0, text }]);
    expect(citations).toHaveLength(1);
    expect(citations[0]?.identifierValue).toBe(
      "Sbírka nálezů a usnesení Ústavního soudu, svazek 26, nález č. 53",
    );
    expect(citations.every(reaches)).toBe(true);
  });

  test("an entry whose series the text leaves unsaid is not read", () => {
    const text =
      "(nález Ústavního soudu ze dne 11. 5. 2004, sp. zn. III. ÚS 266/03, " +
      "uveřejněného ve Sbírce nálezů a usnesení, sv. 33, pod č. 67).";
    expect(
      extractCitations([{ index: 0, text }]).map((c) => c.identifierType),
    ).toEqual([DECISION_IDENTIFIER_TYPES.CASE_NUMBER]);
  });

  test("reporter entries that differ only in where the slash falls stay apart", () => {
    const entry = (value: string) =>
      normalizeDecisionIdentifierValue(
        DECISION_IDENTIFIER_TYPES.REPORTER_CITATION,
        value,
      );
    expect(entry("N 53/26 SbNU 73")).not.toBe(entry("N 5/326 SbNU 73"));
    expect(entry("N 53/26 SbNU 73")).not.toBe(entry("U 53/26 SbNU 73"));
    expect(entry("N 53/26 SbNU 73")).toBe(entry("N 53/26 SbNU"));
  });
});
