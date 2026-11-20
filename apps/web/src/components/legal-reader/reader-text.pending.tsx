import type { CSSProperties } from "react";

import { FaceLabelPending } from "@stll/ui/control-face";

/**
 * The running text's type, as the readers set it from `reader.css`, with the
 * stylesheet's defaults as fallbacks: a loading reader can be drawn before
 * that stylesheet arrives, and its lines must already be the text's lines.
 */
export const READER_BODY_STYLE = {
  fontFamily: "var(--reader-body-font, serif)",
  fontSize: "var(--reader-body-size, 16px)",
  lineHeight: "var(--reader-body-line-height, 1.65)",
} as const satisfies CSSProperties;

/** The gap between paragraphs, the reader's own (`reader.css`). */
const READER_PARAGRAPH_GAP_STYLE = {
  rowGap: "var(--reader-paragraph-gap, 1em)",
} as const satisfies CSSProperties;

/** About a screen of paragraphs: their lines' widths, the last one short. */
const READER_PARAGRAPHS_PENDING = [
  { key: "a", lines: ["w-full", "w-full", "w-11/12", "w-2/5"] },
  { key: "b", lines: ["w-full", "w-full", "w-full", "w-full", "w-3/5"] },
  { key: "c", lines: ["w-full", "w-11/12", "w-1/3"] },
  { key: "d", lines: ["w-full", "w-full", "w-full", "w-4/5"] },
] as const;

/**
 * Paragraphs of a document the reader has not received yet, one bar per line
 * box at the text's own size and line height, a paragraph's gap apart. The
 * lines are `div`s: a bar is a block, and the HTML parser closes a paragraph
 * at a block, so the server's paint would no longer be the tree the client
 * hydrates. Each line is a column flex box, so the bar's line box is
 * stretched to the paper's width and a fractional bar width is a fraction of
 * the line, not of a shrink-wrapped, empty box.
 */
export const ReaderParagraphsPending = () => (
  <div
    aria-hidden="true"
    className="flex flex-col"
    style={READER_PARAGRAPH_GAP_STYLE}
  >
    {READER_PARAGRAPHS_PENDING.map((paragraph) => (
      <div key={paragraph.key}>
        {paragraph.lines.map((width, line) => (
          <div
            className="flex flex-col"
            key={`${paragraph.key}${String(line)}`}
          >
            <FaceLabelPending className={width} />
          </div>
        ))}
      </div>
    ))}
  </div>
);
