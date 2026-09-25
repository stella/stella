/**
 * Reference vectors for the Slovak light stemmer.
 *
 * The upstream vectors are ported verbatim from upstream's own suite
 * (`SlovakStemmerTest.java`, wikimedia/search-extra commit
 * 2ba556130dc6f8a505291c94d1d0f8b5ca078475), so a divergence from upstream
 * fails here rather than surfacing as a silent recall change.
 *
 * The corpus stemmer diverges on purpose; the paradigm test below is what it
 * diverges for, and the vectors pin what it costs.
 */

import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { propertyConfig } from "@stll/property-testing";

import { foldCorpusTerm } from "@/api/lib/legal-search/corpus-passage-highlight";
import {
  stemSlovak,
  stemSlovakUpstream,
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

describe("stemSlovakUpstream", () => {
  for (const [group, vectors] of Object.entries(UPSTREAM_VECTORS)) {
    test(`matches upstream: ${group}`, () => {
      const actual = vectors.map(([word]) => [word, stemSlovakUpstream(word)]);
      expect<readonly (readonly string[])[]>(actual).toEqual(
        vectors.map(([word, stem]) => [word, stem]),
      );
    });
  }
});

/**
 * Every case form, singular then plural (nominative, genitive, dative,
 * accusative, locative, instrumental), of nouns across the declension
 * patterns legal text leans on: feminine `žena` (škoda, náhrada, pokuta,
 * zmluva), masculine inanimate `dub` (pomer, súd) and neuter `vysvedčenie`
 * (rozhodnutie).
 */
const PARADIGMS = {
  škod: "škoda škody škode škodu škode škodou škody škôd škodám škody škodách škodami",
  náhrad:
    "náhrada náhrady náhrade náhradu náhrade náhradou náhrady náhrad náhradám náhrady náhradách náhradami",
  pokut:
    "pokuta pokuty pokute pokutu pokute pokutou pokuty pokút pokutám pokuty pokutách pokutami",
  zmluv:
    "zmluva zmluvy zmluve zmluvu zmluve zmluvou zmluvy zmlúv zmluvám zmluvy zmluvách zmluvami",
  pomer:
    "pomer pomeru pomeru pomer pomere pomerom pomery pomerov pomerom pomery pomeroch pomermi",
  súd: "súd súdu súdu súd súde súdom súdy súdov súdom súdy súdoch súdmi",
  rozhodnut:
    "rozhodnutie rozhodnutia rozhodnutiu rozhodnutie rozhodnutí rozhodnutím rozhodnutia rozhodnutí rozhodnutiam rozhodnutia rozhodnutiach rozhodnutiami",
} as const;

describe("stemSlovak", () => {
  test("every case form of a noun meets one stem in the index", () => {
    // Compared folded, as the stem field's tokenizer stores it: the genitive
    // plural lengthens the root vowel (`škôd`, `zmlúv`), which no suffix
    // table can undo and folding does.
    for (const [stem, forms] of Object.entries(PARADIGMS)) {
      const stems = new Set(
        forms.split(" ").map((form) => foldCorpusTerm(stemSlovak(form))),
      );
      expect([...stems], stem).toEqual([foldCorpusTerm(stem)]);
    }
  });

  test("diverges from upstream only where upstream splits a paradigm", () => {
    const divergent = Object.values(UPSTREAM_VECTORS)
      .flat()
      .filter(([word]) => stemSlovak(word) !== stemSlovakUpstream(word))
      .map(([word]) => [word, stemSlovakUpstream(word), stemSlovak(word)]);

    // Pinned, not merely bounded: the whole cost against upstream's own
    // vectors is this one pronoun, which the function-word list drops before
    // it is stemmed.
    expect<readonly (readonly string[])[]>(divergent).toEqual([
      ["inému", "inému", "iném"],
    ]);
  });

  test("short words pass through, and no stem ends shorter than three", () => {
    for (const word of ["mu", "ju", "tu", "psu", "súd", "dom", "ním", "tým"]) {
      expect(stemSlovak(word), word).toBe(word);
    }
    expect(stemSlovak("domu")).toBe("dom");

    const letters = "aáäbcčdďeéfghiíjklĺľmnňoóôpqrŕsštťuúvwxyýzž".split("");
    fc.assert(
      fc.property(
        fc.string({
          unit: fc.constantFrom(...letters),
          minLength: 1,
          maxLength: 16,
        }),
        (word) => {
          const stem = stemSlovak(word);
          expect(stem.length).toBeGreaterThanOrEqual(Math.min(word.length, 3));
          if (word.length <= 3) {
            expect(stem).toBe(word);
          }
        },
      ),
      propertyConfig({ numRuns: 2000 }),
    );
  });
});
