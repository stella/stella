/**
 * A Snowball algorithm run over ASCII-folded text: the same generated code,
 * with every string and character class it reads or writes seen through the
 * fold the index applies.
 *
 * Why it exists: documents are stemmed accented and folded afterwards, so the
 * index holds `fold(stem(word))`. A reader who types the word without its
 * diacritics hands the stemmer `fold(word)`, whose endings the accented
 * suffix tables do not list (`najemniho` keeps `iho`, because the table
 * strips `ího`), and the stem the query asks for is not the one the index
 * holds. This stemmer answers `fold(word)` with what the algorithm would have
 * done had its tables been written folded: `najemniho` loses `iho` exactly as
 * `nájemního` loses `ího`.
 *
 * Why at run time rather than as a second generated module: the tables are
 * the generated module's own, read as the algorithm reaches them, so a
 * regenerated stemmer is folded without anyone remembering to fold it, and no
 * second copy of an algorithm can drift from the first. The algorithm's code
 * is untouched; only what its runtime primitives compare against is folded:
 *
 * - `among` tables: each row's string folded, rows that fold together merged
 *   (see {@link FoldedCollision}), re-sorted and re-linked the way the Snowball
 *   compiler lays a table out, because the runtime binary-searches it;
 * - `eq_s`, `slice_from`, `insert`: the literal folded;
 * - the letters a prelude rewrites into its own spelling (see
 *   {@link FoldedPrelude}): never matched, as folded text holds none.
 * - groupings: a class holds a folded letter when it holds any letter that
 *   folds to it, so `a` is a vowel wherever `á` is.
 *
 * The fold is the index's, over Latin letters only (`../latin-fold`).
 */

import { panic } from "better-result";

import {
  foldLatinLetter,
  foldLatinLetters,
} from "@/api/lib/legal-search/morphology/latin-fold";
import type {
  AmongFunction,
  AmongRow,
  AmongTable,
  BaseStemmer,
} from "@/api/lib/legal-search/morphology/snowball/base-stemmer";

/**
 * Which row survives when two rows of one table fold to the same string and
 * disagree about what to do (`ete` and `ěte` in Czech, `ak` and `ák` in
 * Hungarian). A folded word cannot say which it was, so both readings are
 * kept, each by its own stemmer instance:
 *
 * - `plain`: the row that was already unaccented, which is what the word
 *   means if the reader typed it as the language writes it;
 * - `accented`: a row that carried a diacritic, which is what the word means
 *   if the reader left it out.
 *
 * Rows that agree merge whichever is chosen.
 */
export type FoldedCollision = "plain" | "accented";

type SnowballStemmer = BaseStemmer & { stem: (input: string) => string };

export type SnowballStemmerClass = new () => SnowballStemmer;

/**
 * The diacritics an algorithm rewrites before it stems, and how it spells
 * them afterwards: French rewrites `ë` as `He`, Portuguese `ã` as `a~`,
 * Romanian the cedilla `ş` as the comma `ș`.
 *
 * Folded text holds none of those letters, so a rule that looks for one never
 * matches. It has to be told so: folded, `ë` reads as `e`, the rewrite would
 * write `e` over `e`, and an algorithm that rescans after a rewrite (expecting
 * the text to have changed) would rescan forever. The markers fold away with
 * the diacritic they stand for (`He` reads as `e`); a literal of markers alone
 * never matches.
 */
export type FoldedPrelude = {
  /** Letters the prelude rewrites, which no folded rule matches. */
  rewrites: string;
  /** Characters the algorithm writes in place of a diacritic. */
  markers: string;
};

type FoldedStemmerOptions = {
  collision: FoldedCollision;
  prelude?: FoldedPrelude | undefined;
};

const NO_PRELUDE: FoldedPrelude = { rewrites: "", markers: "" };

/**
 * A literal the algorithm matches against the text, folded: null when no
 * folded text can match it (it holds a letter the prelude rewrites, or is
 * made of markers alone).
 */
const foldMatched = (
  literal: string,
  { rewrites, markers }: FoldedPrelude,
): string | null => {
  if (literal === "") {
    return literal;
  }
  let folded = "";
  for (const letter of literal) {
    if (rewrites.includes(letter)) {
      return null;
    }
    if (!markers.includes(letter)) {
      folded += foldLatinLetter(letter);
    }
  }
  return folded === "" ? null : folded;
};

/** A literal the algorithm writes into the text, folded. */
const foldWritten = (literal: string, { markers }: FoldedPrelude): string => {
  let folded = "";
  for (const letter of literal) {
    if (!markers.includes(letter)) {
      folded += foldLatinLetter(letter);
    }
  }
  return folded;
};

type Direction = "forward" | "backward";

const sortKey = (value: string, direction: Direction): string =>
  direction === "forward" ? value : value.split("").toReversed().join("");

const extendsRow = (longer: string, shorter: string, direction: Direction) =>
  shorter.length < longer.length &&
  (direction === "forward"
    ? longer.startsWith(shorter)
    : longer.endsWith(shorter));

type FoldedRow = { folded: string; original: string; row: AmongRow };

const preferred = (
  candidate: FoldedRow,
  held: FoldedRow,
  collision: FoldedCollision,
): boolean => {
  const candidatePlain = candidate.original === candidate.folded;
  const heldPlain = held.original === held.folded;
  return collision === "plain"
    ? candidatePlain && !heldPlain
    : !candidatePlain && heldPlain;
};

/**
 * An among table with its strings folded, laid out as the Snowball compiler
 * lays one out: sorted by code unit (from the end for a backward table), and
 * each row linked to the longest other row it extends, which is where the
 * runtime falls back when a longer match's condition fails.
 */
const foldAmongTable = (
  table: AmongTable,
  direction: Direction,
  {
    collision,
    prelude,
  }: { collision: FoldedCollision; prelude: FoldedPrelude },
): AmongTable => {
  const chosen = new Map<string, FoldedRow>();
  for (const row of table) {
    const folded = foldMatched(row[0], prelude);
    if (folded === null) {
      continue;
    }
    const candidate = { folded, original: row[0], row };
    const held = chosen.get(folded);
    if (held === undefined || preferred(candidate, held, collision)) {
      chosen.set(folded, candidate);
    }
  }
  const sorted = [...chosen.values()].toSorted((left, right) => {
    // By code unit, as the runtime compares, never by locale.
    const a = sortKey(left.folded, direction);
    const b = sortKey(right.folded, direction);
    if (a === b) {
      return 0;
    }
    return a < b ? -1 : 1;
  });
  return sorted.map(({ folded, row }, index): AmongRow => {
    let target = -1;
    for (let other = index - 1; other >= 0; other--) {
      const shorter = sorted[other]?.folded ?? panic("Folded row out of range");
      if (
        extendsRow(folded, shorter, direction) &&
        (target === -1 || shorter.length > (sorted[target]?.folded.length ?? 0))
      ) {
        target = other;
      }
    }
    const back = target === -1 ? 0 : index - target;
    const [, result, , amongFunction] = row;
    if (amongFunction !== undefined) {
      return [folded, result, back, amongFunction];
    }
    return back === 0 ? [folded, result] : [folded, result, back];
  });
};

type Grouping = { bits: readonly number[]; min: number; max: number };

/**
 * Whether a Snowball grouping holds `code`: bit `code - min` of the bitset,
 * least significant bit first within each byte, as the runtime reads it.
 */
const holds = (bits: readonly number[], min: number, code: number) => {
  const offset = code - min;
  const byte = bits[Math.floor(offset / 8)] ?? 0;
  return Math.floor(byte / 2 ** (offset % 8)) % 2 === 1;
};

/**
 * A character class closed under folding: it holds every letter it held, and
 * the folded form of each that folds to one ASCII letter.
 */
const foldGrouping = (
  bits: readonly number[],
  min: number,
  max: number,
): Grouping => {
  const members = new Set<number>();
  for (let code = min; code <= max; code++) {
    if (holds(bits, min, code)) {
      members.add(code);
      const folded = foldLatinLetter(String.fromCodePoint(code));
      const foldedCode = folded.codePointAt(0);
      if (folded.length === 1 && foldedCode !== undefined) {
        members.add(foldedCode);
      }
    }
  }
  const codes = [...members];
  const low = Math.min(min, ...codes);
  const high = Math.max(max, ...codes);
  const folded = Array.from(
    { length: Math.floor((high - low) / 8) + 1 },
    () => 0,
  );
  for (const code of codes) {
    const offset = code - low;
    const index = Math.floor(offset / 8);
    folded[index] = (folded[index] ?? 0) + 2 ** (offset % 8);
  }
  return { bits: folded, min: low, max: high };
};

/**
 * A stemmer for folded text, built from a generated Snowball class. The term
 * must be NFC and lowercase, as for the class itself; its Latin letters are
 * folded here.
 */
export const foldedSnowballStemmer = (
  Stemmer: SnowballStemmerClass,
  { collision, prelude = NO_PRELUDE }: FoldedStemmerOptions,
): { stem: (term: string) => string } => {
  const options = { collision, prelude };
  const tables = {
    forward: new WeakMap<AmongTable, AmongTable>(),
    backward: new WeakMap<AmongTable, AmongTable>(),
  };
  const groupings = new WeakMap<readonly number[], Map<string, Grouping>>();
  const matched = (value: string) => foldMatched(value, prelude);
  const written = (value: string) => foldWritten(value, prelude);
  const table = (value: AmongTable, direction: Direction): AmongTable => {
    const known = tables[direction].get(value);
    if (known !== undefined) {
      return known;
    }
    const folded = foldAmongTable(value, direction, options);
    tables[direction].set(value, folded);
    return folded;
  };
  const grouping = (
    bits: readonly number[],
    min: number,
    max: number,
  ): Grouping => {
    const byRange = groupings.get(bits) ?? new Map<string, Grouping>();
    groupings.set(bits, byRange);
    const key = `${String(min)}:${String(max)}`;
    const known = byRange.get(key);
    if (known !== undefined) {
      return known;
    }
    const folded = foldGrouping(bits, min, max);
    byRange.set(key, folded);
    return folded;
  };

  class FoldedStemmer extends Stemmer {
    protected override eq_s(s: string): boolean {
      const folded = matched(s);
      return folded !== null && super.eq_s(folded);
    }

    protected override eq_s_b(s: string): boolean {
      const folded = matched(s);
      return folded !== null && super.eq_s_b(folded);
    }

    protected override slice_from(s: string): void {
      super.slice_from(written(s));
    }

    protected override insert(c_bra: number, c_ket: number, s: string): void {
      super.insert(c_bra, c_ket, written(s));
    }

    protected override find_among(
      v: AmongTable,
      call_among_func?: AmongFunction,
    ): number {
      const folded = table(v, "forward");
      // Every row held a letter folded text lacks: nothing can match.
      return folded.length === 0
        ? 0
        : super.find_among(folded, call_among_func);
    }

    protected override find_among_b(
      v: AmongTable,
      call_among_func?: AmongFunction,
    ): number {
      const folded = table(v, "backward");
      return folded.length === 0
        ? 0
        : super.find_among_b(folded, call_among_func);
    }

    protected override in_grouping(
      s: readonly number[],
      min: number,
      max: number,
    ): boolean {
      const g = grouping(s, min, max);
      return super.in_grouping(g.bits, g.min, g.max);
    }

    protected override go_in_grouping(
      s: readonly number[],
      min: number,
      max: number,
    ): boolean {
      const g = grouping(s, min, max);
      return super.go_in_grouping(g.bits, g.min, g.max);
    }

    protected override in_grouping_b(
      s: readonly number[],
      min: number,
      max: number,
    ): boolean {
      const g = grouping(s, min, max);
      return super.in_grouping_b(g.bits, g.min, g.max);
    }

    protected override go_in_grouping_b(
      s: readonly number[],
      min: number,
      max: number,
    ): boolean {
      const g = grouping(s, min, max);
      return super.go_in_grouping_b(g.bits, g.min, g.max);
    }

    protected override out_grouping(
      s: readonly number[],
      min: number,
      max: number,
    ): boolean {
      const g = grouping(s, min, max);
      return super.out_grouping(g.bits, g.min, g.max);
    }

    protected override go_out_grouping(
      s: readonly number[],
      min: number,
      max: number,
    ): boolean {
      const g = grouping(s, min, max);
      return super.go_out_grouping(g.bits, g.min, g.max);
    }

    protected override out_grouping_b(
      s: readonly number[],
      min: number,
      max: number,
    ): boolean {
      const g = grouping(s, min, max);
      return super.out_grouping_b(g.bits, g.min, g.max);
    }

    protected override go_out_grouping_b(
      s: readonly number[],
      min: number,
      max: number,
    ): boolean {
      const g = grouping(s, min, max);
      return super.go_out_grouping_b(g.bits, g.min, g.max);
    }
  }

  // One instance, as for the accented stemmers: `stem()` resets its cursor
  // state on entry and a request is single-threaded.
  const stemmer = new FoldedStemmer();
  return {
    stem: (term) => foldLatinLetters(stemmer.stem(foldLatinLetters(term))),
  };
};
