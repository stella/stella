import { describe, expect, test } from "bun:test";

import {
  CITATION_KIND,
  classifyCitation,
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
