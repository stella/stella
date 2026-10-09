import type { RefObject } from "react";

import type { useReaderTextScale } from "@stll/decision-reader/use-reader-text-scale";
import type { Block } from "@stll/legal-ast/document-ast";

import { ViewerOverlayBar } from "@/components/inspector/viewer-overlay-bar";
import { ZoomControls } from "@/components/inspector/zoom-controls";

import { LegalReaderBreadcrumb } from "./legal-reader-breadcrumb";

type LegalReaderControlsProps = {
  blocks: readonly Block[];
  contentRef: RefObject<HTMLElement | null>;
  viewportRef: RefObject<HTMLElement | null>;
  textScale: ReturnType<typeof useReaderTextScale>;
};

export const LegalReaderControls = ({
  blocks,
  contentRef,
  viewportRef,
  textScale,
}: LegalReaderControlsProps) => (
  <ViewerOverlayBar className="reader-chrome start-2 h-12 min-w-0 gap-0 text-xs">
    <LegalReaderBreadcrumb
      blocks={blocks}
      contentRef={contentRef}
      viewportRef={viewportRef}
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
