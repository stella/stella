import { describe, expect, test } from "bun:test";

import {
  CITATION_KIND,
  CITATION_KIND_EVIDENCE,
  classifyCitation,
  classifyCitationVerdict,
  proceduralKeysFromMetadata,
} from "@/api/lib/case-law/citation-kind";

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

/**
 * Polish, where the registry prior used to be wrong for a whole court tier.
 *
 * Every test here asserts the evidence tier as well as the kind, which is
 * what makes one cue per test mean something: `CONTEXT` is only returned
 * when exactly one of the two cue lists matched, so a sentence that
 * accidentally carried a second cue would report `REGISTRY` and fail rather
 * than pass for the wrong reason. The cue tests all cite an unlisted
 * register (`I C`, a district civil number) or a listed one (`II CSK`), so
 * removing the cue under test flips the answer to the registry's default.
 */
describe("Polish cues and registries", () => {
  /** Falls back to procedural: the district registers are not authority. */
  const DISTRICT = "sygn. akt I C 1234/19";
  /** Falls back to precedent: the Supreme Court's civil cassation register. */
  const SUPREME = "sygn. akt II CSK 123/20";

  const contextVerdict = (citationText: string, context: string) =>
    classifyCitationVerdict({ citationText, context });

  test("por. points at an authority", () => {
    expect(
      contextVerdict(
        DISTRICT,
        "Por. stanowisko Sądu Najwyższego przyjęte w sprawie sygn. akt I C 1234/19.",
      ),
    ).toEqual({
      kind: CITATION_KIND.PRECEDENT,
      evidence: CITATION_KIND_EVIDENCE.CONTEXT,
    });
  });

  test("zob. points at an authority", () => {
    expect(
      contextVerdict(
        DISTRICT,
        "Zob. stanowisko Sądu Najwyższego przyjęte w sprawie sygn. akt I C 1234/19.",
      ),
    ).toEqual({
      kind: CITATION_KIND.PRECEDENT,
      evidence: CITATION_KIND_EVIDENCE.CONTEXT,
    });
  });

  test("tak też marks agreement with a cited holding", () => {
    expect(
      contextVerdict(
        DISTRICT,
        "Tak też Sąd Najwyższy w sprawie sygn. akt I C 1234/19.",
      ),
    ).toEqual({
      kind: CITATION_KIND.PRECEDENT,
      evidence: CITATION_KIND_EVIDENCE.CONTEXT,
    });
  });

  test("podobnie marks agreement with a cited holding", () => {
    expect(
      contextVerdict(
        DISTRICT,
        "Podobnie Sąd Najwyższy w sprawie sygn. akt I C 1234/19.",
      ),
    ).toEqual({
      kind: CITATION_KIND.PRECEDENT,
      evidence: CITATION_KIND_EVIDENCE.CONTEXT,
    });
  });

  test("zgodnie z marks reliance on a cited holding", () => {
    expect(
      contextVerdict(
        DISTRICT,
        "Zgodnie z poglądem przyjętym w sprawie sygn. akt I C 1234/19 roszczenie nie wygasło.",
      ),
    ).toEqual({
      kind: CITATION_KIND.PRECEDENT,
      evidence: CITATION_KIND_EVIDENCE.CONTEXT,
    });
  });

  test("w wyroku z dnia introduces a cited holding", () => {
    expect(
      contextVerdict(
        DISTRICT,
        "Sąd Najwyższy w wyroku z dnia 5 maja 2019 r., sygn. akt I C 1234/19, przyjął odmienne stanowisko.",
      ),
    ).toEqual({
      kind: CITATION_KIND.PRECEDENT,
      evidence: CITATION_KIND_EVIDENCE.CONTEXT,
    });
  });

  test("w uchwale introduces a cited resolution", () => {
    expect(
      contextVerdict(
        DISTRICT,
        "Sąd Najwyższy w uchwale sygn. akt I C 1234/19 rozstrzygnął tę rozbieżność.",
      ),
    ).toEqual({
      kind: CITATION_KIND.PRECEDENT,
      evidence: CITATION_KIND_EVIDENCE.CONTEXT,
    });
  });

  test("ugruntowan marks settled case law", () => {
    expect(
      contextVerdict(
        DISTRICT,
        "Pogląd ten jest ugruntowany w orzecznictwie, sygn. akt I C 1234/19.",
      ),
    ).toEqual({
      kind: CITATION_KIND.PRECEDENT,
      evidence: CITATION_KIND_EVIDENCE.CONTEXT,
    });
  });

  test("utrwalon marks settled case law", () => {
    expect(
      contextVerdict(
        DISTRICT,
        "Utrwalona linia orzecznicza, sygn. akt I C 1234/19, przyjmuje inaczej.",
      ),
    ).toEqual({
      kind: CITATION_KIND.PRECEDENT,
      evidence: CITATION_KIND_EVIDENCE.CONTEXT,
    });
  });

  test("zaskarżon names the judgment under appeal", () => {
    expect(
      contextVerdict(
        SUPREME,
        "Sąd oddalił apelację od zaskarżonego wyroku, sygn. akt II CSK 123/20.",
      ),
    ).toEqual({
      kind: CITATION_KIND.PROCEDURAL,
      evidence: CITATION_KIND_EVIDENCE.CONTEXT,
    });
  });

  test("od wyroku names what the appeal was brought from", () => {
    expect(
      contextVerdict(
        SUPREME,
        "Skarga kasacyjna od wyroku Sądu Apelacyjnego, sygn. akt II CSK 123/20.",
      ),
    ).toEqual({
      kind: CITATION_KIND.PROCEDURAL,
      evidence: CITATION_KIND_EVIDENCE.CONTEXT,
    });
  });

  test("sygn. akt alone decides nothing", () => {
    // The citation prefix is not a cue and must never become one: it stands
    // in front of an authority and a recital alike, so a list carrying it
    // would push every Polish citation onto whichever side it was added to.
    expect(
      contextVerdict(
        "sygn. akt I ACa 1234/20",
        "wyrok Sądu Apelacyjnego w Warszawie, sygn. akt I ACa 1234/20",
      ),
    ).toEqual({
      kind: CITATION_KIND.PRECEDENT,
      evidence: CITATION_KIND_EVIDENCE.REGISTRY,
    });
  });

  test("an appellate mark is authority on the registry alone", () => {
    // One assertion per register, so dropping any single entry fails here.
    // The `z` marks are the interlocutory register of the same courts.
    for (const citationText of [
      "sygn. akt I ACa 1234/20",
      "sygn. akt II AKa 210/19",
      "sygn. akt III AUa 55/21",
      "sygn. akt I AGa 88/22",
      "sygn. akt III APa 12/18",
      "sygn. akt I ACz 431/17",
      "sygn. akt II AKz 902/20",
      "sygn. akt III AUz 71/21",
      "sygn. akt I AGz 64/22",
      "sygn. akt III APz 9/19",
    ]) {
      expect(classifyCitationVerdict({ citationText, context: null })).toEqual({
        kind: CITATION_KIND.PRECEDENT,
        evidence: CITATION_KIND_EVIDENCE.REGISTRY,
      });
    }
  });

  test("a supreme-administrative mark is authority on the registry alone", () => {
    for (const citationText of [
      "sygn. akt II OSK 1234/19",
      "sygn. akt I FSK 456/18",
      "sygn. akt II GSK 789/20",
      "sygn. akt I OPS 3/19",
      "sygn. akt I FPS 2/18",
      "sygn. akt II GPS 1/17",
      "sygn. akt I ONP 4/06",
    ]) {
      expect(classifyCitationVerdict({ citationText, context: null })).toEqual({
        kind: CITATION_KIND.PRECEDENT,
        evidence: CITATION_KIND_EVIDENCE.REGISTRY,
      });
    }
  });

  test("a regional administrative mark is still not authority", () => {
    // WSA is knowingly absent: `registryOf` stops at the slash and would key
    // on the bare `sa`, the seat that identifies the court dropped. This
    // pins the gap so that adding WSA is a deliberate edit here, not a
    // silent side effect of loosening the reader.
    expect(
      classifyCitationVerdict({
        citationText: "sygn. akt I SA/Wa 123/20",
        context: null,
      }),
    ).toEqual({
      kind: CITATION_KIND.PROCEDURAL,
      evidence: CITATION_KIND_EVIDENCE.REGISTRY,
    });
  });

  test("a district mark is not authority", () => {
    // The other half of the appellate entries: what a Polish appellate
    // judgment names as its own history stays procedural.
    expect(
      classifyCitationVerdict({ citationText: DISTRICT, context: null }),
    ).toEqual({
      kind: CITATION_KIND.PROCEDURAL,
      evidence: CITATION_KIND_EVIDENCE.REGISTRY,
    });
  });
});
