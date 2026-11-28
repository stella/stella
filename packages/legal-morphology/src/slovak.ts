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

import { foldLatinLetters } from "./latin-fold";

/**
 * Which Slovak suffix table to run.
 *
 * - `faithful` reproduces upstream exactly, and is kept as the reference the
 *   divergence below is measured against.
 * - `extended` is what the corpus stems with. Upstream leaves four gaps in
 *   the paradigms legal text is made of, each of which splits one noun over
 *   several stems, so a query in one case misses a decision written in
 *   another:
 *   - a bare final `u`, the genitive, dative and accusative singular ending
 *     (`škodu`, `pomeru`, `súdu`). Upstream strips `ú` but not `u`, where
 *     Czech Snowball strips both.
 *   - the genitive plural `-ov` of a one-syllable stem (`súdov`): upstream's
 *     possessive pass needs six characters, so only longer words lose it.
 *   - the `i` of the soft neuter and feminine paradigms (`rozhodnutie`,
 *     `rozhodnutiam`, `rozhodnutiach` against `rozhodnutí`, `rozhodnutím`):
 *     upstream has no `-iam`/`-iach` ending, and keeps the `i` wherever the
 *     ending after it is stripped but drops it where it is the ending.
 *     Dropping a stem-final `i` after the case pass gives the whole paradigm
 *     the stem Czech Snowball gives `rozhodnutí`.
 *   - the hard masculine nouns ending in `-es` or `-ém` (`proces`,
 *     `problém`): upstream strips both from the nominative as if they were
 *     endings, but not from `procesu` or `problémom`. The `-es` nouns keep
 *     it; the `-ém` nouns drop it from every form (see
 *     {@link removeHardStemEm}). Likewise `-imu`, read as an ending where it
 *     is the `-u` of `režimu`.
 *   `slovak.test.ts` pins the full cost against upstream's own vectors.
 */
type SlovakStemmerVariant = "faithful" | "extended";

/** Final vowels the case pass strips from a stem longer than three chars. */
const FINAL_VOWELS = {
  faithful: ["ú", "y", "a", "o", "á", "é", "ý"],
  extended: ["ú", "y", "a", "o", "á", "é", "ý", "u"],
} as const satisfies Record<SlovakStemmerVariant, readonly string[]>;

/** Final chars that trigger palatalisation instead of a plain truncation. */
const PALATALISING_FINALS = ["e", "i", "í"] as const;

/**
 * How the term and the tables are spelled. `accented` is the algorithm as
 * written. `folded` runs it over a term typed without diacritics, with every
 * letter it compares against folded the same way, so `rozhodnutiho` loses
 * `iho` exactly as `rozhodnutího` loses `ího` (see `stem.ts`'s query stems).
 */
type SlovakSpelling = "accented" | "folded";

/** The term's UTF-16 code units, and how the tables are read against them. */
type Letters = {
  readonly units: string[];
  readonly spelling: SlovakSpelling;
  readonly reading: SlovakFoldedReading;
};

/**
 * How a folded term's unaccented letters are read, as for the Snowball
 * stemmers' `FoldedCollision`: `plain` takes them as written, `accented` lets
 * any of them have lost a diacritic. The one rule that tells them apart is the
 * superlative prefix: `naj` is stripped only when it is unaccented, and a
 * folded `naj` may be `náj` (`najomneho` is `nájomného`, whose stem keeps it).
 */
export type SlovakFoldedReading = "plain" | "accented";

const spelled = (
  chars: Letters,
  letter: string | undefined,
): string | undefined =>
  letter === undefined || chars.spelling === "accented"
    ? letter
    : foldLatinLetters(letter);

const endsWith = (chars: Letters, length: number, suffix: string): boolean => {
  if (suffix.length > length) {
    return false;
  }
  for (let offset = 0; offset < suffix.length; offset++) {
    if (
      chars.units[length - suffix.length + offset] !==
      spelled(chars, suffix[offset])
    ) {
      return false;
    }
  }
  return true;
};

const startsWith = (
  chars: Letters,
  length: number,
  prefix: string,
): boolean => {
  if (prefix.length > length) {
    return false;
  }
  for (let offset = 0; offset < prefix.length; offset++) {
    if (chars.units[offset] !== spelled(chars, prefix[offset])) {
      return false;
    }
  }
  return true;
};

/** Lucene's `StemmerUtil.deleteN`: shift `count` chars out at `position`. */
const deleteN = (
  chars: Letters,
  position: number,
  length: number,
  count: number,
): number => {
  chars.units.copyWithin(position, position + count, length);
  return length - count;
};

const at = (chars: Letters, index: number): string =>
  chars.units[index] ??
  panic(`Slovak stemmer read past the buffer at ${index}`);

/** Whether the char at `index` is one of `letters`, as the tables spell them. */
const isOneOf = (
  chars: Letters,
  index: number,
  letters: readonly string[],
): boolean => {
  const letter = at(chars, index);
  return letters.some((candidate) => spelled(chars, candidate) === letter);
};

const set = (chars: Letters, index: number, value: string) => {
  if (index < 0 || index >= chars.units.length) {
    panic(`Slovak stemmer wrote past the buffer at ${index}`);
  }
  chars.units[index] = value;
};

const palatalize = (chars: Letters, length: number): number => {
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

/**
 * The endings `extended` reads before upstream's tables, or null when none
 * applies. `-iach` and `-iam` keep their `i` for the soft-stem pass.
 */
const removeExtendedCase = (chars: Letters, length: number): number | null => {
  if (length > 6 && endsWith(chars, length, "iach")) {
    return length - 3;
  }
  if (length > 5 && endsWith(chars, length, "iam")) {
    return length - 2;
  }
  // Upstream hands `palatalize` the stem without the `í`, and it strips one
  // more character: `rozhodnutím` -> `rozhodnu`, a letter short of
  // `rozhodnutí`. Passing the `í`, as `-om` passes its `o`, strips the
  // ending alone.
  if (length > 4 && endsWith(chars, length, "ím")) {
    return palatalize(chars, length - 1);
  }
  // `-es` and `-ém` are no Slovak case ending (the table inherits them from
  // the Czech stemmer). A Slovak word ending in them is the bare nominative
  // of a hard masculine noun (`proces`, `problém`), whose other cases append
  // to it (`procesu`, `problémom`), so stripping them splits the paradigm.
  // The `-ém` nouns lose the `ém` in the hard-stem pass instead.
  if (endsWith(chars, length, "es") || endsWith(chars, length, "ém")) {
    return length;
  }
  // `-imu` is no Slovak ending either (the soft adjective dative is
  // `-iemu`): it is the `-u` of a noun ending in `-im` (`režimu`), which
  // upstream strips to `reh`.
  if (length > 5 && endsWith(chars, length, "imu")) {
    return length - 1;
  }
  return null;
};

const removeCase = (
  chars: Letters,
  length: number,
  variant: SlovakStemmerVariant,
): number => {
  if (length > 7 && endsWith(chars, length, "atoch")) {
    return length - 5;
  }

  if (length > 6 && endsWith(chars, length, "aťom")) {
    return palatalize(chars, length - 3);
  }

  const extended =
    variant === "extended" ? removeExtendedCase(chars, length) : null;
  if (extended !== null) {
    return extended;
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
    if (isOneOf(chars, length - 1, PALATALISING_FINALS)) {
      return palatalize(chars, length);
    }
    if (isOneOf(chars, length - 1, FINAL_VOWELS[variant])) {
      return length - 1;
    }
  }

  return length;
};

/**
 * The soft-stem pass: a stem the case pass left ending in `i` loses it, so
 * `rozhodnutia` (`rozhodnuti`) meets `rozhodnutí` (`rozhodnut`). Five
 * characters or more, so no stem ends shorter than four.
 */
const removeSoftStemVowel = (chars: Letters, length: number): number =>
  length > 4 && at(chars, length - 1) === "i" ? length - 1 : length;

/**
 * The hard-stem pass: a stem the case pass left ending in `ém` loses it.
 * `problému` cannot be told from an adjective's dative (`novému`) by its
 * ending, so the case pass strips `ému` from both, leaving `probl`; dropping
 * `ém` from every other form of the noun (`problém`, `problémy`,
 * `problémom`) meets it there. Five characters or more, as in the soft-stem
 * pass, so `krém` keeps its stem whole in every case.
 */
const removeHardStemEm = (chars: Letters, length: number): number =>
  length > 4 && endsWith(chars, length, "ém") ? length - 2 : length;

/**
 * Upstream's possessive pass needs six characters; `súdov` has five.
 *
 * The shorter floor costs precision: a five-character noun whose `-ov` is
 * its stem, not its ending, now stems with a shorter word (`domov` and `dom`
 * share `dom`). Recall of every one-syllable genitive plural is worth more to
 * legal search than keeping those few nouns apart.
 */
const MIN_POSSESSIVE_OV_LENGTH = {
  faithful: 6,
  extended: 5,
} as const satisfies Record<SlovakStemmerVariant, number>;

const removePossessives = (
  chars: Letters,
  length: number,
  variant: SlovakStemmerVariant,
): number => {
  if (
    length >= MIN_POSSESSIVE_OV_LENGTH[variant] &&
    endsWith(chars, length, "ov")
  ) {
    return length - 2;
  }
  if (length > 5 && endsWith(chars, length, "in")) {
    return palatalize(chars, length - 1);
  }

  return length;
};

const removePrefixes = (chars: Letters, length: number): number => {
  if (chars.reading === "accented") {
    return length;
  }
  if (length > 5 && startsWith(chars, length, "naj")) {
    return deleteN(chars, 0, length, 3);
  }
  return length;
};

const stemSlovakVariant = (
  term: string,
  variant: SlovakStemmerVariant,
  spelling: SlovakSpelling = "accented",
  reading: SlovakFoldedReading = "plain",
): string => {
  // Java's char[] is UTF-16 code units; split("") matches that, whereas
  // Array.from would split by code point and change surrogate handling.
  const chars: Letters = {
    units: (spelling === "folded" ? foldLatinLetters(term) : term).split(""),
    spelling,
    reading,
  };
  let length = chars.units.length;
  length = removeCase(chars, length, variant);
  if (variant === "extended") {
    length = removeSoftStemVowel(chars, length);
  }
  length = removePossessives(chars, length, variant);
  if (variant === "extended") {
    // After the possessive pass, which is what strips `problémov`'s `-ov`.
    length = removeHardStemEm(chars, length);
  }
  length = removePrefixes(chars, length);
  return chars.units.slice(0, length).join("");
};

/**
 * Stem a Slovak term: upstream plus the paradigm gaps listed at
 * {@link SlovakStemmerVariant}.
 *
 * Preconditions, both of which {@link stemLegalTerm} applies for you:
 * the term must be NFC and lowercase. The suffix tables are written with
 * precomposed, lowercase, accented code points (`á ä č ď é í ĺ ľ ň ó ô ŕ š
 * ť ú ý ž`), so a decomposed term matches nothing and passes through
 * unstemmed, and a folded term loses the endings this exists to strip.
 */
export const stemSlovak = (term: string): string =>
  stemSlovakVariant(term, "extended");

/**
 * Stem a Slovak term exactly as upstream does, the reference `slovak.test.ts`
 * measures {@link stemSlovak}'s divergence against. Same preconditions.
 */
export const stemSlovakUpstream = (term: string): string =>
  stemSlovakVariant(term, "faithful");

/**
 * Stem a Slovak term typed without its diacritics: {@link stemSlovak} with
 * the term and every suffix it compares against folded, so the stem is the
 * folded form of the one the accented word gets. Query side only; the corpus
 * is stemmed accented. Same preconditions.
 */
export const stemSlovakFolded = (
  term: string,
  reading: SlovakFoldedReading,
): string => stemSlovakVariant(term, "extended", "folded", reading);
