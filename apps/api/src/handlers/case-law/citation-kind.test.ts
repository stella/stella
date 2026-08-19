import { describe, expect, test } from "bun:test";

import {
  CITATION_KIND,
  CITATION_KIND_EVIDENCE,
  classifyCitation,
  classifyCitationVerdict,
  proceduralKeysFromMetadata,
} from "@/api/handlers/case-law/citation-kind";

/**
 * The contexts below are the shapes real decisions use, because the
 * distinction is not a property of the citation string — the same case
 * number reads as authority in one sentence and as the case's own history
 * in another. Each case states which signal is expected to decide it.
 */

describe("context decides when it speaks", () => {
  test("an appeal recital is procedural even for a supreme-court registry", () => {
    expect(
      classifyCitation({
        citationText: "č. j. 8 Co 39/2018",
        context:
          "o dovolání žalovaného proti rozsudku Krajského soudu v Ostravě ze dne 20. dubna 2018, č. j. 8 Co 39/2018-72, takto:",
      }),
    ).toBe(CITATION_KIND.PROCEDURAL);
  });

  test("a compare-cue marks precedent even for a lower-court registry", () => {
    // A regional judgment reported in the official collection is cited as
    // authority; the registry alone would have called this procedural.
    expect(
      classifyCitation({
        citationText: "sp. zn. 15 Ca 609/2000",
        context:
          "K tomu srov. rozsudek KS Ústí nad Labem ze dne 7. 2. 2003, sp. zn. 15 Ca 609/2000, publikovaný pod č. 551/2005 Sb. NSS.",
      }),
    ).toBe(CITATION_KIND.PRECEDENT);
  });

  test("a settled-case-law cue marks precedent", () => {
    expect(
      classifyCitation({
        citationText: "sp. zn. 29 Cdo 1983/2013",
        context:
          "srov. shodně např. usnesení Nejvyššího soudu ze dne 29. 8. 2013, sp. zn. 29 Cdo 1983/2013",
      }),
    ).toBe(CITATION_KIND.PRECEDENT);
  });

  // One cue per test, so removing any single alternative fails its test.
  test("a complaint against a court's conduct is procedural even for a supreme-court registry", () => {
    expect(
      classifyCitation({
        citationText: "sp. zn. 1 Tdo 4/2008",
        context:
          "postupom Najvyššieho súdu Slovenskej republiky sp. zn. 1 Tdo 4/2008 a jeho uznesením z 20. februára 2008",
      }),
    ).toBe(CITATION_KIND.PROCEDURAL);
  });

  test("the proceedings a complaint names are procedural", () => {
    expect(
      classifyCitation({
        citationText: "sp. zn. 1 Tdo 4/2008",
        context:
          "Najvyššieho súdu Slovenskej republiky v konaní vedenom pod sp. zn. 1 Tdo 4/2008 a jeho uznesením z 20. februára 2008",
      }),
    ).toBe(CITATION_KIND.PROCEDURAL);
  });

  test("the operative-part lead-in marks the recitals", () => {
    expect(
      classifyCitation({
        citationText: "sp. zn. 3 Tdo 48/2015",
        context:
          "a uznesením Najvyššieho súdu Slovenskej republiky sp. zn. 3 Tdo 48/2015 z 11. novembra 2015 a takto rozhodol:",
      }),
    ).toBe(CITATION_KIND.PROCEDURAL);
  });

  test("a precedent invoked by the ordinary Slovak formula stays precedent", () => {
    // `v konaní vedenom` alone would read as a recital; the Slovak
    // precedent verb makes it a tie, and the registry settles it.
    expect(
      classifyCitation({
        citationText: "sp. zn. II. ÚS 251/04",
        context:
          "Ústavný súd v konaní vedenom pod sp. zn. II. ÚS 251/04 konštatoval, že",
      }),
    ).toBe(CITATION_KIND.PRECEDENT);
  });

  test("a file kept by the court below is procedural on context, not registry", () => {
    expect(
      classifyCitationVerdict({
        citationText: "sp. zn. 2 T 31/2006",
        context:
          "v trestnej veci vedenej okresným súdom pod sp. zn. 2 T 31/2006 (v nej bol sťažovateľovi uložený trest odňatia slobody)",
      }),
    ).toEqual({
      kind: CITATION_KIND.PROCEDURAL,
      evidence: CITATION_KIND_EVIDENCE.CONTEXT,
    });
  });

  test("first-instance file references are procedural", () => {
    expect(
      classifyCitation({
        citationText: "sp. zn. 19 C 332/2011",
        context:
          "vedené u Obvodního soudu pro Prahu 2 pod sp. zn. 19 C 332/2011, o dovolání žalované proti rozsudku Městského soudu v Praze",
      }),
    ).toBe(CITATION_KIND.PROCEDURAL);
  });
});

describe("the registry decides when context does not", () => {
  test("a published-court registry falls back to precedent", () => {
    expect(
      classifyCitation({
        citationText: "sp. zn. 21 Cdo 1234/2020",
        context: null,
      }),
    ).toBe(CITATION_KIND.PRECEDENT);
  });

  test("a first-instance registry falls back to procedural", () => {
    expect(
      classifyCitation({ citationText: "27 Co 221/2019", context: null }),
    ).toBe(CITATION_KIND.PROCEDURAL);
  });

  test("a constitutional-court citation is precedent", () => {
    expect(
      classifyCitation({ citationText: "II. ÚS 251/04", context: null }),
    ).toBe(CITATION_KIND.PRECEDENT);
  });

  test("a Polish supreme-court registry is precedent", () => {
    expect(
      classifyCitation({
        citationText: "sygn. akt II CSK 123/20",
        context: null,
      }),
    ).toBe(CITATION_KIND.PRECEDENT);
  });

  test("a chamber-less kolegium opinion is precedent", () => {
    // A "stanovisko" carries no chamber number, so the registry reader used
    // to find no mark at all and every opinion fell through to procedural —
    // the one document class issued specifically to unify practice. These
    // are real file numbers: the registers use disjoint number ranges, so a
    // shape invented from one would not stand in for the others.
    for (const citationText of [
      "Cpjn 203/2010",
      "sp. zn. Cpjn 206/2010",
      "Tpjn 300/2017",
      "sp. zn. Opjn 8/2006",
    ]) {
      expect(classifyCitation({ citationText, context: null })).toBe(
        CITATION_KIND.PRECEDENT,
      );
    }
  });

  test("a chamber-less first-instance mark is still procedural", () => {
    // The bare-mark reader promotes nothing on its own: an unlisted registry
    // falls through exactly as an unreadable one did.
    expect(
      classifyCitation({ citationText: "Nt 408/2023", context: null }),
    ).toBe(CITATION_KIND.PROCEDURAL);
  });

  test("a grand-chamber citation is precedent", () => {
    // Slovak grand-chamber numbers are senate-prefixed and slash-separated,
    // with no space after the senate; the Supreme Administrative Court's
    // spaces its mark instead. Both spellings have to reach the registry.
    for (const citationText of [
      "1VCdo/9/2025",
      "1VObdo/2/2026",
      "1 SVs 1/2021",
    ]) {
      expect(classifyCitation({ citationText, context: null })).toBe(
        CITATION_KIND.PRECEDENT,
      );
    }
  });

  test("a Polish legal-question resolution is precedent", () => {
    // The Roman chamber prefix drifts as chambers are reorganised, so the
    // mark alone decides.
    expect(
      classifyCitation({ citationText: "III PZP 1/21", context: null }),
    ).toBe(CITATION_KIND.PRECEDENT);
  });

  test("context carrying both cues falls back to the registry", () => {
    // "srov." and an appeal recital in one window: the string alone cannot
    // arbitrate, so publication status decides rather than cue order.
    expect(
      classifyCitation({
        citationText: "sp. zn. 30 Cdo 1417/2016",
        context:
          "proti rozsudku odvolacího soudu, srov. rozsudek Nejvyššího soudu sp. zn. 30 Cdo 1417/2016",
      }),
    ).toBe(CITATION_KIND.PRECEDENT);
  });
});

describe("the publisher outranks every heuristic", () => {
  const keys = new Set(["iiaca 123/19"]);

  test("a case the publisher lists as procedural history is procedural", () => {
    // Cues and registry both argue for precedent; the court's own
    // statement that this judgment is below it in the same case wins.
    expect(
      classifyCitation({
        citationText: "sygn. akt II ACa 123/19",
        citationKey: "iiaca 123/19",
        proceduralKeys: keys,
        context: "srov. wyrok Sądu Apelacyjnego, sygn. akt II ACa 123/19",
      }),
    ).toBe(CITATION_KIND.PROCEDURAL);
  });

  test("a case absent from that list still falls through to the cues", () => {
    expect(
      classifyCitation({
        citationText: "sygn. akt II CSK 999/20",
        citationKey: "iicsk 999/20",
        proceduralKeys: keys,
        context: "srov. wyrok Sądu Najwyższego, sygn. akt II CSK 999/20",
      }),
    ).toBe(CITATION_KIND.PRECEDENT);
  });
});

describe("proceduralKeysFromMetadata", () => {
  const identity = (caseNumber: string) => caseNumber.toLowerCase();

  test("reads the publisher's lower-court judgments", () => {
    expect([
      ...proceduralKeysFromMetadata(
        { lowerCourtJudgments: [{ caseNumber: "II ACa 123/19" }] },
        identity,
      ),
    ]).toEqual(["ii aca 123/19"]);
  });

  test("ignores the publisher's list of cited authorities", () => {
    // referencedCourtCases is the opposite claim: authorities the decision
    // cites, not judgments it passed through.
    expect(
      proceduralKeysFromMetadata(
        { referencedCourtCases: [{ caseNumber: "II CSK 1/20" }] },
        identity,
      ).size,
    ).toBe(0);
  });

  test("tolerates absent or malformed metadata", () => {
    expect(proceduralKeysFromMetadata(null, identity).size).toBe(0);
    expect(
      proceduralKeysFromMetadata({ lowerCourtJudgments: "nope" }, identity)
        .size,
    ).toBe(0);
  });
});
