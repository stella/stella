/**
 * How corpus text is cut into terms, mirroring the engine's `simple`
 * tokenizer, which the `folded` tokenizer is built on: a run of letters or
 * digits is a token and everything else is a separator.
 *
 * One owner, because two sides depend on the answer being the same one. The
 * query builder splits the reader's text this way before quoting it, and the
 * projection splits a passage this way before stemming it; a stem stream cut
 * on a different rule would line up with a different set of positions than
 * the surface stream it stands in for, and a phrase would match the wrong
 * words or none.
 *
 * Text is normalised to NFC first, and that is not cosmetic: a combining mark
 * is `\p{M}`, not `\p{L}`, so decomposed text breaks a word apart at every
 * accent — "nájemního" in NFD becomes three tokens, each of which stems to
 * itself and matches nothing. Extracted text arrives in whatever form its
 * producer used, and NFD is common from PDFs and from macOS, so both the
 * corpus and a pasted query can carry it.
 *
 * Everything the engine could read as query syntax is dropped rather than
 * escaped, which is the property the query builder relies on for safety.
 */
const CORPUS_TOKEN_PATTERN = /[\p{L}\p{N}]+/gu;

/**
 * The form the offsets below are measured in. A caller that slices text by
 * those offsets normalises it with this first.
 */
export const normalizeCorpusText = (text: string): string =>
  text.normalize("NFC");

/** One token and where it sits in {@link normalizeCorpusText} of the input. */
export type CorpusTokenSpan = {
  value: string;
  /** Inclusive start offset. */
  start: number;
  /** Exclusive end offset. */
  end: number;
};

/**
 * Tokens with their offsets. The offsets are into the NFC form, not into the
 * caller's string: normalisation can change length, so an offset taken here
 * only addresses text that was normalised the same way.
 */
export const corpusTokenSpans = (text: string): CorpusTokenSpan[] => {
  const spans: CorpusTokenSpan[] = [];
  // `matchAll` over `match`: text with no token is an empty iteration rather
  // than a null needing a fallback, so there is one code path and no second
  // spelling of "no tokens". It also iterates its own regex clone, which is
  // what makes a shared pattern object safe to reuse here.
  for (const match of normalizeCorpusText(text).matchAll(
    CORPUS_TOKEN_PATTERN,
  )) {
    spans.push({
      value: match[0],
      start: match.index,
      end: match.index + match[0].length,
    });
  }
  return spans;
};

/** Derived from the spans, so there is one scan of the rule, not two. */
export const corpusTokens = (text: string): string[] =>
  corpusTokenSpans(text).map(({ value }) => value);
