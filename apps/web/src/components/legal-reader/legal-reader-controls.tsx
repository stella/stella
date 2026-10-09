import type { useReaderTextScale } from "@stll/decision-reader/use-reader-text-scale";
import type { Block } from "@stll/legal-ast/document-ast";

import { ViewerOverlayBar } from "@/components/inspector/viewer-overlay-bar";
import { ZoomControls } from "@/components/inspector/zoom-controls";

import { LegalReaderBreadcrumb } from "./legal-reader-breadcrumb";

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
  <ViewerOverlayBar className="reader-chrome start-2 h-12 min-w-0 gap-0 text-xs">
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
