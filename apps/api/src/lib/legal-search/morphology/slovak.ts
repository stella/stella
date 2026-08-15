/**
 * Slovak light stemmer: a port of Wikimedia's `SlovakStemmer`.
 *
 * Upstream: https://gerrit.wikimedia.org/g/search/extra
 *   opensearch-extra-analysis-slovak/src/main/java/org/wikimedia/search/extra/
 *   analysis/slovak/SlovakStemmer.java
 *   (mirrored at https://github.com/wikimedia/search-extra)
 * Commit:   2ba556130dc6f8a505291c94d1d0f8b5ca078475
 *
 * Snowball has no Slovak algorithm, so Slovak uses this instead of a
 * generated stemmer. It is the same Dolamic and Savoy light-stemming family
 * as Snowball's Czech algorithm, which keeps the three languages'
 * aggressiveness comparable.
 *
 * The port is faithful: same suffix tables, same length guards, same
 * palatalisation rewrites, same order (case, then possessive, then prefix).
 * Java's `char[]` is UTF-16 code units, so the port indexes code units too,
 * which is why it splits with `split("")` rather than `Array.from`.
 *
 * ---------------------------------------------------------------------------
 * The WMF licenses this file to you under the Apache License, Version
 * 2.0 (the "License"); you may not use this file except in compliance
 * with the License. You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 * *** Source Information ***
 *
 * This code combines implementation details and linguistic information
 * from two main sources.
 *
 * ** Light Stemmer for Czech **
 *
 * The implementation is based on the lucene-solr "Light Stemmer for
 * Czech", which is licensed from ASF under the Apache License, Version
 * 2.0. Source code is available here:
 * https://github.com/apache/lucene-solr/blob/master/lucene/analysis/common/src/java/org/apache/lucene/analysis/cz/CzechStemmer.java
 *
 * ** stemm-sk **
 *
 * The Slovak-specific suffix information is adapted from stemm-sk, which
 * is Copyright (c) 2015 Marek Šuppa and licensed under the MIT
 * License (included below, as required). Source code is available here:
 * https://github.com/mrshu/stemm-sk/
 *
 * | Slovak-specific suffix information Copyright (c) 2015 Marek Šuppa
 * |
 * | Permission is hereby granted, free of charge, to any
 * | person obtaining a copy of this software and associated
 * | documentation files (the "Software"), to deal in the
 * | Software without restriction, including without limitation
 * | the rights to use, copy, modify, merge, publish,
 * | distribute, sublicense, and/or sell copies of the
 * | Software, and to permit persons to whom the Software is
 * | furnished to do so, subject to the following conditions:
 * |
 * | The above copyright notice and this permission notice
 * | shall be included in all copies or substantial portions of
 * | the Software.
 *
 * ** Additional Sources **
 *
 * The stemm-sk source code includes its own additional sources. The
 * Light Stemmer for Czech source code references the paper "Indexing
 * and stemming approaches for the Czech language" by Dolamic and Savoy
 * (2009), which is also the ultimate source of the main Czech
 * implementation that stemm-sk is based on. The paper is available
 * here: http://portal.acm.org/citation.cfm?id=1598600 .
 * ---------------------------------------------------------------------------
 */

import { panic } from "better-result";

/**
 * Which Slovak suffix table to run.
 *
 * - `faithful` reproduces upstream exactly.
 * - `extended` additionally strips a bare final `u`, the accusative and
 *   dative singular ending that dominates legal paradigms. Upstream strips
 *   `ú` but leaves bare `u`, so `súdu` and `zmluvu` never reach the stem of
 *   `súd` and `zmluva`. The variant is off by default until corpus
 *   evaluation confirms the recall gain outweighs the conflation risk; it is
 *   a deliberate divergence from upstream, not a bug fix. `slovak.test.ts`
 *   pins its full cost against upstream's own vectors.
 */
export type SlovakStemmerVariant = "faithful" | "extended";

/** Final vowels the case pass strips from a stem longer than three chars. */
const FINAL_VOWELS = {
  faithful: ["ú", "y", "a", "o", "á", "é", "ý"],
  extended: ["ú", "y", "a", "o", "á", "é", "ý", "u"],
} as const satisfies Record<SlovakStemmerVariant, readonly string[]>;

/** Final chars that trigger palatalisation instead of a plain truncation. */
const PALATALISING_FINALS = ["e", "i", "í"] as const;

const endsWith = (
  chars: readonly string[],
  length: number,
  suffix: string,
): boolean => {
  if (suffix.length > length) {
    return false;
  }
  for (let offset = 0; offset < suffix.length; offset++) {
    if (chars[length - suffix.length + offset] !== suffix[offset]) {
      return false;
    }
  }
  return true;
};

const startsWith = (
  chars: readonly string[],
  length: number,
  prefix: string,
): boolean => {
  if (prefix.length > length) {
    return false;
  }
  for (let offset = 0; offset < prefix.length; offset++) {
    if (chars[offset] !== prefix[offset]) {
      return false;
    }
  }
  return true;
};

/** Lucene's `StemmerUtil.deleteN`: shift `count` chars out at `position`. */
const deleteN = (
  chars: string[],
  position: number,
  length: number,
  count: number,
): number => {
  chars.copyWithin(position, position + count, length);
  return length - count;
};

const at = (chars: readonly string[], index: number): string =>
  chars[index] ?? panic(`Slovak stemmer read past the buffer at ${index}`);

const set = (chars: string[], index: number, value: string) => {
  if (index < 0 || index >= chars.length) {
    panic(`Slovak stemmer wrote past the buffer at ${index}`);
  }
  chars[index] = value;
};

const palatalize = (chars: string[], length: number): number => {
  if (
    endsWith(chars, length, "ci") ||
    endsWith(chars, length, "ce") ||
    endsWith(chars, length, "či") ||
    endsWith(chars, length, "če")
  ) {
    // [cč][ie] -> k
    set(chars, length - 2, "k");
  } else if (
    endsWith(chars, length, "zi") ||
    endsWith(chars, length, "ze") ||
    endsWith(chars, length, "ži") ||
    endsWith(chars, length, "že")
  ) {
    // [zž][ie] -> h
    set(chars, length - 2, "h");
  } else if (
    endsWith(chars, length, "čte") ||
    endsWith(chars, length, "čti") ||
    endsWith(chars, length, "čtí")
  ) {
    // čt[eií] -> ck
    set(chars, length - 3, "c");
    set(chars, length - 2, "k");
  } else if (
    endsWith(chars, length, "šte") ||
    endsWith(chars, length, "šti") ||
    endsWith(chars, length, "ští")
  ) {
    // št[eií] -> sk
    set(chars, length - 3, "s");
    set(chars, length - 2, "k");
  }

  return length - 1;
};

const removeCase = (
  chars: string[],
  length: number,
  variant: SlovakStemmerVariant,
): number => {
  if (length > 7 && endsWith(chars, length, "atoch")) {
    return length - 5;
  }

  if (length > 6 && endsWith(chars, length, "aťom")) {
    return palatalize(chars, length - 3);
  }

  if (length > 5) {
    if (
      endsWith(chars, length, "och") ||
      endsWith(chars, length, "ich") ||
      endsWith(chars, length, "ích") ||
      endsWith(chars, length, "ého") ||
      endsWith(chars, length, "ami") ||
      endsWith(chars, length, "emi") ||
      endsWith(chars, length, "ému") ||
      endsWith(chars, length, "ete") ||
      endsWith(chars, length, "eti") ||
      endsWith(chars, length, "iho") ||
      endsWith(chars, length, "ího") ||
      endsWith(chars, length, "ími") ||
      endsWith(chars, length, "imu") ||
      endsWith(chars, length, "aťa")
    ) {
      return palatalize(chars, length - 2);
    }
    if (
      endsWith(chars, length, "ách") ||
      endsWith(chars, length, "ata") ||
      endsWith(chars, length, "aty") ||
      endsWith(chars, length, "ých") ||
      endsWith(chars, length, "ové") ||
      endsWith(chars, length, "ovi") ||
      endsWith(chars, length, "ými")
    ) {
      return length - 3;
    }
  }

  if (length > 4) {
    if (endsWith(chars, length, "om")) {
      return palatalize(chars, length - 1);
    }
    if (
      endsWith(chars, length, "es") ||
      endsWith(chars, length, "ém") ||
      endsWith(chars, length, "ím")
    ) {
      return palatalize(chars, length - 2);
    }
    if (
      endsWith(chars, length, "úm") ||
      endsWith(chars, length, "at") ||
      endsWith(chars, length, "ám") ||
      endsWith(chars, length, "os") ||
      endsWith(chars, length, "us") ||
      endsWith(chars, length, "ým") ||
      endsWith(chars, length, "mi") ||
      endsWith(chars, length, "ou") ||
      endsWith(chars, length, "ej")
    ) {
      return length - 2;
    }
  }

  if (length > 3) {
    const final = at(chars, length - 1);
    if (PALATALISING_FINALS.some((candidate) => candidate === final)) {
      return palatalize(chars, length);
    }
    const strippable: readonly string[] = FINAL_VOWELS[variant];
    if (strippable.includes(final)) {
      return length - 1;
    }
  }

  return length;
};

const removePossessives = (chars: string[], length: number): number => {
  if (length > 5) {
    if (endsWith(chars, length, "ov")) {
      return length - 2;
    }
    if (endsWith(chars, length, "in")) {
      return palatalize(chars, length - 1);
    }
  }

  return length;
};

const removePrefixes = (chars: string[], length: number): number => {
  if (length > 5 && startsWith(chars, length, "naj")) {
    return deleteN(chars, 0, length, 3);
  }
  return length;
};

const stemSlovakVariant = (
  term: string,
  variant: SlovakStemmerVariant,
): string => {
  // Java's char[] is UTF-16 code units; split("") matches that, whereas
  // Array.from would split by code point and change surrogate handling.
  const chars = term.split("");
  let length = chars.length;
  length = removeCase(chars, length, variant);
  length = removePossessives(chars, length);
  length = removePrefixes(chars, length);
  return chars.slice(0, length).join("");
};

/**
 * Stem a lowercase Slovak term, reproducing upstream exactly.
 *
 * Input is expected to be lowercase and to keep its diacritics: the suffix
 * tables are written over `á ä č ď é í ĺ ľ ň ó ô ŕ š ť ú ý ž`, so folding
 * before stemming loses matches.
 */
export const stemSlovak = (term: string): string =>
  stemSlovakVariant(term, "faithful");

/**
 * Stem a lowercase Slovak term, additionally stripping a bare final `u`.
 *
 * Not wired into {@link stemLegalTerm}; see {@link SlovakStemmerVariant} for
 * why it ships off by default.
 */
export const stemSlovakExtended = (term: string): string =>
  stemSlovakVariant(term, "extended");
