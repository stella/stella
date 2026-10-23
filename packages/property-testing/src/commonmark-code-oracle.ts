/**
 * An independent reading of the two CommonMark code constructs the GitHub
 * outbound owner relies on, written from the spec rather than from the owner:
 * fenced code blocks (spec 4.5) and code spans (spec 6.1). Tests use it to
 * check that text sent to GitHub sits inside code the way GitHub will parse it.
 */

const LINE_BREAK = /\r\n|\r|\n/u;
const OPENING_FENCE = /^ {0,3}(`{3,})[^`]*$/u;

export const markdownLines = (markdown: string): string[] =>
  markdown.split(LINE_BREAK);

export type FencedBlockReading = {
  /** The block's text, lines joined with `\n`. */
  content: string;
  /** Index of the closing fence line; undefined when the document ends first. */
  closeIndex: number | undefined;
};

/** Reads the fenced block opening on `lines[openIndex]`, or undefined. */
export const readFencedBlockAt = (
  lines: readonly string[],
  openIndex: number,
): FencedBlockReading | undefined => {
  const opening = OPENING_FENCE.exec(lines[openIndex] ?? "");
  const fence = opening?.[1];
  if (fence === undefined) {
    return undefined;
  }
  const closing = new RegExp(`^ {0,3}\`{${fence.length},}[ \\t]*$`, "u");
  const closeOffset = lines
    .slice(openIndex + 1)
    .findIndex((line) => closing.test(line));
  const closeIndex =
    closeOffset === -1 ? undefined : openIndex + 1 + closeOffset;
  return {
    content: lines.slice(openIndex + 1, closeIndex ?? lines.length).join("\n"),
    closeIndex,
  };
};

/** A document that should be exactly one fenced block. */
export const readFencedBlock = (
  markdown: string,
): { content: string; closedOnLastLine: boolean } => {
  const lines = markdownLines(markdown);
  const block = readFencedBlockAt(lines, 0);
  return {
    content: block?.content ?? "",
    closedOnLastLine: block?.closeIndex === lines.length - 1,
  };
};

const BACKTICK_RUN = /`+/gu;

const spanContent = (raw: string): string => {
  const folded = raw.replaceAll(/\r\n|\r|\n/gu, " ");
  return folded.startsWith(" ") && folded.endsWith(" ") && !/^ *$/u.test(folded)
    ? folded.slice(1, -1)
    : folded;
};

export type InlineReading = {
  /** Contents of every code span, in order. */
  spans: string[];
  /** The text outside code spans, as GitHub would scan it. */
  outside: string;
};

/** Splits one inline run of text into code spans and the text around them. */
export const readCodeSpans = (text: string): InlineReading => {
  const runs = Array.from(text.matchAll(BACKTICK_RUN), (match) => ({
    start: match.index,
    length: match[0].length,
  }));
  const spans: string[] = [];
  let outside = "";
  let cursor = 0;
  let runIndex = 0;
  while (runIndex < runs.length) {
    const opener = runs[runIndex];
    if (opener === undefined) {
      break;
    }
    const closerOffset = runs
      .slice(runIndex + 1)
      .findIndex((run) => run.length === opener.length);
    if (closerOffset === -1) {
      runIndex += 1;
      continue;
    }
    const closerIndex = runIndex + 1 + closerOffset;
    const closer = runs[closerIndex];
    if (closer === undefined) {
      break;
    }
    outside += text.slice(cursor, opener.start);
    spans.push(
      spanContent(text.slice(opener.start + opener.length, closer.start)),
    );
    cursor = closer.start + closer.length;
    runIndex = closerIndex + 1;
  }
  return { spans, outside: outside + text.slice(cursor) };
};

/** A string that should be exactly one code span. */
export const readCodeSpan = (
  text: string,
): { content: string; endsAtEnd: boolean } => {
  const reading = readCodeSpans(text);
  return {
    content: reading.spans[0] ?? "",
    endsAtEnd:
      reading.spans.length === 1 &&
      reading.outside === "" &&
      text.startsWith("`"),
  };
};
