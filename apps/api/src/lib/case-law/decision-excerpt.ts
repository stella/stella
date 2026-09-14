import { SEARCH_EXCERPTS, type SearchExcerpt } from "@stll/api-contract/search";

import {
  highlightCorpusPassage,
  markCorpusFragment,
} from "@/api/lib/legal-search/corpus-passage-highlight";
import type { CorpusQueryToken } from "@/api/lib/legal-search/corpus-query";
import type { MorphologyLanguage } from "@/api/lib/legal-search/morphology/stem";
import {
  escapeSearchHtml,
  HIGHLIGHT_START,
  HIGHLIGHT_STOP,
  stripSearchHighlightMarkup,
} from "@/api/lib/search/highlight";

/**
 * How much of the matched passage each excerpt length shows.
 *
 * Two engines answer this search and neither measures a passage the same way,
 * so the size is stated once per length and each path reads the figure it can
 * act on. `short` is what every result has always been drawn at: the numbers
 * below reproduce today's window exactly, so the default is not a new
 * rendering of the whole corpus.
 *
 * The character figures are the ones a reader feels. `long` sits at roughly a
 * paragraph of legal prose and well inside one indexed passage, which the
 * chunker targets at about 400 tokens, so the longest excerpt can still be cut
 * from the passage the hit already carries.
 */
type ExcerptWindow = {
  /**
   * Characters of the passage a corpus hit shows. Quickwit's own snippet is
   * fixed and carries no size on the wire, so anything wider than `short` is
   * cut here from the passage text the hit already stores.
   */
  maxChars: number;
  /**
   * Words `ts_headline` may spend on one fragment, and the floor below which
   * it would rather not cut. Postgres counts words where the corpus index
   * counts characters, so the two figures are stated rather than derived from
   * each other: at roughly six characters a word in these languages they
   * describe the same excerpt, but `short` has to reproduce each engine's own
   * current window exactly, and those two were never the same size.
   */
  maxWords: number;
  minWords: number;
};

export const DECISION_EXCERPT_WINDOWS = {
  short: { maxChars: 100, maxWords: 20, minWords: 8 },
  medium: { maxChars: 200, maxWords: 34, minWords: 14 },
  long: { maxChars: 400, maxWords: 67, minWords: 28 },
} as const satisfies Record<SearchExcerpt, ExcerptWindow>;

export const decisionExcerptWindow = (excerpt: SearchExcerpt): ExcerptWindow =>
  DECISION_EXCERPT_WINDOWS[excerpt];

/**
 * Fragments one headline is cut into. Held at three across every length: the
 * count is how many separate occurrences a result surfaces, which is not what
 * the reader asked to change, and scaling both at once would make `long`
 * several paragraphs rather than one.
 */
const HEADLINE_FRAGMENTS = 3;

/**
 * The `ts_headline` options for one excerpt length.
 *
 * Built rather than stored as three strings so the markers and the fragment
 * count cannot drift apart between lengths; only the two word counts move.
 */
export const decisionHeadlineConfig = (excerpt: SearchExcerpt): string => {
  const { maxWords, minWords } = decisionExcerptWindow(excerpt);

  return (
    `MaxWords=${String(maxWords)}, MinWords=${String(minWords)}, ` +
    `MaxFragments=${String(HEADLINE_FRAGMENTS)}, FragmentDelimiter=..., ` +
    `StartSel=${HIGHLIGHT_START}, ` +
    `StopSel=${HIGHLIGHT_STOP}`
  );
};

/**
 * Whether this length is served by the engine's own snippet.
 *
 * Only the shortest is: it is the window Quickwit already produces, and
 * leaving it alone keeps the default result page byte-for-byte what it was.
 * Every wider length is cut from the hit's stored passage instead.
 */
export const usesEngineSnippet = (excerpt: SearchExcerpt): boolean =>
  excerpt === SEARCH_EXCERPTS[0];

/** Whitespace folded to one space, so a snippet re-wrapped by the engine still matches. */
const foldWhitespace = (text: string): string => text.replaceAll(/\s+/gu, " ");

/**
 * Where the engine's snippet sits in the passage, or null when it cannot be
 * placed.
 *
 * Exact first, because that is what an untouched snippet is. Failing that the
 * two sides are compared with their whitespace folded: the engine returns the
 * passage's words but not always the passage's line breaks, and a fold is the
 * one difference that makes an otherwise identical run miss.
 */
const locateSnippet = (
  passage: string,
  snippetText: string,
): { end: number; start: number } | null => {
  if (snippetText.length === 0) {
    return null;
  }

  const exact = passage.indexOf(snippetText);
  if (exact !== -1) {
    return { end: exact + snippetText.length, start: exact };
  }

  // The folded passage keeps one position per source position except where a
  // run collapsed, so the fold is walked alongside the source to map back.
  const folded = foldWhitespace(passage);
  const at = folded.indexOf(foldWhitespace(snippetText));
  if (at === -1) {
    return null;
  }

  // Walked in UTF-16 units, not code points: every index here is handed back
  // as an offset into `passage`, and a code-point index would address the
  // wrong character of it from the first astral letter onwards. A surrogate
  // half is not whitespace, so a pair keeps both of its units and stays
  // aligned with the fold, which preserves it whole.
  const sourceIndexOfFolded: number[] = [];
  let previousWasSpace = false;
  for (let index = 0; index < passage.length; index += 1) {
    const isSpace = /\s/u.test(passage.charAt(index));
    if (isSpace && previousWasSpace) {
      continue;
    }
    sourceIndexOfFolded.push(index);
    previousWasSpace = isSpace;
  }

  const start = sourceIndexOfFolded[at];
  const endFolded = at + foldWhitespace(snippetText).length;
  const end = sourceIndexOfFolded[endFolded] ?? passage.length;
  return start === undefined ? null : { end, start };
};

/**
 * A window of `maxChars` grown symmetrically around the snippet, on word
 * boundaries.
 *
 * Symmetric because the reader wants the sentence the match sits in, not the
 * text that happens to follow it; the edges move to whitespace so no word is
 * cut, and a window that reaches one end of the passage spends what is left at
 * the other.
 */
const growAroundSnippet = (
  passage: string,
  anchor: { end: number; start: number },
  maxChars: number,
): { end: number; start: number } => {
  const spare = maxChars - (anchor.end - anchor.start);
  if (spare <= 0) {
    return anchor;
  }

  const half = Math.floor(spare / 2);
  const wantedStart = Math.max(0, anchor.start - half);
  const wantedEnd = Math.min(passage.length, anchor.end + (spare - half));

  const atWordStart =
    wantedStart === 0
      ? 0
      : (() => {
          const boundary = passage.indexOf(" ", wantedStart);
          return boundary === -1 || boundary >= anchor.start
            ? wantedStart
            : boundary + 1;
        })();
  const atWordEnd =
    wantedEnd === passage.length
      ? passage.length
      : (() => {
          const boundary = passage.lastIndexOf(" ", wantedEnd);
          return boundary <= anchor.end ? wantedEnd : boundary;
        })();

  return { end: atWordEnd, start: atWordStart };
};

/** The engine's own marked runs, as ranges into the snippet's plain text. */
const engineMarkRanges = (
  snippet: string,
): readonly { end: number; start: number }[] => {
  const ranges: { end: number; start: number }[] = [];
  let plainLength = 0;
  for (const part of snippet.split(/(<mark>[^<]*<\/mark>)/gu)) {
    const marked = /^<mark>(?<text>[^<]*)<\/mark>$/u.exec(part)?.groups?.[
      "text"
    ];
    const text = stripSearchHighlightMarkup(marked ?? part);
    if (marked !== undefined && text.length > 0) {
      ranges.push({ end: plainLength + text.length, start: plainLength });
    }
    plainLength += text.length;
  }
  return ranges;
};

type CorpusExcerptOptions = {
  /** What the engine itself returned for this hit, if anything. */
  engineSnippet: string | null;
  excerpt: SearchExcerpt;
  language: MorphologyLanguage | null;
  /** The hit's stored passage, as the index holds it. */
  passage: unknown;
  tokens: readonly CorpusQueryToken[];
};

/**
 * The excerpt one corpus hit shows, at the length the reader asked for.
 *
 * Only the shortest length is the engine's own snippet: Quickwit accepts no
 * size on the wire, and leaving that one untouched keeps the default result
 * page exactly what it was. A wider length is cut from the passage the hit
 * already carries, which costs no further read because `text` is stored.
 *
 * The window is anchored on the engine's snippet rather than on the query's
 * words. The snippet is the engine's own account of why this hit matched —
 * after stemming and expansion, which nothing here reproduces — so anchoring
 * on it is what keeps a wider excerpt centred on the match instead of on
 * whichever word the client-side matcher could find. The wider text is then
 * marked with the same stemming matcher the passage highlighter uses, and
 * where that finds nothing the engine's own marks are placed back at the
 * snippet's position, so the column always says why the row is there.
 */
/**
 * `text` cut to at most `maxChars`, never mid-character.
 *
 * A hard bound, applied after a window is chosen and before it is marked. The
 * passage highlighter deliberately keeps a whole word even when that overruns
 * the budget, and corpus chunking allows a single block of OCR to arrive as
 * one enormous malformed token, so a word-boundary cut is not a bound at all
 * on a public endpoint. Cutting the plain text rather than the marked HTML is
 * what keeps the cut from landing inside a tag or an entity.
 */
const capToChars = (text: string, maxChars: number): string => {
  if (text.length <= maxChars) {
    return text;
  }
  // Never between a surrogate pair: half a letter is not a character.
  const lastKept = text.codePointAt(maxChars - 1);
  const cut =
    lastKept !== undefined && lastKept > 0xff_ff ? maxChars - 1 : maxChars;
  return text.slice(0, cut);
};

export const corpusExcerpt = ({
  engineSnippet,
  excerpt,
  language,
  passage,
  tokens,
}: CorpusExcerptOptions): string | null => {
  if (usesEngineSnippet(excerpt)) {
    return engineSnippet;
  }
  if (typeof passage !== "string" || passage.length === 0) {
    return engineSnippet;
  }

  const { maxChars } = decisionExcerptWindow(excerpt);
  const anchor =
    engineSnippet === null
      ? null
      : locateSnippet(passage, stripSearchHighlightMarkup(engineSnippet));
  const window =
    anchor === null ? null : growAroundSnippet(passage, anchor, maxChars);

  // One window as plain text, however it was chosen, so the cap and the
  // marking below both apply whichever way this went.
  const chosen =
    window === null
      ? // Nothing to anchor on: the window the query's own words find, which
        // is the passage's opening when they are not in it either.
        highlightCorpusPassage({ passage, tokens, language, maxChars }).text
      : passage.slice(window.start, window.end);

  const text = capToChars(chosen, maxChars);
  if (text.length === 0) {
    return engineSnippet;
  }

  const marked = markCorpusFragment({ text, tokens, language });
  if (window === null || marked.includes("<mark>")) {
    return marked;
  }

  // The matcher found none of the query's words — the engine matched through
  // an expansion it does not reproduce. Its own marks are the answer.
  return markAtSnippet({
    engineSnippet: engineSnippet ?? "",
    snippetStart: (anchor?.start ?? 0) - window.start,
    text,
  });
};

type MarkAtSnippetOptions = {
  engineSnippet: string;
  /** Where the snippet's text begins inside `text`. */
  snippetStart: number;
  text: string;
};

/** `text`, escaped, carrying the engine's marks at the snippet's position. */
const markAtSnippet = ({
  engineSnippet,
  snippetStart,
  text,
}: MarkAtSnippetOptions): string => {
  let html = "";
  let cursor = 0;
  for (const range of engineMarkRanges(engineSnippet)) {
    const start = snippetStart + range.start;
    const end = snippetStart + range.end;
    if (start < cursor || end > text.length) {
      continue;
    }
    html += escapeSearchHtml(text.slice(cursor, start));
    html += `<mark>${escapeSearchHtml(text.slice(start, end))}</mark>`;
    cursor = end;
  }
  return html + escapeSearchHtml(text.slice(cursor));
};
