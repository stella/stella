/**
 * Extract citation context from decision sections.
 *
 * Pure function — no database or external dependencies.
 */

/** How much of the section is read either side of a mention. */
const WINDOW_CHARS = 200;

/**
 * The windows a citation's mentions sit in: one per mention, ordered as the
 * section reads, with windows that overlap merged into one.
 *
 * Every mention is returned, not the first one. A court that departs from a
 * decision usually names it more than once: in a party's argument, in a
 * recital of the line it belongs to, and only then in the sentence that
 * rejects it. Reading the first window alone read the recital and missed the
 * rejection, which is how a velký senát judgment came to be filed as
 * approving the case it overruled. The rule tier reads all of them and the
 * most severe reading wins (see `selectRuleMatch`).
 *
 * Windows come back composed. Their readers (the kind cues and the polarity
 * rules) match words against them, and both are written with precomposed
 * letters, so a publisher that serves "á" decomposed (U+0061 U+0301) would
 * silently match none of them: a combining mark is neither the letter nor
 * `\p{L}`. Nothing indexes into a window, so composing it costs no offset; the
 * citation is located in the section's own characters first.
 */
export type CitationContexts = readonly [string, ...string[]];

export const extractContexts = (
  sections: { text: string }[],
  citationText: string,
  sectionIndex: number | null,
): CitationContexts | null => {
  const section = sectionIndex !== null ? sections[sectionIndex] : undefined;
  const text = section?.text ?? sections.map((s) => s.text).join("\n");

  const spans: { start: number; end: number }[] = [];
  for (
    let idx = text.indexOf(citationText);
    idx !== -1;
    idx = text.indexOf(citationText, idx + citationText.length)
  ) {
    const start = Math.max(0, idx - WINDOW_CHARS);
    const end = Math.min(text.length, idx + citationText.length + WINDOW_CHARS);
    const last = spans.at(-1);
    if (last && start <= last.end) {
      last.end = end;
    } else {
      spans.push({ start, end });
    }
  }

  const [first, ...rest] = spans;
  if (!first) {
    return null;
  }
  const window = ({ start, end }: { start: number; end: number }) =>
    text.slice(start, end).normalize("NFC");
  return [window(first), ...rest.map(window)];
};
