import { expect, test } from "bun:test";

import { corpusTokens } from "@/api/lib/legal-search/corpus-tokens";
import {
  corpusMorphologyLanguage,
  documentMorphologyLanguage,
} from "@/api/lib/legal-search/morphology/corpus-language";
import { MORPHOLOGY_LANGUAGES } from "@/api/lib/legal-search/morphology/stem";
import { stemCorpusText } from "@/api/lib/legal-search/morphology/stem-text";

const SAMPLES = [
  "Nájemní smlouva byla uzavřena na dobu určitou.",
  "§ 2235 odst. 1 občanského zákoníku",
  "  Přezkoumání   rozhodnutí\tsprávního\norgánu  ",
  "Odstąpienie od umowy najmu lokalu mieszkalnego.",
  "Rozhodnutie odvolacieho súdu o náhrade škody.",
  "Der Mietvertrag wurde auf bestimmte Zeit geschlossen.",
  "L'arrêt de la Cour de justice concernant l'exécution.",
];

/**
 * A stem stream stands in for the surface stream position by position, so a
 * reader's phrase stemmed the same way matches adjacently. One stem per token,
 * in order, is the whole contract; a dropped or split token would shift every
 * position after it.
 */
test.each([...MORPHOLOGY_LANGUAGES])(
  "%s stems one token to one stem, in order",
  (language) => {
    for (const sample of SAMPLES) {
      const tokens = corpusTokens(sample);
      const stems = corpusTokens(stemCorpusText(sample, language));
      expect([sample, stems.length]).toEqual([sample, tokens.length]);
    }
  },
);

test("stemming strips an inflection the folded tokenizer keeps", () => {
  // The point of the field: three surface forms, one stem, so a query in any
  // of them reaches a judgment written in another.
  const stems = ["nájemní", "nájemního", "nájemnímu"].map((form) =>
    stemCorpusText(form, "cs"),
  );

  expect(new Set(stems).size).toBe(1);
  expect(stems.at(0)).not.toBe("nájemní");
});

test("text with no tokens stems to nothing", () => {
  expect(stemCorpusText("", "cs")).toBe("");
  expect(stemCorpusText("§ — ()", "cs")).toBe("");
});

test("a jurisdiction and a document resolve their own language", () => {
  expect(corpusMorphologyLanguage("CZE")).toBe("cs");
  expect(corpusMorphologyLanguage("svk")).toBe("sk");
  expect(corpusMorphologyLanguage("POL")).toBe("pl");
  // German, and 24 languages under one jurisdiction: neither has one language
  // to stem against.
  expect(corpusMorphologyLanguage("AUT")).toBeNull();
  expect(corpusMorphologyLanguage("EU")).toBeNull();
  expect(corpusMorphologyLanguage("XXX")).toBeNull();
  // An unscoped search spans every jurisdiction of a generation.
  expect(corpusMorphologyLanguage(undefined)).toBeNull();

  expect(documentMorphologyLanguage("cs")).toBe("cs");
  expect(documentMorphologyLanguage("SK")).toBe("sk");
  expect(documentMorphologyLanguage("de")).toBe("de");
  expect(documentMorphologyLanguage("fr")).toBe("fr");
  // Snowball has no Bulgarian algorithm, so its text goes unstemmed.
  expect(documentMorphologyLanguage("bg")).toBeNull();
  expect(documentMorphologyLanguage("")).toBeNull();
});

test("decomposed text stems exactly like its precomposed spelling", () => {
  // A combining mark is not a letter, so decomposed text would otherwise break
  // apart at every accent: "nájemního" in NFD tokenises to three fragments,
  // each stemming to itself and matching nothing. Extracted text arrives in
  // whatever form its producer used, and NFD is common from PDFs and macOS.
  const precomposed = "Nájemního bytu se to netýká.";
  const decomposed = precomposed.normalize("NFD");

  expect(decomposed).not.toBe(precomposed);
  expect(stemCorpusText(decomposed, "cs")).toBe(
    stemCorpusText(precomposed, "cs"),
  );
  expect(corpusTokens(stemCorpusText(decomposed, "cs")).length).toBe(
    corpusTokens(precomposed).length,
  );
});
