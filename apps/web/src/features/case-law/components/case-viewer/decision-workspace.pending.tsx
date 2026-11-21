import { FaceLabelPending } from "@stll/ui/control-face";
import { cn } from "@stll/ui/utils";

import {
  LEGAL_READER_CONTENT_CLEARANCE_CLASS_NAME,
  LEGAL_READER_LAYOUT_CLASS_NAME,
  LegalReaderControlsPending,
  READER_PAGE_COLUMN_CLASS_NAME,
  ReaderScrollViewport,
} from "@/components/legal-reader/legal-reader-controls.pending";
import {
  READER_BODY_STYLE,
  ReaderParagraphsPending,
} from "@/components/legal-reader/reader-text.pending";

// The decision reader's layout, drawn by both phases: from `lg` the notes
// column at the text's inline start, then the paper the decision is set on.
// `DecisionWorkspace` builds its grid from these; the pending phase draws the
// same grid with the column empty and the paper in placeholder lines.

/** The notes column's width before the reader drags it. */
export const DECISION_NOTES_COLUMN_DEFAULT_WIDTH = 220;

/** The reader's positioned box; from `lg` its margin is the notes column. */
export const DECISION_READER_LAYOUT_CLASS_NAME = cn(
  LEGAL_READER_LAYOUT_CLASS_NAME,
  "relative min-h-0 flex-1 lg:[--reader-margin-width:var(--reader-aside-width)]",
);

/** The notes column and the paper; one column below `lg`. */
export const DECISION_READER_GRID_CLASS_NAME = "grid max-lg:!grid-cols-[1fr]";
export const DECISION_READER_GRID_TEMPLATE =
  "var(--reader-aside-width) minmax(0, 1fr)";

/** The notes column; below `lg` it is not drawn. */
export const DECISION_NOTES_COLUMN_CLASS_NAME =
  "relative flex flex-col max-lg:hidden";

/** The paper the decision is set on, clear of the controls bar. */
export const DECISION_PAPER_CLASS_NAME = cn(
  "reader-paper min-w-0 pb-8",
  READER_PAGE_COLUMN_CLASS_NAME,
  LEGAL_READER_CONTENT_CLEARANCE_CLASS_NAME,
);

/** The court and reference line the text opens with, set at its end, as
 *  `DecisionText` in `@stll/decision-reader` sets it. */
const DECISION_REFERENCE_LINE_CLASS_NAME =
  "reader-chrome text-muted-foreground mb-4 text-end text-xs italic";

/**
 * `DecisionWorkspace` before its decision is read: the controls bar, the
 * notes column at its default width (empty: what it holds is the decision's
 * analysis and the reader's notes), and the paper with the reference line
 * and paragraphs in placeholder. The outline rail is not drawn: it floats
 * over the text at the measured positions of the decision's own headings.
 */
export const DecisionWorkspacePending = () => (
  <div className="flex h-full flex-col overflow-hidden">
    <div
      className={DECISION_READER_LAYOUT_CLASS_NAME}
      style={{
        "--reader-aside-width": `${String(DECISION_NOTES_COLUMN_DEFAULT_WIDTH)}px`,
      }}
    >
      <LegalReaderControlsPending />
      <div className="h-full">
        {/* The chat's host around the scroll container, as on the page. */}
        <div className="relative h-full w-full">
          <ReaderScrollViewport>
            <div
              className={DECISION_READER_GRID_CLASS_NAME}
              style={{ gridTemplateColumns: DECISION_READER_GRID_TEMPLATE }}
            >
              <div className={DECISION_NOTES_COLUMN_CLASS_NAME} />
              <div className={DECISION_PAPER_CLASS_NAME}>
                <div aria-hidden="true" style={READER_BODY_STYLE}>
                  <div className={DECISION_REFERENCE_LINE_CLASS_NAME}>
                    <FaceLabelPending className="w-48" />
                  </div>
                  <ReaderParagraphsPending />
                </div>
              </div>
            </div>
          </ReaderScrollViewport>
        </div>
      </div>
    </div>
  </div>
);
