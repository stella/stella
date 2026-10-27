import type { Block } from "@stll/legal-ast/document-ast";

import { FloatingZoomControls } from "@/components/inspector/zoom-controls";

import { LegalReaderBreadcrumb } from "./legal-reader-breadcrumb";
import type { ReaderAnalysisOutline } from "./reader-contents.logic";
import type { useWebReaderTextScale } from "./use-web-reader-text-scale";

/**
 * `--reader-margin-width` is the width of a notes column the reader draws at
 * the layout's inline start, zero where it draws none. The controls bar
 * starts past it: the bar belongs to the text, and its glass must not cover
 * the notes beside it.
 */
export const LEGAL_READER_LAYOUT_CLASS_NAME =
  "relative [--reader-margin-width:0px] [--reader-controls-inset:--spacing(2)] [--reader-controls-height:--spacing(12)] [--reader-controls-clearance:calc(var(--reader-controls-inset)+var(--reader-controls-height)+var(--reader-controls-inset))]";
export const LEGAL_READER_CONTENT_CLEARANCE_CLASS_NAME =
  "pt-(--reader-controls-clearance)";

type LegalReaderControlsProps = {
  blocks: readonly Block[];
  content: HTMLElement | null;
  analysis?: ReaderAnalysisOutline | undefined;
  viewport: HTMLElement | null;
  textScale: ReturnType<typeof useWebReaderTextScale>;
};

export const LegalReaderControls = ({
  blocks,
  content,
  analysis,
  viewport,
  textScale,
}: LegalReaderControlsProps) => (
  <FloatingZoomControls
    atMax={textScale.atMax}
    atMin={textScale.atMin}
    className="reader-chrome start-[calc(var(--reader-margin-width)+var(--reader-controls-inset))] top-(--reader-controls-inset) h-(--reader-controls-height) min-w-0 gap-0 text-xs"
    level={textScale.level}
    onReset={textScale.reset}
    onZoom={textScale.zoom}
  >
    <LegalReaderBreadcrumb
      blocks={blocks}
      analysis={analysis}
      content={content}
      viewport={viewport}
    />
  </FloatingZoomControls>
);
