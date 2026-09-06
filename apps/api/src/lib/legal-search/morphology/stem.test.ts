import { describe, expect, test } from "bun:test";

import { readConformanceVocabulary } from "@/api/lib/legal-search/morphology/snowball/__fixtures__/vocabulary";
import { CzechStemmer } from "@/api/lib/legal-search/morphology/snowball/czech.gen";
import { PolishStemmer } from "@/api/lib/legal-search/morphology/snowball/polish.gen";
import {
  MORPHOLOGY_LANGUAGES,
  stemLegalTerm,
} from "@/api/lib/legal-search/morphology/stem";

/**
 * One legal paradigm per language, chosen so a stemmer that silently became
 * an identity function (a broken generated module) fails here, and so no two
 * languages produce the same stems for it: a dispatch wired to a neighbouring
 * algorithm has to show up somewhere, and the test below holds the table to
 * that.
 */
const PARADIGMS = {
  cs: [
    ["rozsudku", "rozsudk"],
    ["smlouvy", "smlouv"],
    ["žalobě", "žalob"],
    ["soudu", "soud"],
  ],
  da: [
    ["dommene", "dom"],
    ["afgørelsen", "afgør"],
    ["kontrakter", "kontrak"],
    ["domstolene", "domstol"],
  ],
  de: [
    ["urteile", "urteil"],
    ["verträge", "vertrag"],
    ["gerichten", "gericht"],
    ["klagen", "klag"],
  ],
  el: [
    ["δικαστηρίου", "δικαστηρ"],
    ["αποφάσεις", "αποφασ"],
    ["συμβάσεις", "συμβασ"],
    ["προσφυγές", "προσφυγ"],
  ],
  en: [
    ["judgments", "judgment"],
    ["liabilities", "liabil"],
    ["proceedings", "proceed"],
    ["enforceable", "enforc"],
  ],
  es: [
    ["sentencias", "sentenci"],
    ["contratos", "contrat"],
    ["tribunales", "tribunal"],
    ["demandas", "demand"],
  ],
  et: [
    ["kohtuotsused", "kohtuotsuse"],
    ["lepingud", "lepingu"],
    ["kohtutes", "koh"],
    ["hagid", "hagi"],
  ],
  fi: [
    ["tuomioistuimet", "tuomioistuim"],
    ["sopimukset", "sopimuks"],
    ["tuomiot", "tuomio"],
    ["kanteet", "kant"],
  ],
  fr: [
    ["jugements", "jug"],
    ["contrats", "contrat"],
    ["tribunaux", "tribunal"],
    ["requêtes", "requêt"],
  ],
  ga: [
    ["reachtaíochta", "reacht"],
    ["comhaontachta", "comhaont"],
    ["coirpiúlacht", "coirpiúl"],
    ["cúirteanna", "cúirteanna"],
  ],
  hu: [
    ["bíróságok", "bíróság"],
    ["szerződések", "szerződés"],
    ["ítéletek", "ítélet"],
    ["keresetek", "kereset"],
  ],
  it: [
    ["sentenze", "sentenz"],
    ["impugnazioni", "impugn"],
    ["risarcimento", "risarc"],
    ["tribunali", "tribunal"],
  ],
  lt: [
    ["teismai", "teism"],
    ["sutartys", "sutart"],
    ["sprendimai", "sprendim"],
    ["ieškiniai", "ieškin"],
  ],
  nl: [
    ["vonnissen", "vonnis"],
    ["overeenkomsten", "overeenkomst"],
    ["rechtbanken", "rechtbank"],
    ["vorderingen", "vorder"],
  ],
  pl: [
    ["wyroku", "wyrok"],
    ["umowy", "umow"],
    ["sądu", "sąd"],
    ["skargi", "skarg"],
  ],
  pt: [
    ["sentenças", "sentenc"],
    ["contratos", "contrat"],
    ["tribunais", "tribun"],
    ["recursos", "recurs"],
  ],
  ro: [
    ["hotărâri", "hotărâr"],
    ["judecătorești", "judecător"],
    ["instanțe", "instanț"],
    ["acțiuni", "acțiun"],
  ],
  sk: [
    ["rozsudkom", "rozsudk"],
    ["zmluvy", "zmluv"],
    ["žalobami", "žalob"],
    ["súdoch", "súd"],
  ],
  sv: [
    ["domarna", "dom"],
    ["avtalen", "avtal"],
    ["domstolar", "domstol"],
    ["överklaganden", "överklag"],
  ],
} as const satisfies Record<
  (typeof MORPHOLOGY_LANGUAGES)[number],
  readonly (readonly [string, string])[]
>;

describe("stemLegalTerm", () => {
  test("every declared language is dispatched, and only those", () => {
    // Both directions: the paradigm table and the exported language list must
    // agree, so adding a language without a paradigm (or vice versa) fails.
    expect<readonly string[]>(Object.keys(PARADIGMS).toSorted()).toEqual(
      [...MORPHOLOGY_LANGUAGES].toSorted(),
    );
  });

  test("each paradigm identifies the algorithm it is meant to exercise", () => {
    // Without this, a language whose paradigm another stemmer reproduces
    // would pass its own test while dispatching to the wrong algorithm.
    const indistinguishable = MORPHOLOGY_LANGUAGES.flatMap((language) => {
      const stems = (other: (typeof MORPHOLOGY_LANGUAGES)[number]) =>
        PARADIGMS[language]
          .map(([word]) => stemLegalTerm(word, other))
          .join(" ");
      return MORPHOLOGY_LANGUAGES.filter(
        (other) => other !== language && stems(other) === stems(language),
      ).map((other) => `${language} stems exactly like ${other}`);
    });

    expect<readonly string[]>(indistinguishable).toEqual([]);
  });

  for (const language of MORPHOLOGY_LANGUAGES) {
    test(`${language} stems inflected legal forms`, () => {
      const vectors = PARADIGMS[language];
      const actual = vectors.map(([word]) => [
        word,
        stemLegalTerm(word, language),
      ]);

      expect<readonly (readonly string[])[]>(actual).toEqual(
        vectors.map(([word, stem]) => [word, stem]),
      );

      // Non-trivial: a pass-through stemmer would leave every form untouched.
      expect<boolean>(
        vectors.some(([word]) => stemLegalTerm(word, language) !== word),
      ).toBe(true);
    });

    test(`${language} lowercases before stemming`, () => {
      const [vector] = PARADIGMS[language];
      const [word] = vector;

      expect<string>(stemLegalTerm(word.toUpperCase(), language)).toBe(
        stemLegalTerm(word, language),
      );
    });
  }

  test("a term an algorithm strips entirely still yields a stem", () => {
    // Estonian, Finnish and Lithuanian treat an apostrophe as ignorable and
    // stem it away completely. The stem stream stands in for the surface
    // stream position by position, so a token may never vanish from it.
    for (const language of MORPHOLOGY_LANGUAGES) {
      expect<string>(stemLegalTerm("'", language)).toBe("'");
    }
  });

  test("a decomposed term stems exactly like its precomposed form", () => {
    // The suffix tables hold precomposed code points, and toLowerCase()
    // preserves combining sequences, so without NFC at the entry point an
    // NFD term matches nothing and passes through unstemmed. Extracted text
    // arrives in whatever form its producer used. One vector per language,
    // each with an ending the decomposed form would otherwise strand:
    const vectors = [
      ["žalobě", "cs", "žalob"],
      ["książkę", "pl", "książk"],
      ["príčinách", "sk", "prík"],
    ] as const satisfies readonly (readonly [
      string,
      (typeof MORPHOLOGY_LANGUAGES)[number],
      string,
    ])[];

    for (const [word, language, expected] of vectors) {
      const decomposed = word.normalize("NFD");

      // The fixture must actually be decomposed, or this asserts nothing.
      expect<boolean>(decomposed === word.normalize("NFC")).toBe(false);
      expect<string>(stemLegalTerm(word.normalize("NFC"), language)).toBe(
        expected,
      );
      expect<string>(stemLegalTerm(decomposed, language)).toBe(expected);
    }
  });

  test("normalisation can lengthen a term, so the stem is not bounded by the raw input", () => {
    // U+1D1BB has a canonical decomposition and sits on the composition
    // exclusion list, so NFC expands it rather than recomposing it. Pinned
    // because it is the one shape where a stem is longer than the string
    // handed in, and a caller assuming otherwise would be wrong.
    const input = "\u{1D1BB}";

    expect<number>(input.length).toBe(2);
    expect<number>(input.normalize("NFC").length).toBe(4);
    expect<string>(stemLegalTerm(input, "cs")).toBe(input.normalize("NFC"));
  });

  test("the German sharp s expands to ss, so a stem can outgrow its term", () => {
    // The German algorithm's prelude rewrites the sharp s as "ss" before it
    // strips any suffix: the one expansion a stemmer performs itself. Pinned
    // so the growth bound in stem.property.test.ts stays honest about where
    // the extra code point comes from.
    expect<string>(stemLegalTerm("groß", "de")).toBe("gross");
    expect<string>(stemLegalTerm("\u1E9E", "de")).toBe("ss");
  });

  test("NFC and NFD agree across the whole reference vocabulary", () => {
    // 1123 of 2517 Czech and 454 of 2695 Polish words diverged before NFC
    // normalisation landed at the entry point; the class is wide enough that
    // the vocabulary, not a handful of vectors, is the right guard.
    const cases = [
      { language: "cs", pairs: readConformanceVocabulary("czech") },
      { language: "pl", pairs: readConformanceVocabulary("polish") },
    ] as const satisfies readonly {
      language: (typeof MORPHOLOGY_LANGUAGES)[number];
      pairs: readonly { readonly word: string }[];
    }[];

    for (const { language, pairs } of cases) {
      expect<number>(pairs.length).toBeGreaterThan(2000);

      const divergent = pairs
        .filter(
          ({ word }) =>
            stemLegalTerm(word.normalize("NFD"), language) !==
            stemLegalTerm(word.normalize("NFC"), language),
        )
        .slice(0, 10)
        .map(({ word }) => word);

      expect<readonly string[]>(divergent).toEqual([]);
    }
  });

  test("folding before stemming strands endings, which is why callers fold after", () => {
    // The ordering is load-bearing, not stylistic: the suffix tables are
    // written over accented characters, so a pre-folded term keeps the
    // ending the stemmer exists to strip. Measured over the committed
    // conformance vocabularies, fold-then-stem diverges from stem-then-fold
    // on ~16% of Czech and ~9% of Polish words; two of them:
    expect<string>(stemLegalTerm("absolutních", "cs")).toBe("absolutn");
    expect<string>(stemLegalTerm("absolutnich", "cs")).toBe("absolutnich");

    expect<string>(stemLegalTerm("absolwentów", "pl")).toBe("absolwent");
    expect<string>(stemLegalTerm("absolwentow", "pl")).toBe("absolwentow");
  });
});

/**
 * Stems are remembered between calls (see the memo in stem.ts). What the
 * memo may never do is change an answer, so these hold the public surface to
 * the algorithms it stands in front of.
 */
describe("remembered stems", () => {
  test("every language code is two characters, which the memo key relies on", () => {
    // The memo keys one shared structure as the code followed by the term.
    // A code of another width would let one language's term address another's
    // entry, so the width is a property of the list, not of the memo.
    expect<readonly string[]>(
      MORPHOLOGY_LANGUAGES.filter((language) => language.length !== 2),
    ).toEqual([]);
  });

  test("a remembered stem equals the algorithm's, over the whole vocabulary", () => {
    const cases = [
      { language: "cs", stemmer: new CzechStemmer(), algorithm: "czech" },
      { language: "pl", stemmer: new PolishStemmer(), algorithm: "polish" },
    ] as const satisfies readonly {
      language: (typeof MORPHOLOGY_LANGUAGES)[number];
      stemmer: { stem: (term: string) => string };
      algorithm: string;
    }[];

    for (const { language, stemmer, algorithm } of cases) {
      const pairs = readConformanceVocabulary(algorithm);
      expect<number>(pairs.length).toBeGreaterThan(2000);

      // Twice through, so the second pass reads what the first remembered,
      // and interleaved with the other language, so a shared structure that
      // confused the two would answer with the neighbour's stem.
      for (const pass of [1, 2]) {
        const divergent = pairs
          .filter(({ word }) => {
            const normalized = word.normalize("NFC").toLowerCase();
            const expected = stemmer.stem(normalized);
            return (
              stemLegalTerm(word, language) !==
              (expected === "" ? normalized : expected)
            );
          })
          .slice(0, 10)
          .map(({ word }) => `${algorithm} pass ${pass}: ${word}`);

        expect<readonly string[]>(divergent).toEqual([]);
      }
    }
  });

  test("a term too long to remember still stems like the algorithm", () => {
    // Tokenisation caps no length, so a malformed payload can hand the module
    // a token of any size. Those are not memoized (the memo's key ceiling),
    // which must cost the caller nothing but a recomputation.
    const stemmer = new CzechStemmer();
    for (const length of [8, 66, 67, 5000]) {
      const term = `${"rozhodnut".repeat(length)}ími`.slice(0, length);
      const normalized = term.normalize("NFC").toLowerCase();
      const expected = stemmer.stem(normalized);

      expect<[number, string]>([length, stemLegalTerm(term, "cs")]).toEqual([
        length,
        expected === "" ? normalized : expected,
      ]);
      expect<[number, string]>([length, stemLegalTerm(term, "cs")]).toEqual([
        length,
        expected === "" ? normalized : expected,
      ]);
    }
  });

  test("one term stems the same under every language that reads it", () => {
    // The shared memo is keyed by language as well as term; a key collision
    // would make whichever language asked first answer for the rest.
    const term = "rozhodnutia";
    const stems = MORPHOLOGY_LANGUAGES.map((language) =>
      stemLegalTerm(term, language),
    );

    expect<number>(new Set(stems).size).toBeGreaterThan(1);
    expect<readonly string[]>(
      MORPHOLOGY_LANGUAGES.map((language) => stemLegalTerm(term, language)),
    ).toEqual(stems);
  });
});
