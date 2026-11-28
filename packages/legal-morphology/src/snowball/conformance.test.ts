/**
 * Binds the committed generated stemmers to the pinned Snowball algorithm.
 *
 * The fixtures are a deterministic sample of Snowball's own reference
 * vocabulary (`voc.txt` -> `output.txt`), so this reproduces upstream's
 * acceptance test without needing the C compiler in CI. If a regenerated
 * stemmer ever drifts from v3.1.1, or a hand edit slips into a `.gen.ts`,
 * these pairs stop matching.
 */

import { describe, expect, test } from "bun:test";

import type { MorphologyLanguage } from "../stem";
import {
  conformanceAlgorithms,
  readConformanceVocabulary,
} from "./__fixtures__/vocabulary";
import { CzechStemmer } from "./czech.gen";
import { DanishStemmer } from "./danish.gen";
import { DutchStemmer } from "./dutch.gen";
import { EnglishStemmer } from "./english.gen";
import { EstonianStemmer } from "./estonian.gen";
import { FinnishStemmer } from "./finnish.gen";
import { FrenchStemmer } from "./french.gen";
import { GermanStemmer } from "./german.gen";
import { GreekStemmer } from "./greek.gen";
import { HungarianStemmer } from "./hungarian.gen";
import { IrishStemmer } from "./irish.gen";
import { ItalianStemmer } from "./italian.gen";
import { LithuanianStemmer } from "./lithuanian.gen";
import { PolishStemmer } from "./polish.gen";
import { PortugueseStemmer } from "./portuguese.gen";
import { RomanianStemmer } from "./romanian.gen";
import { SpanishStemmer } from "./spanish.gen";
import { SwedishStemmer } from "./swedish.gen";

/**
 * Slovak is the one stemmable language with no Snowball algorithm and so no
 * reference vocabulary; `../slovak.test.ts` covers it instead.
 */
type SnowballLanguage = Exclude<MorphologyLanguage, "sk">;

/**
 * A fresh stemmer per algorithm, keyed by the language that dispatches to it.
 * Total over the Snowball-backed languages, so a language added to the
 * stemmer has to be exercised here rather than shipping unchecked.
 */
const STEMMERS = {
  cs: { algorithm: "czech", create: () => new CzechStemmer() },
  da: { algorithm: "danish", create: () => new DanishStemmer() },
  de: { algorithm: "german", create: () => new GermanStemmer() },
  el: { algorithm: "greek", create: () => new GreekStemmer() },
  en: { algorithm: "english", create: () => new EnglishStemmer() },
  es: { algorithm: "spanish", create: () => new SpanishStemmer() },
  et: { algorithm: "estonian", create: () => new EstonianStemmer() },
  fi: { algorithm: "finnish", create: () => new FinnishStemmer() },
  fr: { algorithm: "french", create: () => new FrenchStemmer() },
  ga: { algorithm: "irish", create: () => new IrishStemmer() },
  hu: { algorithm: "hungarian", create: () => new HungarianStemmer() },
  it: { algorithm: "italian", create: () => new ItalianStemmer() },
  lt: { algorithm: "lithuanian", create: () => new LithuanianStemmer() },
  nl: { algorithm: "dutch", create: () => new DutchStemmer() },
  pl: { algorithm: "polish", create: () => new PolishStemmer() },
  pt: { algorithm: "portuguese", create: () => new PortugueseStemmer() },
  ro: { algorithm: "romanian", create: () => new RomanianStemmer() },
  sv: { algorithm: "swedish", create: () => new SwedishStemmer() },
} as const satisfies Record<
  SnowballLanguage,
  { algorithm: string; create: () => { stem: (term: string) => string } }
>;

describe("snowball conformance", () => {
  test("every committed fixture is exercised", () => {
    // Read from disk, so a fixture the generator wrote and this suite never
    // names fails here instead of going unchecked.
    expect<readonly string[]>(conformanceAlgorithms()).toEqual(
      Object.values(STEMMERS)
        .map(({ algorithm }) => algorithm)
        .toSorted(),
    );
  });

  for (const { algorithm, create } of Object.values(STEMMERS)) {
    const pairs = readConformanceVocabulary(algorithm);
    const shared = create();

    test(`${algorithm} reproduces the reference vocabulary`, () => {
      // A thin fixture must not let this pass near-vacuously; the reader
      // already rejects one truncated below its declared count.
      expect<number>(pairs.length).toBeGreaterThan(1000);

      const mismatches = pairs
        .filter(({ word, stem }) => shared.stem(word) !== stem)
        .slice(0, 10)
        .map(({ word, stem }) => `${word}: ${shared.stem(word)} != ${stem}`);

      expect<readonly string[]>(mismatches).toEqual([]);
    });

    test(`${algorithm} reuses one stemmer instance without carrying state`, () => {
      // The public surface holds a single instance per language; a stemmer
      // that leaked cursor state between calls would diverge here.
      expect<readonly string[]>(
        pairs.map(({ word }) => shared.stem(word)),
      ).toEqual(pairs.map(({ word }) => create().stem(word)));
    });
  }
});
