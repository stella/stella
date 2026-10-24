import type { Block } from "@stll/legal-ast/document-ast";

import { FloatingZoomControls } from "@/components/inspector/zoom-controls";

import { LegalReaderBreadcrumb } from "./legal-reader-breadcrumb";
import type { ReaderBreadcrumbModel } from "./reader-breadcrumb-paths";
import type { useWebReaderTextScale } from "./use-web-reader-text-scale";

export const LEGAL_READER_LAYOUT_CLASS_NAME =
  "relative [--reader-controls-inset:--spacing(2)] [--reader-controls-height:--spacing(12)] [--reader-controls-clearance:calc(var(--reader-controls-inset)+var(--reader-controls-height)+var(--reader-controls-inset))]";
export const LEGAL_READER_CONTENT_CLEARANCE_CLASS_NAME =
  "pt-(--reader-controls-clearance)";

type LegalReaderControlsProps = {
  blocks: readonly Block[];
  content: HTMLElement | null;
  fallbackBreadcrumb?: ReaderBreadcrumbModel | undefined;
  viewport: HTMLElement | null;
  textScale: ReturnType<typeof useWebReaderTextScale>;
};

export const LegalReaderControls = ({
  blocks,
  content,
  fallbackBreadcrumb,
  viewport,
  textScale,
}: LegalReaderControlsProps) => (
  <FloatingZoomControls
    atMax={textScale.atMax}
    atMin={textScale.atMin}
    className="reader-chrome start-2 top-(--reader-controls-inset) h-(--reader-controls-height) min-w-0 gap-0 text-xs"
    level={textScale.level}
    onReset={textScale.reset}
    onZoom={textScale.zoom}
  >
    <LegalReaderBreadcrumb
      blocks={blocks}
      content={content}
      fallback={fallbackBreadcrumb}
      viewport={viewport}
    />
  </FloatingZoomControls>
);
