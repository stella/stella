// Where a middle-truncated value splits into the head that may be cut and the
// tail that always shows.

/** The tail aimed for, in graphemes; a word start nearby moves it. */
const TAIL = 10;
/** The shortest tail a word start may shrink it to. */
const MIN_TAIL = 4;
/** The longest tail a word start may stretch it to. */
const MAX_TAIL = 16;
/** Below this many head graphemes a split saves too little to be worth it. */
const MIN_HEAD = 4;

// Characters after which a new word starts: `revize-klienta`, `v3_final`, a
// path segment, a space. Not `.`: an extension stays with the word before it
// (`…klienta.docx`, not `…docx`).
const WORD_BREAKS = new Set(["-", "_", "/", "\\", " "]);

let segmenter: Intl.Segmenter | undefined;

/** The value's user-perceived characters, so a cut never splits one. */
export const graphemesOf = (value: string): string[] => {
  segmenter ??= new Intl.Segmenter(undefined, { granularity: "grapheme" });
  return Array.from(segmenter.segment(value), ({ segment }) => segment);
};

const RTL_LETTER =
  /[\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}\p{Script=Adlam}]/u;

const strongDirections = (text: string): ("ltr" | "rtl")[] =>
  Array.from(text.matchAll(/\p{L}/gu), (letter) =>
    RTL_LETTER.test(letter[0]) ? "rtl" : "ltr",
  );

/**
 * The head and tail render as two boxes, each ordered on its own. A run in the
 * other direction than the name's stays readable only while one box holds it:
 * cut through it and its words swap sides even when nothing is truncated.
 */
const cutsThroughForeignRun = (head: string, tail: string): boolean => {
  const before = strongDirections(head);
  const base = before.at(0);
  const last = before.at(-1);
  return last !== base && strongDirections(tail).at(0) === last;
};

type MiddleTruncateSplit = { head: string; tail: string };

/** The head and tail of `value`, or null when it should stay in one piece. */
export const splitForMiddleTruncate = (
  value: string,
): MiddleTruncateSplit | null => {
  const characters = graphemesOf(value);
  if (characters.length < TAIL + MIN_HEAD) {
    return null;
  }
  const cut = tailStart(characters);
  const head = characters.slice(0, cut).join("");
  const tail = characters.slice(cut).join("");
  return cutsThroughForeignRun(head, tail) ? null : { head, tail };
};

/**
 * The index the tail starts at: on a word when one starts within reach. A
 * shorter tail is preferred so the head keeps more of the name; a longer one
 * is the fallback.
 */
function tailStart(characters: readonly string[]): number {
  const aimed = characters.length - TAIL;
  const startsWord = (index: number) =>
    WORD_BREAKS.has(characters[index - 1] ?? "");
  if (startsWord(aimed)) {
    return aimed;
  }
  for (let index = aimed + 1; index <= characters.length - MIN_TAIL; index++) {
    if (startsWord(index)) {
      return index;
    }
  }
  const longest = Math.max(MIN_HEAD, characters.length - MAX_TAIL);
  for (let index = aimed - 1; index >= longest; index--) {
    if (startsWord(index)) {
      return index;
    }
  }
  return aimed;
}
