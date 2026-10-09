import type { useReaderTextScale } from "@stll/decision-reader/use-reader-text-scale";
import type { Block } from "@stll/legal-ast/document-ast";

import { ViewerOverlayBar } from "@/components/inspector/viewer-overlay-bar";
import { ZoomControls } from "@/components/inspector/zoom-controls";

import { LegalReaderBreadcrumb } from "./legal-reader-breadcrumb";

export const LEGAL_READER_LAYOUT_CLASS_NAME =
  "relative [--reader-controls-inset:--spacing(2)] [--reader-controls-height:--spacing(12)] [--reader-controls-clearance:calc(var(--reader-controls-inset)+var(--reader-controls-height)+var(--reader-controls-inset))]";
export const LEGAL_READER_CONTENT_CLEARANCE_CLASS_NAME =
  "pt-(--reader-controls-clearance)";

type LegalReaderControlsProps = {
  blocks: readonly Block[];
  content: HTMLElement | null;
  viewport: HTMLElement | null;
  textScale: ReturnType<typeof useReaderTextScale>;
};

export const LegalReaderControls = ({
  blocks,
  content,
  viewport,
  textScale,
}: LegalReaderControlsProps) => (
  <ViewerOverlayBar className="reader-chrome start-2 top-(--reader-controls-inset) h-(--reader-controls-height) min-w-0 gap-0 text-xs">
    <LegalReaderBreadcrumb
      blocks={blocks}
      content={content}
      viewport={viewport}
    />
    <ZoomControls
      atMax={textScale.atMax}
      atMin={textScale.atMin}
      level={textScale.level}
      onReset={textScale.reset}
      onZoom={textScale.zoom}
    />
  </ViewerOverlayBar>
);
