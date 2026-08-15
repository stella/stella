/**
 * Reference vectors for the Slovak light stemmer.
 *
 * The `faithful` cases are ported verbatim from upstream's own suite
 * (`SlovakStemmerTest.java`, wikimedia/search-extra commit
 * 2ba556130dc6f8a505291c94d1d0f8b5ca078475), so a divergence from upstream
 * fails here rather than surfacing as a silent recall change.
 *
 * The `extended` cases pin the bare-`u` divergence in both directions: the
 * legal paradigms it exists for, and the upstream results it must not
 * disturb.
 */

import { describe, expect, test } from "bun:test";

import {
  stemSlovak,
  stemSlovakExtended,
} from "@/api/lib/legal-search/morphology/slovak";

/** Ported from upstream `SlovakStemmerTest.java`. */
const UPSTREAM_VECTORS = {
  caseRemoval: [
    ["automatoch", "autom"],
    ["dieťaťom", "dieť"],
    ["stříbrného", "stříbrn"],
    ["horthyovskému", "horthyovsk"],
    ["dojčaťa", "dojč"],
    ["pruskými", "prusk"],
    ["ranených", "ranen"],
    ["orkovi", "ork"],
  ],
  possessiveRemoval: [
    ["draľov", "draľ"],
    ["sinigrin", "sinigr"],
  ],
  palatalization: [
    ["venujúcich", "venujúk"],
    ["turečtiny", "tureck"],
    ["političtí", "politick"],
    ["dokážete", "dokáh"],
    ["zapíšte", "zapísk"],
  ],
  shortStrings: [
    ["očami", "oča"],
    ["inému", "inému"],
    ["cete", "cet"],
    ["noch", "noch"],
    ["hrách", "hrách"],
    ["maata", "maat"],
    ["vami", "vam"],
    ["nové", "nov"],
    ["ozov", "ozov"],
    ["špin", "špin"],
    ["najmä", "najmä"],
    ["najml", "najml"],
  ],
  general: [
    ["najznámejšími", "známejš"],
    ["najat", "naj"],
    ["bunkových", "bunk"],
    ["vysočinami", "vysok"],
    ["príčinách", "prík"],
    ["najnovšími", "novš"],
    ["najtestciných", "testk"],
  ],
  nonSlovak: [
    ["əliağa", "əliağ"],
    ["año", "año"],
    ["аблютомания", "аблютомания"],
    ["вищій", "вищій"],
    ["βικιπαίδεια", "βικιπαίδεια"],
    ["ვიკიპედია", "ვიკიპედია"],
    ["위키백과", "위키백과"],
    ["ውክፔዲያ", "ውክፔዲያ"],
    ["ᐅᐃᑭᐱᑎᐊ", "ᐅᐃᑭᐱᑎᐊ"],
  ],
} as const satisfies Record<string, readonly (readonly [string, string])[]>;

describe("stemSlovak", () => {
  for (const [group, vectors] of Object.entries(UPSTREAM_VECTORS)) {
    test(`matches upstream: ${group}`, () => {
      const actual = vectors.map(([word]) => [word, stemSlovak(word)]);
      expect<readonly (readonly string[])[]>(actual).toEqual(
        vectors.map(([word, stem]) => [word, stem]),
      );
    });
  }
});

describe("stemSlovakExtended", () => {
  test("strips the bare final u that upstream leaves in place", () => {
    const paradigms = [
      ["súdu", "súd"],
      ["zmluvu", "zmluv"],
      ["žalobu", "žalob"],
      ["rozsudku", "rozsudk"],
    ] as const;

    expect<readonly (readonly string[])[]>(
      paradigms.map(([word]) => [word, stemSlovakExtended(word)]),
    ).toEqual(paradigms.map(([word, stem]) => [word, stem]));

    // Upstream keeps the `u`; the divergence is exactly this, and nothing
    // else, which is why the variant ships off by default.
    expect<readonly string[]>(
      paradigms.map(([word]) => stemSlovak(word)),
    ).toEqual(["súdu", "zmluvu", "žalobu", "rozsudku"]);
  });

  test("diverges from upstream only where the faithful stem keeps a bare final u", () => {
    const divergent = Object.values(UPSTREAM_VECTORS)
      .flat()
      .filter(([word]) => stemSlovakExtended(word) !== stemSlovak(word))
      .map(([word]) => [word, stemSlovak(word), stemSlovakExtended(word)]);

    // Pinned, not merely bounded: the whole cost of the variant against
    // upstream's own vectors is this one short-string case.
    expect<readonly (readonly string[])[]>(divergent).toEqual([
      ["inému", "inému", "iném"],
    ]);
  });
});
