/**
 * Spells custom words and a matter's names the way they are written after a
 * transcript comes back. The twin of the desktop's local spelling pass
 * (`apps/desktop/src-tauri/src/dictation_spelling.rs`), so the same words
 * change the same way, with one addition: a Czech or Slovak case ending,
 * or an English possessive, on a name keeps the ending, so "dvoraka" of
 * "Dvořák" reads "Dvořáka".
 *
 * A word or phrase is replaced only when it is close to one custom word and
 * to no other: the same letters with other case, diacritics, apostrophes or
 * hyphens, or, in a longer word, one or two letters off. Whole words only,
 * and short words only when they differ in case or diacritics alone.
 */

/** Custom words shorter than this, in letters, are left alone: too many ordinary words are that close to them. */
const MIN_LETTERS = 4;
/** From this many letters on, one letter may differ. */
const ONE_OFF_LETTERS = 6;
/** From this many letters on, two letters may differ. */
const TWO_OFF_LETTERS = 10;

/**
 * Czech and Slovak case endings a name takes: after a word ending in a
 * consonant (Novák, Nováka, Novákovi), in place of a final -a, -o or -e
 * (Hrdlička, Hrdličky), and in place of a final -ý or -í (Novotný,
 * Novotného). Any word takes the "s" of an English possessive. Written
 * with their accents where only one spelling exists, so an ending spoken
 * without them gets them back; an ending that could be either is kept as
 * spoken.
 */
const ENDINGS = {
  consonant: [
    "a",
    "u",
    "e",
    "ovi",
    "em",
    "om",
    "ové",
    "i",
    "y",
    "ům",
    "ech",
    "och",
    "ov",
    "ami",
  ],
  vowel: [
    "a",
    "y",
    "e",
    "u",
    "ou",
    "o",
    "ám",
    "ách",
    "ami",
    "em",
    "ech",
    "ům",
    "i",
  ],
  adjective: [
    "ého",
    "ému",
    "ým",
    "ých",
    "ými",
    "ího",
    "ímu",
    "ím",
    "á",
    "é",
    "ou",
  ],
  possessive: ["s"],
} as const satisfies Record<string, readonly string[]>;

/** A custom word or phrase as compared: its words, folded. */
type Target = {
  readonly spelling: string;
  /** The words as written, in order. */
  readonly words: readonly string[];
  readonly folded: readonly string[];
  readonly letters: number;
};

/** A piece of the text: a word, or what lies between two words. */
type Piece = { readonly kind: "word" | "between"; readonly text: string };

/** How one word of the text reads as one word of a custom word. */
type WordMatch = {
  readonly distance: number;
  /** The word as it should be written, its ending kept. */
  readonly spelled: string;
  readonly inflected: boolean;
};

/** `text` with every close miss of a custom word spelled as in `words`. */
export const respell = (text: string, words: readonly string[]): string => {
  const targets = words.flatMap((word) => {
    const made = target(word);
    return made === undefined ? [] : [made];
  });
  if (targets.length === 0) {
    return text;
  }
  const pieces = splitWords(text);
  let out = "";
  let index = 0;
  for (
    let piece = pieces.at(0);
    piece !== undefined;
    piece = pieces.at(index)
  ) {
    const match =
      piece.kind === "word"
        ? bestMatch(pieces.slice(index), targets)
        : undefined;
    if (match === undefined) {
      out += piece.text;
      index += 1;
    } else {
      out += match.spelled;
      index += match.taken;
    }
  }
  return out;
};

const target = (spelling: string): Target | undefined => {
  const words = spelling.split(/\s+/u).filter((word) => fold(word) !== "");
  const folded = words.map(fold);
  const letters = folded.reduce(
    (sum, word) => sum + Array.from(word).length,
    0,
  );
  return letters >= MIN_LETTERS
    ? { spelling, words, folded, letters }
    : undefined;
};

const isWordCharacter = (character: string): boolean =>
  /^[\p{L}\p{N}]$/u.test(character);

/**
 * Splits `text` into words and what lies between them. A word is a run of
 * letters and digits, with an apostrophe or a hyphen inside it and the
 * combining accents that follow its letters.
 */
const splitWords = (text: string): Piece[] => {
  const characters = Array.from(text);
  const pieces: Piece[] = [];
  let current = "";
  let inWord = false;
  for (const [position, character] of characters.entries()) {
    const next = characters.at(position + 1);
    // Annotated: `inWord` narrows through its own update in this loop.
    const joins: boolean =
      inWord &&
      JOINERS.has(character) &&
      next !== undefined &&
      isWordCharacter(next);
    const wordlike: boolean =
      isWordCharacter(character) || joins || (inWord && isCombining(character));
    if (wordlike !== inWord && current !== "") {
      pieces.push({ kind: inWord ? "word" : "between", text: current });
      current = "";
    }
    current += character;
    inWord = wordlike;
  }
  if (current !== "") {
    pieces.push({ kind: inWord ? "word" : "between", text: current });
  }
  return pieces;
};

const JOINERS = new Set(["'", "’", "-"]);

/**
 * The custom word the words at the start of `pieces` are a close miss of,
 * spelled, and how many pieces it covers; the closest wins, then the one
 * without endings, then the longest phrase. None when none is close, when
 * two are equally close, or when the words already read as the custom word.
 */
const bestMatch = (
  pieces: readonly Piece[],
  targets: readonly Target[],
): { spelled: string; taken: number } | undefined => {
  let best:
    { spelled: string; taken: number; rank: readonly number[] } | undefined;
  let tied = false;
  for (const candidate of targets) {
    const leading = leadingWords(pieces, candidate.folded.length);
    if (leading === undefined) {
      continue;
    }
    const matches = leading.words.map((word, index) =>
      matchWord(
        word,
        candidate.words[index] ?? "",
        candidate.folded[index] ?? "",
      ),
    );
    if (matches.some((match) => match === undefined)) {
      continue;
    }
    const found = matches.filter((match) => match !== undefined);
    const distance = found.reduce((sum, match) => sum + match.distance, 0);
    if (distance > allowed(candidate.letters)) {
      continue;
    }
    const rank = [
      distance,
      found.filter(({ inflected }) => inflected).length,
      -candidate.folded.length,
    ];
    const order = best === undefined ? -1 : compareRanks(rank, best.rank);
    if (order === 0) {
      tied = true;
    } else if (order < 0) {
      const original = joinPieces(pieces.slice(0, leading.taken));
      best = {
        spelled: casedLike(
          spellPhrase(
            found.map(({ spelled }) => spelled),
            candidate.spelling,
          ),
          original,
        ),
        taken: leading.taken,
        rank,
      };
      tied = false;
    }
  }
  if (best === undefined || tied) {
    return undefined;
  }
  return best.spelled === joinPieces(pieces.slice(0, best.taken))
    ? undefined
    : { spelled: best.spelled, taken: best.taken };
};

const compareRanks = (
  left: readonly number[],
  right: readonly number[],
): number => {
  for (const [index, value] of left.entries()) {
    const other = right.at(index) ?? 0;
    if (value !== other) {
      return value - other;
    }
  }
  return 0;
};

/** The spelled words of a phrase, joined as the custom word joins them. */
const spellPhrase = (spelled: readonly string[], spelling: string): string => {
  const gaps = spelling.trim().match(/\s+/gu) ?? [];
  return spelled.map((word, index) => `${word}${gaps[index] ?? ""}`).join("");
};

const joinPieces = (pieces: readonly Piece[]): string =>
  pieces.map(({ text }) => text).join("");

/**
 * The first `count` words of `pieces` when only spaces separate them, and
 * how many pieces they span.
 */
const leadingWords = (
  pieces: readonly Piece[],
  count: number,
): { words: string[]; taken: number } | undefined => {
  const words: string[] = [];
  for (const [index, piece] of pieces.entries()) {
    if (piece.kind === "word") {
      words.push(piece.text);
    } else if (!/^ +$/u.test(piece.text)) {
      return undefined;
    }
    if (words.length === count) {
      return { words, taken: index + 1 };
    }
  }
  return undefined;
};

/**
 * How `word` reads as one word of a custom word: as it stands, or as its
 * stem with a case ending. None when the two differ in a word with digits,
 * such as a section or standard number, which must match exactly.
 */
const matchWord = (
  word: string,
  spelling: string,
  custom: string,
): WordMatch | undefined => {
  const folded = fold(word);
  const plain = distance(folded, custom);
  const numbered = (text: string) => /\p{N}/u.test(text);
  if (plain !== 0 && (numbered(folded) || numbered(custom))) {
    return undefined;
  }
  let best: WordMatch = {
    distance: plain,
    spelled: spelling,
    inflected: false,
  };
  if (plain === 0 || numbered(custom)) {
    return best;
  }
  for (const { stem, written, endings } of stems(spelling, custom)) {
    for (const ending of endings) {
      const key = fold(ending);
      if (!folded.endsWith(key) || folded.length <= key.length) {
        continue;
      }
      const apart = distance(folded.slice(0, -key.length), stem);
      if (apart < best.distance) {
        best = {
          distance: apart,
          spelled: `${written}${spokenEnding(word, ending)}`,
          inflected: true,
        };
      }
    }
  }
  return best;
};

/**
 * The stems a custom word takes endings on: the whole word after a
 * consonant or before a possessive, the word without its final vowel, and
 * the word without the "e" of a final -ek or -ec (Dvořáček, Dvořáčka).
 * Only stems of at least `MIN_LETTERS` letters, so a short word does not
 * become an ending away from ordinary words.
 */
const stems = (
  spelling: string,
  custom: string,
): { stem: string; written: string; endings: readonly string[] }[] => {
  const letters = Array.from(spelling);
  const last = custom.at(-1) ?? "";
  const found: { stem: string; written: string; endings: readonly string[] }[] =
    [{ stem: custom, written: spelling, endings: ENDINGS.possessive }];
  if (/[aeo]/u.test(last)) {
    found.push({
      stem: custom.slice(0, -1),
      written: letters.slice(0, -1).join(""),
      endings: ENDINGS.vowel,
    });
  } else if (/[yi]/u.test(last)) {
    found.push({
      stem: custom.slice(0, -1),
      written: letters.slice(0, -1).join(""),
      endings: ENDINGS.adjective,
    });
  } else if (/\p{L}/u.test(last)) {
    found.push({ stem: custom, written: spelling, endings: ENDINGS.consonant });
    if (/e[kc]$/u.test(custom) && fold(letters.at(-2) ?? "") === "e") {
      found.push({
        stem: `${custom.slice(0, -2)}${last}`,
        written: `${letters.slice(0, -2).join("")}${letters.at(-1) ?? ""}`,
        endings: ENDINGS.consonant,
      });
    }
  }
  return found.filter(({ stem }) => Array.from(stem).length >= MIN_LETTERS);
};

/**
 * The ending of `word` as spoken, with the apostrophe before an English
 * "s"; spoken without accents, as written in `ending`, in the case spoken.
 */
const spokenEnding = (word: string, ending: string): string => {
  const spoken = lastLetters(word, Array.from(fold(ending)).length);
  // Accents or an apostrophe: the ending was spoken in full.
  if (fold(spoken) !== spoken.toLowerCase()) {
    return spoken;
  }
  return spoken === spoken.toUpperCase() && spoken !== spoken.toLowerCase()
    ? ending.toUpperCase()
    : ending;
};

/** The last `letters` letters of `word`, with their accents and the apostrophe or hyphen before them. */
const lastLetters = (word: string, letters: number): string => {
  const characters = Array.from(word);
  let start = characters.length;
  let counted = 0;
  while (start > 0 && counted < letters) {
    start -= 1;
    const character = characters[start] ?? "";
    if (!isCombining(character) && !JOINERS.has(character)) {
      counted += 1;
    }
  }
  while (start > 0 && JOINERS.has(characters[start - 1] ?? "")) {
    start -= 1;
  }
  return characters.slice(start).join("");
};

/** How many letters may differ in a custom word of `letters` letters. */
const allowed = (letters: number): number => {
  if (letters >= TWO_OFF_LETTERS) {
    return 2;
  }
  return letters >= ONE_OFF_LETTERS ? 1 : 0;
};

/**
 * `spelling` as written, with a capital first letter when the replaced text
 * had one and the custom word starts in lower case, as at the start of a
 * sentence.
 */
const casedLike = (spelling: string, original: string): string => {
  const first = Array.from(spelling).at(0) ?? "";
  const originalFirst = Array.from(original).at(0) ?? "";
  const upper = (character: string) =>
    character !== character.toLowerCase() &&
    character === character.toUpperCase();
  const lower = (character: string) =>
    character !== character.toUpperCase() &&
    character === character.toLowerCase();
  return upper(originalFirst) && lower(first)
    ? `${first.toUpperCase()}${spelling.slice(first.length)}`
    : spelling;
};

/** Lower case, without diacritics and without apostrophes or hyphens. */
const fold = (word: string): string =>
  Array.from(word)
    .filter((character) => !JOINERS.has(character) && !isCombining(character))
    .map((character) =>
      Array.from(character.toLowerCase())
        .map((letter) => BASE_LETTERS[letter] ?? letter)
        .join(""),
    )
    .join("");

/** A combining accent, written after the letter it belongs to. */
const isCombining = (character: string): boolean => {
  const code = character.codePointAt(0) ?? 0;
  return (
    (code >= 0x03_00 && code <= 0x03_6f) ||
    (code >= 0x1a_b0 && code <= 0x1a_ff) ||
    (code >= 0x1d_c0 && code <= 0x1d_ff) ||
    (code >= 0x20_d0 && code <= 0x20_ff) ||
    (code >= 0xfe_20 && code <= 0xfe_2f)
  );
};

/** The letter without its diacritic, for the Latin letters the dictation languages use. */
const BASE_LETTERS: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries({
    a: "áàâäãåāąă",
    c: "čćç",
    d: "ďđ",
    e: "éèêëěēęė",
    g: "ģ",
    i: "íìîïīį",
    k: "ķ",
    l: "ĺľłļ",
    n: "ňńñņ",
    o: "óòôöõőøō",
    r: "ŕř",
    s: "šśşș",
    t: "ťţț",
    u: "úùûüůűūų",
    y: "ýÿ",
    z: "žźż",
  }).flatMap(([base, letters]) =>
    Array.from(letters).map((letter) => [letter, base]),
  ),
);

/** Edits between two words, a swap of neighbouring letters counted once. */
const distance = (left: string, right: string): number => {
  const a = Array.from(left);
  const b = Array.from(right);
  const width = b.length + 1;
  // The first row and column count the edits from an empty word.
  const table = Array.from({ length: (a.length + 1) * width }, (_, cell) => {
    if (cell < width) {
      return cell;
    }
    return cell % width === 0 ? cell / width : 0;
  });
  const at = (row: number, column: number) => table[row * width + column] ?? 0;
  for (let row = 1; row <= a.length; row += 1) {
    for (let column = 1; column <= b.length; column += 1) {
      const cost = a[row - 1] === b[column - 1] ? 0 : 1;
      let best = Math.min(
        at(row - 1, column) + 1,
        at(row, column - 1) + 1,
        at(row - 1, column - 1) + cost,
      );
      if (
        row > 1 &&
        column > 1 &&
        a[row - 1] === b[column - 2] &&
        a[row - 2] === b[column - 1]
      ) {
        best = Math.min(best, at(row - 2, column - 2) + 1);
      }
      table[row * width + column] = best;
    }
  }
  return at(a.length, b.length);
};
