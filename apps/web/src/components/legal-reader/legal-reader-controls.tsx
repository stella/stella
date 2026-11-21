import type { Block } from "@stll/legal-ast/document-ast";

import { FloatingZoomControls } from "@/components/inspector/zoom-controls";

import { LegalReaderBreadcrumb } from "./legal-reader-breadcrumb";
import { LEGAL_READER_CONTROLS_BAR_CLASS_NAME } from "./legal-reader-controls.pending";
import type { ReaderAnalysisOutline } from "./reader-contents.logic";
import type { useWebReaderTextScale } from "./use-web-reader-text-scale";

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
    className={LEGAL_READER_CONTROLS_BAR_CLASS_NAME}
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
