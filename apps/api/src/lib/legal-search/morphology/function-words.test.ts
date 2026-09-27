import { describe, expect, test } from "bun:test";

import { foldCorpusTerm } from "@/api/lib/legal-search/corpus-passage-highlight";
import {
  CORPUS_MORPHOLOGY_LANGUAGES,
  corpusMorphologyLanguage,
} from "@/api/lib/legal-search/morphology/corpus-language";
import {
  FUNCTION_WORD_LANGUAGES,
  FUNCTION_WORDS,
  functionWordKey,
  functionWordsFor,
  type FunctionWordLanguage,
} from "@/api/lib/legal-search/morphology/function-words";

/**
 * Words that must never be dropped from a query: the subject matter of the
 * disputes the corpus is made of. One per language, covering the tenancy and
 * contract vocabulary the reported query was about, plus the near-collision
 * ("byt", "mieszkanie", "Wohnung") that makes the folding rule matter.
 */
/**
 * Words whose removal can turn a query into one about the opposite
 * proposition: the negations, and the privatives that take the thing away
 * rather than deny it. They are grammar by every other measure, which is
 * exactly why the class needs a guard rather than an author's care.
 */
const POLARITY_WORDS = {
  cs: ["ne", "není", "nejsou", "ani", "aniž", "bez", "kromě", "nikoli"],
  de: ["nicht", "kein", "keine", "ohne", "außer", "niemals"],
  en: ["no", "not", "never", "neither", "nor", "without", "except"],
  hu: ["nem", "ne", "sem", "nélkül", "kivéve", "soha", "semmilyen"],
  pl: ["nie", "ani", "bez", "oprócz", "żaden"],
  sk: ["nie", "nie sú", "ani", "bez", "okrem", "nikdy"],
} as const satisfies Record<FunctionWordLanguage, readonly string[]>;

const CONTENT_WORDS = {
  cs: [
    "nájem",
    "nájemné",
    "nájemního",
    "dluh",
    "výpověď",
    "smlouva",
    "škoda",
    "byt",
    "soud",
    "žaloba",
    "náhrada",
  ],
  de: [
    "miete",
    "mietvertrag",
    "kündigung",
    "vertrag",
    "schaden",
    "wohnung",
    "schuld",
    "gericht",
    "klage",
  ],
  en: [
    "rent",
    "lease",
    "tenancy",
    "debt",
    "termination",
    "notice",
    "contract",
    "damages",
    "eviction",
    "court",
    "claim",
  ],
  hu: [
    "bérlet",
    "bérleti",
    "díj",
    "tartozás",
    "felmondás",
    "szerződés",
    "kár",
    "kártérítés",
    "lakás",
    "bíróság",
    "kereset",
  ],
  pl: [
    "najem",
    "czynsz",
    "dług",
    "wypowiedzenie",
    "umowa",
    "szkoda",
    "mieszkanie",
    "sąd",
    "pozew",
  ],
  sk: [
    "nájom",
    "nájomné",
    "dlh",
    "výpoveď",
    "zmluva",
    "škoda",
    "byt",
    "súd",
    "žaloba",
  ],
} as const satisfies Record<FunctionWordLanguage, readonly string[]>;

describe("function word lists", () => {
  test("every language the corpus serves has one", () => {
    // Derived from the jurisdiction map, so a new single-language corpus
    // fails here rather than serving questions as all-terms-required.
    for (const language of CORPUS_MORPHOLOGY_LANGUAGES) {
      expect(FUNCTION_WORD_LANGUAGES).toContain(language);
    }
    for (const language of FUNCTION_WORD_LANGUAGES) {
      expect(FUNCTION_WORDS[language].size).toBeGreaterThan(0);
    }
    // A language two sources contribute is listed once.
    expect(new Set(FUNCTION_WORD_LANGUAGES).size).toBe(
      FUNCTION_WORD_LANGUAGES.length,
    );
  });

  test("a jurisdiction written in English stems and drops words under it", () => {
    expect(corpusMorphologyLanguage("USA")).toBe("en");
    expect(CORPUS_MORPHOLOGY_LANGUAGES).toContain("en");
    expect(functionWordsFor("en")?.has("the")).toBe(true);
  });

  test("every entry is already its own comparison key", () => {
    // A list entry that is not NFC, or carries a capital, is an entry no
    // token can ever match: the lookup normalises the token, not the list.
    for (const language of FUNCTION_WORD_LANGUAGES) {
      for (const word of FUNCTION_WORDS[language]) {
        expect(functionWordKey(word)).toBe(word);
      }
    }
  });

  test("no entry is a word a decision is about", () => {
    for (const language of FUNCTION_WORD_LANGUAGES) {
      for (const content of CONTENT_WORDS[language]) {
        expect(FUNCTION_WORDS[language].has(functionWordKey(content))).toBe(
          false,
        );
      }
    }
  });

  test("no entry can invert what a query asks", () => {
    // Loosening a query is what this module is for; inverting one is not.
    // "smlouva je neplatná bez podpisu" read without "bez" is a claim about
    // contracts WITH a signature, which is the other side of the research
    // question, so no list may carry a negation or a privative.
    for (const language of FUNCTION_WORD_LANGUAGES) {
      for (const polarity of POLARITY_WORDS[language]) {
        expect(
          FUNCTION_WORDS[language].has(functionWordKey(polarity)),
          `${language} would drop "${polarity}", which changes what the query asks rather than how much it requires`,
        ).toBe(false);
      }
    }
  });

  test("the comparison key keeps the accents that separate the two", () => {
    // Why the key is not the index's folded form. Czech "být" and Slovak
    // "byť" (to be) fold onto "byt" (a flat), which is the subject of most
    // tenancy disputes in the corpus, so a folded list would drop the noun
    // from every query about one.
    expect(foldCorpusTerm("být")).toBe(foldCorpusTerm("byt"));
    expect(foldCorpusTerm("byť")).toBe(foldCorpusTerm("byt"));
    expect(functionWordKey("být")).not.toBe(functionWordKey("byt"));

    expect(FUNCTION_WORDS.cs.has(functionWordKey("být"))).toBe(true);
    expect(FUNCTION_WORDS.sk.has(functionWordKey("byť"))).toBe(true);
    expect(FUNCTION_WORDS.cs.has(functionWordKey("byt"))).toBe(false);
    expect(FUNCTION_WORDS.sk.has(functionWordKey("byt"))).toBe(false);
  });

  test("Czech and Slovak share the words they share", () => {
    // The opposite property to `LANGUAGE_STOPWORDS`, whose sets are
    // pairwise disjoint because it detects a document's language. This list
    // is for coverage, so a word both languages use is dropped in both.
    for (const shared of ["na", "do", "od", "po", "za", "a", "i"]) {
      expect(FUNCTION_WORDS.cs.has(shared)).toBe(true);
      expect(FUNCTION_WORDS.sk.has(shared)).toBe(true);
    }
  });

  test("the interrogatives the reported query sank on are covered", () => {
    for (const word of ["jak", "musí", "být", "pro", "na", "z", "velký"]) {
      const covered = FUNCTION_WORDS.cs.has(functionWordKey(word));
      // "velký" is an adjective the reader chose, not scaffolding: it stays
      // required, which is what keeps the relaxed query about the size of a
      // debt rather than about debts in general.
      expect(covered).toBe(word !== "velký");
    }
  });
});

describe("functionWordsFor", () => {
  test("drops nothing without a language", () => {
    expect(functionWordsFor(null)).toBeNull();
  });

  test("drops nothing in a language the corpus does not serve", () => {
    // Stemmable, but no corpus is written in it, so no list is authored and
    // its queries stay exactly as strict as they are today.
    expect(functionWordsFor("fi")).toBeNull();
  });

  test("answers with the language's own list", () => {
    expect(functionWordsFor("cs")).toBe(FUNCTION_WORDS.cs);
    expect(functionWordsFor("en")).toBe(FUNCTION_WORDS.en);
  });
});
