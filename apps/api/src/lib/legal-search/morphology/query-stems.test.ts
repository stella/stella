import { describe, expect, test } from "bun:test";
/**
 * A word typed without its diacritics asks for the stem the index holds for
 * the accented word.
 *
 * The index holds `fold(stem(word))`: documents are stemmed accented and the
 * engine folds afterwards. A reader who leaves the marks off types
 * `fold(word)`, so the query has to reach `fold(stem(word))` from there. Each
 * check below runs the real stemmers on both sides; nothing is mocked.
 */
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";
import { normalizeUnicode } from "@stll/text-normalize";

import { foldLatinLetters } from "@/api/lib/legal-search/morphology/latin-fold";
import { readConformanceVocabulary } from "@/api/lib/legal-search/morphology/snowball/__fixtures__/vocabulary";
import {
  MORPHOLOGY_LANGUAGES,
  type MorphologyLanguage,
  queryStems,
  stemLegalTerm,
} from "@/api/lib/legal-search/morphology/stem";

/**
 * The languages with folded stemmers: every one but Greek, whose letters the
 * index does not fold, and English, whose tables hold no diacritic.
 */
type FoldedLanguage = Exclude<MorphologyLanguage, "el" | "en">;

const FOLDED_LANGUAGES = MORPHOLOGY_LANGUAGES.filter(
  (language): language is FoldedLanguage =>
    language !== "el" && language !== "en",
);

/** Legal vocabulary in the inflections a decision writes, per language. */
const LEGAL_VOCABULARY = {
  cs: [
    "nájemného",
    "nájemní",
    "nájemném",
    "nájemního",
    "dědického",
    "dědictví",
    "bezdůvodného",
    "bezdůvodné",
    "obohacení",
    "škodou",
    "škody",
    "škodě",
    "odpovědnosti",
    "odpovědnost",
    "smlouvy",
    "smlouvou",
    "smlouvě",
    "náhrady",
    "újmy",
    "újmou",
    "řízení",
    "žalobce",
    "žalovaného",
    "právního",
    "ustanovení",
    "vlastnického",
    "prodlení",
    "výpovědi",
    "zaměstnavatele",
    "prodávajícího",
  ],
  sk: [
    "nájomného",
    "nájomnej",
    "dedičského",
    "bezdôvodného",
    "škodou",
    "zodpovednosti",
    "zmluvou",
    "náhrady",
    "žalobcu",
    "žalovaného",
    "súdu",
    "súdov",
    "právneho",
    "vlastníckeho",
    "úrokov",
    "omeškania",
    "výpovede",
    "zamestnávateľa",
    "kúpnej",
    "rozhodnutím",
  ],
  pl: [
    "odszkodowaniem",
    "szkodą",
    "szkodę",
    "odpowiedzialności",
    "odpowiedzialność",
    "umową",
    "umowę",
    "sądu",
    "sądowi",
    "zadośćuczynienia",
    "zadośćuczynieniem",
    "przepisów",
    "ustawą",
    "roszczeń",
    "należności",
    "świadczenia",
    "dłużnika",
  ],
  hu: [
    "kártérítés",
    "kártérítést",
    "kártérítésre",
    "kártérítési",
    "kártérítésként",
    "kárért",
    "felelősség",
    "felelősségét",
    "szerződés",
    "szerződést",
    "szerződésben",
    "bíróság",
    "bírósági",
    "ítélet",
    "ítéletet",
    "kötelezettségét",
    "jogszabály",
    "rendelkezései",
    "késedelmi",
    "munkáltató",
  ],
  de: [
    "Schäden",
    "Schadensersatzanspruch",
    "Ansprüche",
    "Ansprüchen",
    "Gerichtshöfe",
    "Klägerin",
    "Verträge",
    "Verträgen",
    "Rechtmäßigkeit",
    "Kündigungen",
    "Gläubigers",
    "Bürgschaft",
    "Zuständigkeit",
    "Mängeln",
    "Rückzahlung",
    "gemäß",
  ],
  pt: [
    "indenização",
    "indenizações",
    "indemnização",
    "obrigação",
    "obrigações",
    "decisão",
    "decisões",
    "ação",
    "réu",
    "sentença",
    "acórdão",
    "acórdãos",
    "prescrição",
    "execução",
    "cláusulas",
    "prejuízo",
    "rescisão",
    "jurídica",
  ],
  fr: [
    "responsabilité",
    "préjudice",
    "préjudices",
    "indemnité",
    "indemnités",
    "résiliation",
    "créancier",
    "créanciers",
    "débiteur",
    "arrêt",
    "défendeur",
    "défenderesse",
    "procédure",
    "légalité",
    "sécurité",
    "intérêts",
    "délai",
    "exécution",
    "nullité",
    "sociétés",
  ],
  es: [
    "indemnización",
    "indemnizaciones",
    "daños",
    "resolución",
    "obligación",
    "prescripción",
    "ejecución",
    "cláusula",
    "jurídica",
    "interés",
    "acción",
    "órgano",
    "públicos",
  ],
  ro: [
    "despăgubire",
    "despăgubiri",
    "despăgubirii",
    "răspundere",
    "răspunderii",
    "instanța",
    "instanței",
    "hotărâre",
    "hotărârii",
    "pârâtul",
    "obligație",
    "obligațiile",
    "dobânzi",
    "executării",
    "nulității",
    "judecată",
    "judecății",
    "legală",
  ],
  it: [
    "responsabilità",
    "società",
    "attività",
    "legalità",
    "nullità",
    "proprietà",
    "validità",
  ],
  lt: [
    "žalos",
    "žalą",
    "sutartį",
    "atsakomybė",
    "atsakomybės",
    "ieškovas",
    "prievolė",
    "įstatymas",
  ],
  nl: [
    "geïntimeerde",
    "geïntimeerden",
    "financiële",
    "coöperatie",
    "beëindiging",
  ],
  sv: ["skadestånd", "skadeståndet", "ersättning", "käranden", "överklagande"],
  da: ["sagsøger", "sagsøgte", "højesteret", "økonomiske"],
  fi: ["päätös", "päätöksen", "työntekijän", "määräyksen", "käräjäoikeuden"],
  et: ["kahjuhüvitis", "kahjuhüvitise", "töötaja", "määruse", "õiguse"],
  ga: ["cúiteamh", "breithiúnas", "gearánaí", "cosantóir", "oibleagáidí"],
} as const satisfies Record<FoldedLanguage, readonly string[]>;

/**
 * Words whose diacritic decides whether an ending is one, so no reading of
 * the folded word reaches the accented stem: Romanian `judecății` keeps `ăți`
 * where a folded `ati` is an ending; Italian `nullità` keeps `ità` outside
 * the region that strips it; Lithuanian `sutartį` loses `į` where a folded
 * `i` is kept. Pinned so a change to that set is a decision, not a drift.
 */
const AMBIGUOUS: ReadonlyMap<FoldedLanguage, readonly string[]> = new Map([
  ["ro", ["judecății"]],
  ["it", ["nullità"]],
  ["lt", ["sutartį"]],
]);

const lowered = (word: string) => normalizeUnicode(word, "NFC").toLowerCase();

/**
 * Whether the query for `word` typed without its diacritics reaches the stem
 * the index holds for it: the folded word itself (the leaf every query sends
 * as typed) or one of its query stems.
 */
const reachedUnaccented = (word: string, language: MorphologyLanguage) => {
  const folded = foldLatinLetters(lowered(word));
  const held = foldLatinLetters(stemLegalTerm(word, language));
  return [folded, ...queryStems(folded, [language])]
    .map(foldLatinLetters)
    .includes(held);
};

describe("a word typed without its diacritics", () => {
  test("asks for the stem the index holds for the accented word", () => {
    expect(stemLegalTerm("nájemního", "cs")).toBe("nájemn");
    // The accented algorithm keeps `iho`, which its tables spell `ího`.
    expect(stemLegalTerm("najemniho", "cs")).toBe("najemnih");
    expect(queryStems("najemniho", ["cs"])).toEqual(["najemnih", "najemn"]);
    expect(queryStems("dedickeho", ["cs"])).toContain("dedick");
    expect(queryStems("bezduvodneho", ["cs"])).toContain("bezduvodn");
    expect(queryStems("najomneho", ["sk"])).toContain("najomn");
    expect(queryStems("indenizacao", ["pt"])).toContain("indeniz");
  });

  test.each(FOLDED_LANGUAGES)(
    "reaches every %s legal inflection the accented query reaches",
    (language) => {
      const words: readonly string[] = LEGAL_VOCABULARY[language];
      const ambiguous = AMBIGUOUS.get(language) ?? [];
      const missed = words.filter((word) => !reachedUnaccented(word, language));
      expect(missed).toEqual(words.filter((word) => ambiguous.includes(word)));
    },
  );

  test.each([...AMBIGUOUS])(
    "the %s words pinned as ambiguous are in the vocabulary checked",
    (language, words) => {
      const vocabulary: readonly string[] = LEGAL_VOCABULARY[language];
      expect(words.every((word) => vocabulary.includes(word))).toBe(true);
    },
  );

  /**
   * Over Snowball's own reference vocabulary, every word that carries a
   * diacritic: the share whose folded query reaches the accented stem. The
   * floors sit just under what was measured, so a regression shows and the
   * rest is the ambiguity `AMBIGUOUS` describes.
   */
  test.each([
    ["czech", "cs", 0.99],
    ["danish", "da", 0.98],
    ["dutch", "nl", 0.97],
    ["estonian", "et", 0.99],
    ["finnish", "fi", 0.99],
    ["french", "fr", 0.97],
    ["german", "de", 0.99],
    ["hungarian", "hu", 0.92],
    ["irish", "ga", 0.98],
    ["italian", "it", 0.93],
    ["lithuanian", "lt", 0.96],
    ["polish", "pl", 0.99],
    ["portuguese", "pt", 0.95],
    ["romanian", "ro", 0.96],
    ["spanish", "es", 0.98],
    ["swedish", "sv", 0.98],
  ] as const)(
    "%s reference words typed without diacritics reach their stem",
    (algorithm, language, floor) => {
      const accented = readConformanceVocabulary(algorithm)
        .map(({ word }) => lowered(word))
        .filter((word) => foldLatinLetters(word) !== word);
      expect(accented.length).toBeGreaterThan(30);
      const reached = accented.filter((word) =>
        reachedUnaccented(word, language),
      );
      expect(reached.length / accented.length).toBeGreaterThanOrEqual(floor);
    },
  );
});

describe("a word typed with its diacritics", () => {
  test.each(FOLDED_LANGUAGES)(
    "asks for exactly the %s stems it asked for before",
    (language) => {
      const words: readonly string[] = LEGAL_VOCABULARY[language];
      const accented = words.filter(
        (word) => foldLatinLetters(lowered(word)) !== lowered(word),
      );
      expect(accented.length).toBeGreaterThan(0);
      for (const word of accented) {
        expect(queryStems(word, [language])).toEqual([
          stemLegalTerm(word, language),
        ]);
      }
    },
  );

  test("under several languages, each language's stem in order", () => {
    expect(queryStems("nájemního", ["cs", "sk", "en"])).toEqual([
      ...new Set([
        stemLegalTerm("nájemního", "cs"),
        stemLegalTerm("nájemního", "sk"),
        stemLegalTerm("nájemního", "en"),
      ]),
    ]);
  });
});

const language = fc.constantFrom(...MORPHOLOGY_LANGUAGES);

/** Unaccented letters, plus the ones the folded stemmers fold away. */
const FOLDED_ALPHABET =
  "abcdefghijklmnopqrstuvwxyzáäčďéěíĺľňóôŕřšťúůýžąćęłńśźżëïãõşţßæø".split("");

const term = fc.oneof(
  fc.string({
    unit: fc.constantFrom(...FOLDED_ALPHABET),
    minLength: 1,
    maxLength: 30,
  }),
  fc.string({ minLength: 1, maxLength: 30 }),
);

test("query stems begin with the stems, stay bounded, and never repeat a leaf", () => {
  assertProperty(
    "query stems begin with the stems, stay bounded, and never repeat a leaf",
    fc.property(
      term,
      fc.uniqueArray(language, { minLength: 1, maxLength: 4 }),
      (input, languages) => {
        const folded = foldLatinLetters(lowered(input));
        for (const typed of [input, folded]) {
          const stems = queryStems(typed, languages);
          const own = [
            ...new Set(languages.map((code) => stemLegalTerm(typed, code))),
          ];
          expect(stems.slice(0, own.length)).toEqual(own);
          expect(stems.length).toBeLessThanOrEqual(3 * languages.length);
          expect(stems.every((stem) => stem.length > 0)).toBe(true);
          // A leaf the engine would read as one already asked is not asked.
          const ownKeys = new Set(own.map(foldLatinLetters));
          const extras = stems.slice(own.length).map(foldLatinLetters);
          expect(extras.filter((extra) => ownKeys.has(extra))).toEqual([]);
          expect(new Set(extras).size).toBe(extras.length);
        }
      },
    ),
  );
});
