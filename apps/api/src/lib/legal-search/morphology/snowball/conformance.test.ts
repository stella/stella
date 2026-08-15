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

import { readConformanceVocabulary } from "@/api/lib/legal-search/morphology/snowball/__fixtures__/vocabulary";
import { CzechStemmer } from "@/api/lib/legal-search/morphology/snowball/czech.gen";
import { PolishStemmer } from "@/api/lib/legal-search/morphology/snowball/polish.gen";

const czech = new CzechStemmer();
const polish = new PolishStemmer();

const CASES = [
  {
    algorithm: "czech",
    stem: (term: string) => czech.stem(term),
    pairs: readConformanceVocabulary("czech"),
  },
  {
    algorithm: "polish",
    stem: (term: string) => polish.stem(term),
    pairs: readConformanceVocabulary("polish"),
  },
] as const;

describe("snowball conformance", () => {
  for (const { algorithm, stem, pairs } of CASES) {
    test(`${algorithm} reproduces the reference vocabulary`, () => {
      // A truncated or empty fixture must not let this pass vacuously.
      expect<number>(pairs.length).toBeGreaterThan(2000);

      const mismatches = pairs
        .filter(({ word, stem: expected }) => stem(word) !== expected)
        .slice(0, 10)
        .map(
          ({ word, stem: expected }) => `${word}: ${stem(word)} != ${expected}`,
        );

      expect<readonly string[]>(mismatches).toEqual([]);
    });

    test(`${algorithm} reuses one stemmer instance without carrying state`, () => {
      // The public surface holds a single instance per language; a stemmer
      // that leaked cursor state between calls would diverge here.
      const shared = pairs.map(({ word }) => stem(word));
      const fresh = pairs.map(({ word }) =>
        algorithm === "czech"
          ? new CzechStemmer().stem(word)
          : new PolishStemmer().stem(word),
      );

      expect<readonly string[]>(shared).toEqual(fresh);
    });
  }
});
