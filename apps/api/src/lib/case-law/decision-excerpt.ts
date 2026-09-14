import { SEARCH_EXCERPTS, type SearchExcerpt } from "@stll/api-contract/search";

import { highlightCorpusPassage } from "@/api/lib/legal-search/corpus-passage-highlight";
import type { CorpusQueryToken } from "@/api/lib/legal-search/corpus-query";
import type { MorphologyLanguage } from "@/api/lib/legal-search/morphology/stem";
import { HIGHLIGHT_START, HIGHLIGHT_STOP } from "@/api/lib/search/highlight";

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
 * The engine's snippet is the fallback rather than an empty cell whenever the
 * wider cut cannot be made — a hit carrying no passage, or a passage the
 * query's words cannot be located in. A reader who asked for more text is
 * still answered with the text there was.
 */
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

  const { html } = highlightCorpusPassage({
    passage,
    tokens,
    language,
    maxChars: decisionExcerptWindow(excerpt).maxChars,
  });

  return html.length === 0 ? engineSnippet : html;
};
