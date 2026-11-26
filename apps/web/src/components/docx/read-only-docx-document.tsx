import { lazy, useLayoutEffect, useRef } from "react";

import type { DocxEditorRef } from "@stll/folio-react";
import { useComposedRefs } from "@stll/ui/effects/refs";
import "@stll/folio-react/editor.css";

import {
  useDocxFitZoom,
  useDocxWheelZoom,
} from "@/components/docx-preview-zoom";

const ReadOnlyDocxViewer = lazy(async () => {
  const m = await import("@/components/docx/app-docx-editor");
  return { default: m.DocxEditor };
});

/**
 * A Word document drawn read-only from its bytes, fitted to its container
 * and zoomed by `scaleOffset` and the wheel. A stored document opened full
 * screen and a document inside a file (an attachment, a container's member)
 * both draw through it. Mount it under a Suspense boundary: the editor's
 * chunk loads on first use.
 */
export const ReadOnlyDocxDocument = ({
  documentBuffer,
  fileName,
  scaleOffset,
}: {
  documentBuffer: ArrayBuffer;
  fileName: string;
  scaleOffset: number;
}) => {
  const editorRef = useRef<DocxEditorRef>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const { containerRef: fitZoomRef, fitZoom: targetZoom } = useDocxFitZoom({
    fit: { type: "editor" },
    scaleOffset,
  });
  // A stable ref callback, so React does not detach and re-attach the
  // fit-zoom observer every render.
  const composedContainerRef = useComposedRefs(containerRef, fitZoomRef);

  useLayoutEffect(() => {
    editorRef.current?.setZoom(targetZoom);
  }, [targetZoom]);
  useDocxWheelZoom(containerRef, editorRef);

  return (
    <div ref={composedContainerRef} className="h-full overflow-auto">
      <ReadOnlyDocxViewer
        ref={editorRef}
        accessibleName={fileName}
        className="folio-docx-preview h-full"
        autoOpenReviewSidebar={false}
        documentBuffer={documentBuffer}
        initialZoom={targetZoom}
        mode="viewing"
        preserveDocumentWhileLoading
        readOnly
        showToolbar={false}
        showZoomControl={false}
      />
    </div>
  );
};
