/**
 * Turn the bold / bold-italic markdown the chat model sometimes emits inside
 * inserted or replaced block text ("**Date:**", "***Term***") into structured
 * runs the editor renders as real Word formatting.
 *
 * The active-docx-edit tool gives the model no inline run-formatting channel —
 * only paragraph-level `styleId`. When the model wants a bold label or party
 * name mid-sentence it improvises with markdown, and because DOCX has no notion
 * of markdown those markers otherwise reach the document as literal asterisks.
 *
 * Deliberately conservative: only paired double (`**`, `__`) and triple
 * (`***`, `___`) markers with non-space inner content count as emphasis. A lone
 * `*` or `_` stays literal — in legal prose it is far more likely a
 * multiplication sign or an identifier than an italic delimiter. Nesting is not
 * interpreted; inner content is taken verbatim. Backslashes are ordinary
 * characters (no markdown escapes), so Windows paths and regex survive intact.
 */

export type InlineEmphasisRun = {
  text: string;
  bold: boolean;
  italic: boolean;
};

const MARKERS: readonly { marker: string; bold: boolean; italic: boolean }[] = [
  { marker: "***", bold: true, italic: true },
  { marker: "___", bold: true, italic: true },
  { marker: "**", bold: true, italic: false },
  { marker: "__", bold: true, italic: false },
];

const isSpace = (ch: string | undefined): boolean =>
  ch === undefined || ch === " " || ch === "\t" || ch === "\n";

const matchMarkerAt = (
  input: string,
  at: number,
): (typeof MARKERS)[number] | undefined =>
  MARKERS.find((m) => input.startsWith(m.marker, at));

const appendLiteral = (runs: InlineEmphasisRun[], text: string): void => {
  if (text.length === 0) {
    return;
  }
  const last = runs.at(-1);
  if (last && !last.bold && !last.italic) {
    last.text += text;
    return;
  }
  runs.push({ text, bold: false, italic: false });
};

export const parseInlineEmphasisRuns = (input: string): InlineEmphasisRun[] => {
  const runs: InlineEmphasisRun[] = [];
  let buffer = "";
  let i = 0;

  const flushBuffer = () => {
    appendLiteral(runs, buffer);
    buffer = "";
  };

  while (i < input.length) {
    const ch = input[i];
    const matched = matchMarkerAt(input, i);
    if (!matched) {
      buffer += ch;
      i += 1;
      continue;
    }

    const contentStart = i + matched.marker.length;
    const closeIdx = input.indexOf(matched.marker, contentStart);
    const content = closeIdx === -1 ? "" : input.slice(contentStart, closeIdx);
    const isSpan =
      closeIdx !== -1 &&
      content.length > 0 &&
      !isSpace(content[0]) &&
      !isSpace(content.at(-1));

    if (!isSpan) {
      // Not a real span (no close, or space-flanked): emit the marker's first
      // char as literal and retry from the next position so a `**` inside a
      // dangling `***` can still pair as bold.
      buffer += ch;
      i += 1;
      continue;
    }

    flushBuffer();
    runs.push({ text: content, bold: matched.bold, italic: matched.italic });
    i = closeIdx + matched.marker.length;
  }

  flushBuffer();
  return runs;
};

const hasEmphasis = (runs: readonly InlineEmphasisRun[]): boolean =>
  runs.some((run) => run.bold || run.italic);

/** True when `input` contains at least one bold / italic span worth promoting
 *  to real marks; lets callers skip the run rebuild for plain text. */
export const hasInlineEmphasis = (input: string): boolean =>
  hasEmphasis(parseInlineEmphasisRuns(input));

/**
 * Drop emphasis markers without reconstructing formatting. Used on the
 * tracked-changes replace path, where the word-diff redline cannot carry inline
 * marks; stripping at least keeps literal `**` out of the document. Returns the
 * input verbatim when no real span is present, so plain prose (and stray
 * single `*` / escaped `\*`) is never reshaped.
 */
export const stripInlineEmphasisMarkers = (input: string): string => {
  const runs = parseInlineEmphasisRuns(input);
  if (!hasEmphasis(runs)) {
    return input;
  }
  return runs.map((run) => run.text).join("");
};
