/**
 * Extract citation context from decision sections.
 *
 * Pure function — no database or external dependencies.
 */

/** How much of the section is read either side of a mention. */
const WINDOW_CHARS = 200;

/**
 * Windows of a citing decision's text, ordered as the section reads.
 *
 * Windows come back composed. Their readers (the kind cues and the polarity
 * rules) match words against them, and both are written with precomposed
 * letters, so a publisher that serves "á" decomposed (U+0061 U+0301) would
 * silently match none of them: a combining mark is neither the letter nor
 * `\p{L}`. Nothing indexes into a window, so composing it costs no offset; the
 * citation is located in the section's own characters first.
 */
export type CitationContexts = readonly [string, ...string[]];

/**
 * The two readings of one citation's surroundings.
 *
 * Every mention is covered, not the first one. A court that departs from a
 * decision usually names it more than once: in a party's argument, in a
 * recital of the line it belongs to, and only then in the sentence that
 * rejects it. Reading the first window alone read the recital and missed the
 * rejection, which is how a velký senát judgment came to be filed as
 * approving the case it overruled.
 */
export type CitationWindows = {
  /**
   * One window per occurrence of the citation, never merged. The rule tier
   * reads each on its own and `aggregateMentionPolarities` collapses the
   * readings (see `selectCitationPolarity`), so two mentions a paragraph
   * apart can disagree and be stored `mixed`. Merging them first hid exactly
   * that: a recital and a rejection within ~400 characters of each other
   * became one window, one match, and the severer of the two cues.
   *
   * Two mentions closer than one window still share their cues, which is the
   * same reading a single mention gets: at that distance the cues are one
   * stretch of reasoning, not two stances.
   */
  mentions: CitationContexts;
  /**
   * The same windows with overlaps merged: what the model tiers are shown.
   * Merged because an excerpt that printed the same sentence once per
   * mention would spend its budget repeating itself.
   */
  contexts: CitationContexts;
};

type Span = { start: number; end: number };

export const extractContexts = (
  sections: { text: string }[],
  citationText: string,
  sectionIndex: number | null,
): CitationWindows | null => {
  const section = sectionIndex !== null ? sections[sectionIndex] : undefined;
  const text = section?.text ?? sections.map((s) => s.text).join("\n");

  const spans: Span[] = [];
  for (
    let idx = text.indexOf(citationText);
    idx !== -1;
    idx = text.indexOf(citationText, idx + citationText.length)
  ) {
    spans.push({
      start: Math.max(0, idx - WINDOW_CHARS),
      end: Math.min(text.length, idx + citationText.length + WINDOW_CHARS),
    });
  }

  const [first, ...rest] = spans;
  if (!first) {
    return null;
  }

  // The merged run, grown in place: a span that reaches into the one before
  // it extends it rather than opening a new window.
  const mergedFirst = { ...first };
  const mergedRest: Span[] = [];
  for (const span of rest) {
    const last = mergedRest.at(-1) ?? mergedFirst;
    if (span.start <= last.end) {
      last.end = span.end;
    } else {
      mergedRest.push({ ...span });
    }
  }

  const window = ({ start, end }: Span) =>
    text.slice(start, end).normalize("NFC");
  return {
    mentions: [window(first), ...rest.map(window)],
    contexts: [window(mergedFirst), ...mergedRest.map(window)],
  };
};
