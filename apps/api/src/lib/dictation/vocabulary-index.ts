import { panic } from "better-result";

import { normalizeUnicode, stripDiacritics } from "@stll/text-normalize";

/**
 * Which of an organization's dictation words one transcript needs.
 *
 * The list may hold thousands of words, far more than a model should read,
 * so cleanup gets only the words this transcript seems to mention: said
 * outright, misheard into a near spelling, or written the way another
 * language would sound them ("Majkrosoft" for "Microsoft"). Each word is
 * indexed once per list by three keys, and every run of up to a few
 * transcript words is looked up by the same keys:
 *
 * - its letters without case, diacritics, spaces or punctuation, so
 *   "Face book" or "zaloba" finds "Facebook" or "žaloba";
 * - its consonant skeleton, the order of its consonant sounds with vowels
 *   left out, in a Slavic and in an English reading of the spelling
 *   (c, ch, g and j sound different in each), so a word spelled in one
 *   language matches its sound written in the other;
 * - the skeleton with any one consonant left out, so a long word with one
 *   misheard consonant still matches.
 *
 * A match is ranked by how it matched, then by how close its spelling is,
 * how often it occurs and how recently the word was added. Lookups are hash
 * lookups, so a transcript costs time in proportion to its length, not to
 * the size of the list. Pure and deterministic: no clock, input or output.
 */

/** A word's skeleton needs this many consonants to match by sound alone;
 *  shorter ones ("NDA" sounds like "and") match only by their letters. */
const MIN_SOUND_LENGTH = 3;
/** A word's skeleton needs this many consonants to match with one wrong. */
const MIN_NEAR_SOUND_LENGTH = 5;
/** The longest run of transcript words looked up at once. */
const MAX_WINDOW_WORDS = 8;
/** A word needs this many letters to match by letters alone. */
const MIN_LETTERS = 2;

const MATCH_RANK = { letters: 3, sound: 2, nearSound: 1 } as const;
type MatchKind = keyof typeof MATCH_RANK;
/**
 * How close the spellings must also be (1 less the edit distance over the
 * longer length): a word sounded out in another language keeps about a
 * third of its letters ("Fejsbuk" and "Facebook" score 0.38), and one with
 * a misheard consonant about half.
 */
const MIN_SIMILARITY = {
  letters: 0,
  sound: 0.34,
  nearSound: 0.5,
} as const satisfies Record<MatchKind, number>;

const READINGS = ["slavic", "english"] as const;
type Reading = (typeof READINGS)[number];

const WORD = /[\p{L}\p{N}]+/gu;
const DIGIT = /\p{N}/u;
const VOWELS = new Set(["a", "e", "i", "o", "u", "y"]);
const FRONT_VOWELS = new Set(["e", "i", "y"]);

/** Consonant letters by their sound class; vowels, h and (in a Slavic
 *  reading) j carry no class. */
const SOUND_CLASS: ReadonlyMap<string, string> = new Map([
  ["b", "P"],
  ["p", "P"],
  ["d", "T"],
  ["t", "T"],
  ["ď", "T"],
  ["ť", "T"],
  ["g", "K"],
  ["k", "K"],
  ["q", "K"],
  ["f", "F"],
  ["v", "F"],
  ["w", "F"],
  ["s", "S"],
  ["z", "S"],
  ["š", "S"],
  ["ž", "S"],
  ["č", "S"],
  ["ć", "S"],
  ["ś", "S"],
  ["ź", "S"],
  ["ż", "S"],
  ["ß", "S"],
  ["l", "L"],
  ["ľ", "L"],
  ["ĺ", "L"],
  ["ł", "L"],
  ["r", "R"],
  ["ř", "R"],
  ["ŕ", "R"],
  ["m", "M"],
  ["n", "N"],
  ["ň", "N"],
  ["ń", "N"],
  ["ñ", "N"],
  ["x", "KS"],
]);

const BASE_LETTERS = new Map<string, string>();

/** The base letter, for a vowel with a diacritic ("á" is a vowel). */
const baseLetter = (letter: string): string => {
  if (letter < "\u0080") {
    return letter;
  }
  let base = BASE_LETTERS.get(letter);
  if (base === undefined) {
    base = stripDiacritics(letter);
    // Letters are a small, closed set; the cache stays small.
    if (BASE_LETTERS.size < 4096) {
      BASE_LETTERS.set(letter, base);
    }
  }
  return base;
};

/**
 * The consonant skeleton of one lowercase word in one reading. Repeated
 * classes collapse unless a vowel separates them ("Lovells" is LFLS).
 */
const wordSkeleton = (word: string, reading: Reading): string => {
  const letters = [...word];
  let skeleton = "";
  let previous = "";
  const emit = (classes: string) => {
    for (const sound of classes) {
      if (sound !== previous) {
        skeleton += sound;
      }
      previous = sound;
    }
  };
  for (let index = 0; index < letters.length; index += 1) {
    const letter = letters[index] ?? "";
    const next = letters[index + 1] ?? "";
    switch (letter) {
      case "c":
        if (next === "h") {
          // Czech "chata" is /x/, English "chance" is /tʃ/.
          emit(reading === "english" ? "S" : "K");
          index += 1;
        } else if (next === "k") {
          emit("K");
          index += 1;
        } else {
          // Slavic c is always /ts/; English c is /s/ only before e, i, y.
          emit(
            reading === "english" && !FRONT_VOWELS.has(baseLetter(next))
              ? "K"
              : "S",
          );
        }
        break;
      case "s":
      case "t":
      case "p":
        if (next === "h") {
          emit(letter === "p" ? "F" : (SOUND_CLASS.get(letter) ?? ""));
          index += 1;
        } else {
          emit(SOUND_CLASS.get(letter) ?? "");
        }
        break;
      case "d":
        // "dž" and "dz" are one affricate.
        if (next === "ž" || next === "z") {
          emit("S");
          index += 1;
        } else {
          emit("T");
        }
        break;
      case "g":
        emit(
          reading === "english" && FRONT_VOWELS.has(baseLetter(next))
            ? "S"
            : "K",
        );
        break;
      case "j":
        if (reading === "english") {
          emit("S");
        }
        break;
      case "h":
        break;
      default: {
        const sound = SOUND_CLASS.get(letter);
        if (sound !== undefined) {
          emit(sound);
        } else if (DIGIT.test(letter)) {
          emit(letter);
        } else if (VOWELS.has(baseLetter(letter))) {
          previous = "";
        }
      }
    }
  }
  return skeleton;
};

/** Skeletons of consecutive words, joined; a class repeated across the
 *  join collapses, so "face book" and "facebook" share one. */
const joinSkeletons = (left: string, right: string): string =>
  left.length > 0 && right.length > 0 && left.at(-1) === right[0]
    ? left + right.slice(1)
    : left + right;

/** The skeleton of a run of words in one reading. */
const phraseSkeleton = (words: readonly string[], reading: Reading): string => {
  let skeleton = "";
  for (const word of words) {
    skeleton = joinSkeletons(skeleton, wordSkeleton(word, reading));
  }
  return skeleton;
};

const foldWord = (word: string): string => stripDiacritics(word);

/** Every string one character shorter than `key`. */
const deletions = (key: string): Set<string> => {
  const variants = new Set<string>();
  for (let index = 0; index < key.length; index += 1) {
    variants.add(key.slice(0, index) + key.slice(index + 1));
  }
  return variants;
};

/**
 * Optimal string alignment distance (Damerau-Levenshtein without repeated
 * edits of one substring), over UTF-16 code units; the inputs are folded
 * Latin text or skeletons, so code units are characters.
 */
export const alignmentDistance = (left: string, right: string): number => {
  if (left === right) {
    return 0;
  }
  if (left.length === 0 || right.length === 0) {
    return Math.max(left.length, right.length);
  }
  let beforePrevious = Array.from({ length: right.length + 1 }, () => 0);
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  let current = Array.from({ length: right.length + 1 }, () => 0);
  for (let row = 1; row <= left.length; row += 1) {
    current[0] = row;
    for (let column = 1; column <= right.length; column += 1) {
      const cost = left[row - 1] === right[column - 1] ? 0 : 1;
      let best = Math.min(
        (previous[column] ?? 0) + 1,
        (current[column - 1] ?? 0) + 1,
        (previous[column - 1] ?? 0) + cost,
      );
      if (
        row > 1 &&
        column > 1 &&
        left[row - 1] === right[column - 2] &&
        left[row - 2] === right[column - 1]
      ) {
        best = Math.min(best, (beforePrevious[column - 2] ?? 0) + 1);
      }
      current[column] = best;
    }
    [beforePrevious, previous, current] = [previous, current, beforePrevious];
  }
  return previous[right.length] ?? 0;
};

/** Whether one edit (a change, an extra or missing character, or two
 *  neighbours swapped) turns one string into the other. */
export const oneEditApart = (left: string, right: string): boolean => {
  if (Math.abs(left.length - right.length) > 1 || left === right) {
    return false;
  }
  let start = 0;
  while (start < left.length && left[start] === right[start]) {
    start += 1;
  }
  if (left.length !== right.length) {
    const [shorter, longer] =
      left.length < right.length ? [left, right] : [right, left];
    return shorter.slice(start) === longer.slice(start + 1);
  }
  return (
    left.slice(start + 1) === right.slice(start + 1) ||
    (left[start] === right[start + 1] &&
      left[start + 1] === right[start] &&
      left.slice(start + 2) === right.slice(start + 2))
  );
};

const similarity = (left: string, right: string): number => {
  const longest = Math.max(left.length, right.length);
  return longest === 0 ? 1 : 1 - alignmentDistance(left, right) / longest;
};

type IndexedTerm = {
  readonly term: string;
  /** Letters only, folded: no case, diacritics, spaces or punctuation. */
  readonly letters: string;
  /** Distinct skeletons over both readings. */
  readonly skeletons: readonly string[];
};

export type VocabularyIndex = {
  readonly size: number;
  readonly terms: readonly IndexedTerm[];
  readonly byLetters: ReadonlyMap<string, readonly number[]>;
  readonly bySound: ReadonlyMap<string, readonly number[]>;
  readonly byNearSound: ReadonlyMap<string, readonly number[]>;
  /** The run lengths, in words, worth looking up. */
  readonly windowSizes: readonly number[];
};

const addTo = (map: Map<string, number[]>, key: string, termIndex: number) => {
  const indices = map.get(key);
  if (indices === undefined) {
    map.set(key, [termIndex]);
  } else if (indices.at(-1) !== termIndex) {
    indices.push(termIndex);
  }
};

const readWords = (text: string): string[] =>
  Array.from(
    normalizeUnicode(text, "NFC").toLowerCase().matchAll(WORD),
    ([word]) => word,
  );

/**
 * The index of an organization's words, newest first: the order breaks
 * ties between equally good matches.
 */
export const buildVocabularyIndex = (
  newestFirst: readonly string[],
): VocabularyIndex => {
  const byLetters = new Map<string, number[]>();
  const bySound = new Map<string, number[]>();
  const byNearSound = new Map<string, number[]>();
  const wordCounts = new Set<number>();
  const terms = newestFirst.map((term, termIndex): IndexedTerm => {
    const words = readWords(term);
    const letters = words.map(foldWord).join("");
    if (letters.length >= MIN_LETTERS) {
      addTo(byLetters, letters, termIndex);
    }
    const skeletons = new Set(
      READINGS.map((reading) => phraseSkeleton(words, reading)),
    );
    for (const skeleton of skeletons) {
      if (skeleton.length >= MIN_SOUND_LENGTH) {
        addTo(bySound, skeleton, termIndex);
      }
      if (skeleton.length >= MIN_NEAR_SOUND_LENGTH) {
        for (const variant of deletions(skeleton)) {
          addTo(byNearSound, variant, termIndex);
        }
      }
    }
    if (words.length > 0 && words.length <= MAX_WINDOW_WORDS) {
      wordCounts.add(words.length);
    }
    return { term, letters, skeletons: [...skeletons] };
  });
  // Recognition may split a word in two or join two into one.
  const windowSizes = new Set<number>();
  for (const count of wordCounts) {
    for (const size of [count - 1, count, count + 1]) {
      if (size >= 1 && size <= MAX_WINDOW_WORDS) {
        windowSizes.add(size);
      }
    }
  }
  return {
    size: terms.length,
    terms,
    byLetters,
    bySound,
    byNearSound,
    windowSizes: [...windowSizes].toSorted((left, right) => left - right),
  };
};

/** The words a key names; a key no word has names none. */
const postings = (
  map: ReadonlyMap<string, readonly number[]>,
  key: string,
): readonly number[] => map.get(key) ?? NO_POSTINGS;
const NO_POSTINGS: readonly number[] = [];

type Candidate = { score: number; hits: number };

type TranscriptWord = {
  letters: string;
  skeletons: Record<Reading, string>;
};

/**
 * The organization's words this transcript seems to mention, best first,
 * at most `limit` of them.
 */
/** The work one selection did, counted for tests that bound its cost:
 *  posting entries visited and spellings compared. */
export type VocabularySelectionWork = { visited: number; compared: number };

export const selectVocabulary = (
  index: VocabularyIndex,
  transcript: string,
  limit: number,
  meter?: VocabularySelectionWork,
): string[] => {
  const work = meter ?? { visited: 0, compared: 0 };
  if (index.size === 0 || limit <= 0) {
    return [];
  }
  const words: TranscriptWord[] = readWords(transcript).map((word) => ({
    letters: foldWord(word),
    skeletons: {
      slavic: wordSkeleton(word, "slavic"),
      english: wordSkeleton(word, "english"),
    },
  }));
  const candidates = new Map<number, Candidate>();
  // One spelling met again needs no second comparison.
  const compared = new Map<string, number>();
  const consider = (termIndex: number, kind: MatchKind, letters: string) => {
    work.visited += 1;
    const term =
      index.terms[termIndex] ?? panicMissingTerm(termIndex, index.size);
    const floor = MIN_SIMILARITY[kind];
    const longest = Math.max(letters.length, term.letters.length);
    // The lengths alone bound how close the spellings can be.
    if (
      longest > 0 &&
      1 - Math.abs(letters.length - term.letters.length) / longest < floor
    ) {
      return;
    }
    const memoKey = `${termIndex}\u0000${letters}`;
    let close = compared.get(memoKey);
    if (close === undefined) {
      close = similarity(letters, term.letters);
      work.compared += 1;
      compared.set(memoKey, close);
    }
    if (close < floor) {
      return;
    }
    const score = MATCH_RANK[kind] + close;
    const known = candidates.get(termIndex);
    if (known === undefined) {
      candidates.set(termIndex, { score, hits: 1 });
    } else {
      known.score = Math.max(known.score, score);
      known.hits += 1;
    }
  };
  // Skeletons recur across a transcript; each is resolved once.
  const nearSoundOf = new Map<string, number[]>();
  const nearSound = (skeleton: string): number[] => {
    const known = nearSoundOf.get(skeleton);
    if (known !== undefined) {
      return known;
    }
    const near = new Set<number>();
    for (const termIndex of postings(index.byNearSound, skeleton)) {
      near.add(termIndex);
    }
    if (skeleton.length >= MIN_NEAR_SOUND_LENGTH) {
      for (const variant of deletions(skeleton)) {
        for (const termIndex of postings(index.bySound, variant)) {
          near.add(termIndex);
        }
        for (const termIndex of postings(index.byNearSound, variant)) {
          near.add(termIndex);
        }
      }
    }
    work.visited += near.size;
    const verified = [...near].filter((termIndex) =>
      (
        index.terms[termIndex] ?? panicMissingTerm(termIndex, index.size)
      ).skeletons.some(
        (candidate) =>
          candidate.length >= MIN_NEAR_SOUND_LENGTH &&
          oneEditApart(candidate, skeleton),
      ),
    );
    nearSoundOf.set(skeleton, verified);
    return verified;
  };
  for (let start = 0; start < words.length; start += 1) {
    let letters = "";
    let skeletons: Record<Reading, string> = { slavic: "", english: "" };
    let size = 0;
    for (const end of index.windowSizes) {
      // Extend the run word by word up to the next size worth a lookup.
      while (size < end && start + size < words.length) {
        const word = words[start + size] ?? panicMissingTerm(size, end);
        letters += word.letters;
        skeletons = {
          slavic: joinSkeletons(skeletons.slavic, word.skeletons.slavic),
          english: joinSkeletons(skeletons.english, word.skeletons.english),
        };
        size += 1;
      }
      if (size < end) {
        break;
      }
      if (letters.length >= MIN_LETTERS) {
        for (const termIndex of postings(index.byLetters, letters)) {
          consider(termIndex, "letters", letters);
        }
      }
      const distinct = new Set([skeletons.slavic, skeletons.english]);
      for (const skeleton of distinct) {
        if (skeleton.length >= MIN_SOUND_LENGTH) {
          for (const termIndex of postings(index.bySound, skeleton)) {
            consider(termIndex, "sound", letters);
          }
        }
        if (skeleton.length >= MIN_NEAR_SOUND_LENGTH - 1) {
          for (const termIndex of nearSound(skeleton)) {
            consider(termIndex, "nearSound", letters);
          }
        }
      }
    }
  }
  return [...candidates]
    .toSorted(
      ([leftIndex, left], [rightIndex, right]) =>
        right.score - left.score ||
        right.hits - left.hits ||
        leftIndex - rightIndex,
    )
    .slice(0, limit)
    .map(
      ([termIndex]) =>
        (index.terms[termIndex] ?? panicMissingTerm(termIndex, index.size))
          .term,
    );
};

const panicMissingTerm = (position: number, size: number): never =>
  panic(`Vocabulary index has no position ${position} of ${size}`);
