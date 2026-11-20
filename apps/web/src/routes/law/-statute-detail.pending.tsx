import type { ReactNode, Ref } from "react";

import { cn } from "@stll/ui/utils";

import {
  LEGAL_READER_CONTENT_CLEARANCE_CLASS_NAME,
  LEGAL_READER_LAYOUT_CLASS_NAME,
  LegalReaderControlsPending,
  READER_PAGE_COLUMN_CLASS_NAME,
  ReaderScrollViewport,
} from "@/components/legal-reader/legal-reader-controls.pending";
import { StatuteTextPending } from "@/features/statutes/components/statute-text.pending";
import { framePendingView } from "@/routes/-pending-view.logic";

// The statute reader's frame, drawn by both phases: the page, the reader's
// positioned box (the outline, the text and the controls bar float in it)
// and the document column. The page fills it with the consolidation the
// route resolved; the pending phase with the masthead and paragraphs still
// to come, so the text lands where its placeholders stood.

/** The reader's page; find attaches its highlights to it. */
export const StatuteReaderFrame = ({
  children,
  panelRef,
}: {
  children: ReactNode;
  panelRef?: Ref<HTMLElement> | undefined;
}) => (
  <main className="relative flex min-h-0 flex-1 flex-col" ref={panelRef}>
    {children}
  </main>
);

/** The positioned box the outline, the text and the controls share. */
export const StatuteReaderLayout = ({ children }: { children: ReactNode }) => (
  <div
    className={cn(LEGAL_READER_LAYOUT_CLASS_NAME, "relative min-h-0 flex-1")}
  >
    {children}
  </div>
);

/** The column the act's wording is set in, clear of the controls bar. */
export const StatuteDocumentColumn = ({
  children,
  columnRef,
}: {
  children: ReactNode;
  columnRef?: Ref<HTMLDivElement> | undefined;
}) => (
  <div
    className={cn(
      "flex flex-col gap-4 pb-6",
      READER_PAGE_COLUMN_CLASS_NAME,
      LEGAL_READER_CONTENT_CLEARANCE_CLASS_NAME,
    )}
    data-slot="reader-document-column"
    ref={columnRef}
  >
    {children}
  </div>
);

/**
 * The statute page before its consolidation is read. The outline rail is
 * not drawn: its ticks stand at the measured positions of the act's own
 * headings, and it floats over the text, so nothing waits for it.
 */
const StatuteReaderPendingView = () => (
  <StatuteReaderFrame>
    <StatuteReaderLayout>
      {/* The chat's host around the scroll container, as on the page. */}
      <div className="relative h-full w-full">
        <ReaderScrollViewport>
          <StatuteDocumentColumn>
            <StatuteTextPending />
          </StatuteDocumentColumn>
        </ReaderScrollViewport>
      </div>
      <LegalReaderControlsPending />
    </StatuteReaderLayout>
  </StatuteReaderFrame>
);

export const StatuteReaderPending = framePendingView(StatuteReaderPendingView);
