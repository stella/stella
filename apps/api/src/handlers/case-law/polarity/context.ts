import { normalizeUnicode } from "@stll/text-normalize";

import type { CitationEvidenceWindows } from "@/api/lib/case-law/citation-evidence";

/**
 * Extract citation context from decision sections.
 *
 * Pure function — no database or external dependencies.
 */

/** How much of the section is read either side of a mention. */
const WINDOW_CHARS = 200;

/**
 * How far past `WINDOW_CHARS` a mention may read to finish its sentence. A
 * Czech court often answers a citation at the end of the sentence that names
 * it ("Namítá-li žalobce s poukazem na rozsudek ..., potom pomíjí, že soud ve
 * zmiňované věci řešil ..."), well past a cut at a fixed width. Bounded, so a
 * text without sentence punctuation cannot read an unbounded run.
 */
const SENTENCE_TAIL_CHARS = 400;

/**
 * A sentence break after the window: a terminator before a capitalised word
 * or the end of the text, or a line break. The lookbehind keeps abbreviations
 * of one or two letters from ending the sentence ("sp. zn.", "č. j.", "II.").
 */
const SENTENCE_BREAK = /(?<![\s(]\p{L}{1,2})[.!?](?=\s+\p{Lu}|\s*$)|\n/u;

/**
 * Windows of a citing decision's text, ordered as the section reads.
 *
 * Windows come back composed. Their readers (the kind cues and the polarity
 * rules) match words against them, and both are written with precomposed
 * letters, so a publisher that serves "á" decomposed (U+0061 U+0301) would
 * silently match none of them: a combining mark is neither the letter nor
 * `\p{L}`. Nothing indexes into a window, so composing it costs no offset; the
 * citation is located in the section's own characters first. Evidence offsets
 * remain in the original text, before normalization.
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
   *
   * Each window reads on to the end of its sentence (`SENTENCE_TAIL_CHARS`),
   * so a cue stating the court's answer at the end of a long sentence is read.
   */
  mentions: CitationContexts;
  /**
   * The fixed-width windows with overlaps merged: what the model tiers are
   * shown and what citation kind is read from. Merged because an excerpt that
   * printed the same sentence once per mention would spend its budget
   * repeating itself; not read on to the sentence end, so widening what the
   * rule tier reads cannot shift a stored kind.
   */
  contexts: CitationContexts;
  /** Exact offsets for each mention in the original joined section text. */
  evidenceWindows: CitationEvidenceWindows;
  /** Exact offsets for each merged model context in the original text. */
  contextEvidenceWindows: CitationEvidenceWindows;
};
type Span = { start: number; end: number };

/**
 * A window cut mid-sentence, read on to the sentence end when one is within
 * reach; a window already ending on a sentence end stays as it is.
 */
const toSentenceEnd = (text: string, { start, end }: Span): Span => {
  if (/[.!?]\s*$/u.test(text.slice(Math.max(start, end - 2), end))) {
    return { start, end };
  }
  const tail = text.slice(end, end + SENTENCE_TAIL_CHARS);
  const breakAt = tail.search(SENTENCE_BREAK);
  if (breakAt === -1) {
    return { start, end };
  }
  return { start, end: end + breakAt + (tail[breakAt] === "\n" ? 0 : 1) };
};

export const extractContexts = (
  sections: { text: string }[],
  citationText: string,
  sectionIndex: number | null,
): CitationWindows | null => {
  const section = sectionIndex !== null ? sections[sectionIndex] : undefined;
  const text = section?.text ?? sections.map((s) => s.text).join("\n");
  const sectionOffset =
    section && sectionIndex !== null
      ? sections
          .slice(0, sectionIndex)
          .reduce((offset, s) => offset + s.text.length + 1, 0)
      : 0;

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
    normalizeUnicode(text.slice(start, end), "NFC");
  // Each mention's evidence window covers the same sentence-extended span
  // its mention text reads.
  const firstMention = toSentenceEnd(text, first);
  const restMentions = rest.map((span) => toSentenceEnd(text, span));
  return {
    mentions: [window(firstMention), ...restMentions.map(window)],
    contexts: [window(mergedFirst), ...mergedRest.map(window)],
    evidenceWindows: [
      {
        start: sectionOffset + firstMention.start,
        end: sectionOffset + firstMention.end,
      },
      ...restMentions.map(({ start, end }) => ({
        start: sectionOffset + start,
        end: sectionOffset + end,
      })),
    ],
    contextEvidenceWindows: [
      {
        start: sectionOffset + mergedFirst.start,
        end: sectionOffset + mergedFirst.end,
      },
      ...mergedRest.map(({ start, end }) => ({
        start: sectionOffset + start,
        end: sectionOffset + end,
      })),
    ],
  };
};
