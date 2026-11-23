import { useRef, useState } from "react";
import type { CSSProperties, PointerEvent } from "react";

import { manualRedactionCatalog } from "@/components/pdf/manual-redaction/manual-redaction-catalog";
import { useManualRedactionStore } from "@/components/pdf/manual-redaction/manual-redaction-store";
import { useExternalSyncEffect } from "@/hooks/use-effect";
import {
  isManualRedactionPageRectUnchanged,
  manualRedactionFromDrag,
  pdfDocumentKey,
} from "@/lib/pdf/manual-redaction.logic";
import type {
  ManualRedactionArea,
  ManualRedactionPageRect,
  ManualRedactionRegion,
} from "@/lib/pdf/manual-redaction.logic";
import { usePDFStore } from "@/lib/pdf/pdf-context";
import { createUuid } from "@/lib/uuid";

const NO_AREAS: readonly ManualRedactionArea[] = [];

type ManualRedactionPageLayerProps = {
  fieldId: string;
  pageId: string;
};

/**
 * The areas marked on one reader page, and, while marking, the surface that
 * turns a drag into a new area. Only a document's own pages take areas: the
 * anonymized download rebuilds those pages, not a portfolio's attachments.
 */
export const ManualRedactionPageLayer = (
  props: ManualRedactionPageLayerProps,
) => (
  <manualRedactionCatalog.Provider fallback={null}>
    <DocumentPageLayer {...props} />
  </manualRedactionCatalog.Provider>
);

const DocumentPageLayer = ({
  fieldId,
  pageId,
}: ManualRedactionPageLayerProps) => {
  const page = usePDFStore((s) => s.pages.get(pageId));
  const pdfDocument = usePDFStore((s) => s.document);
  const documentKey =
    pdfDocument === null
      ? undefined
      : pdfDocumentKey(pdfDocument.document.fingerprints);
  // A portfolio binds the field too, under its own key, so the areas of the
  // document the field showed before are dropped as for any other document.
  const boundKey =
    documentKey === undefined || pdfDocument?.pageSource === "document"
      ? documentKey
      : `portfolio:${documentKey}`;
  const bindDocument = useManualRedactionStore((s) => s.bindDocument);
  useExternalSyncEffect(() => {
    if (boundKey !== undefined) {
      bindDocument(fieldId, boundKey);
    }
  }, [bindDocument, boundKey, fieldId]);
  if (
    !page ||
    documentKey === undefined ||
    pdfDocument?.pageSource !== "document"
  ) {
    return null;
  }
  return (
    <BoundPageLayer
      documentKey={documentKey}
      fieldId={fieldId}
      pageHeight={page.originalHeight}
      pageIndex={page.proxy.pageNumber - 1}
      pageWidth={page.originalWidth}
    />
  );
};

type BoundPageLayerProps = {
  documentKey: string;
  fieldId: string;
  pageIndex: number;
  pageWidth: number;
  pageHeight: number;
};

const regionStyle = (region: ManualRedactionRegion): CSSProperties => ({
  insetInlineStart: `${region.left * 100}%`,
  insetBlockStart: `${region.top * 100}%`,
  width: `${(region.right - region.left) * 100}%`,
  height: `${(region.bottom - region.top) * 100}%`,
});

const BoundPageLayer = ({
  documentKey,
  fieldId,
  pageIndex,
  pageWidth,
  pageHeight,
}: BoundPageLayerProps) => {
  const field = useManualRedactionStore((s) => s.byFieldId[fieldId]);
  const bound = field?.documentKey === documentKey ? field : undefined;
  const areas = (bound?.areas ?? NO_AREAS).filter(
    (area) => area.pageIndex === pageIndex,
  );

  if (bound?.mode === "drawing") {
    return (
      <MarkingSurface
        areas={areas}
        documentKey={documentKey}
        fieldId={fieldId}
        pageHeight={pageHeight}
        pageIndex={pageIndex}
        pageWidth={pageWidth}
      />
    );
  }
  if (areas.length === 0) {
    return null;
  }
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 z-20"
      dir="ltr"
    >
      <AreaFills areas={areas} />
    </div>
  );
};

/** Areas are removed from the facet's list, so the page only paints them. */
const AreaFills = ({ areas }: { areas: readonly ManualRedactionArea[] }) =>
  areas.map((area) => (
    <div
      aria-hidden="true"
      // Black is document output here, not application chrome.
      className="pointer-events-none absolute bg-(--pdf-redaction-fill)"
      data-manual-redaction-area={area.id}
      key={area.id}
      style={regionStyle(area)}
    />
  ));

type Drag = {
  pointerId: number;
  pageRect: ManualRedactionPageRect;
  start: { x: number; y: number };
};

type MarkingSurfaceProps = BoundPageLayerProps & {
  areas: readonly ManualRedactionArea[];
};

const MarkingSurface = ({
  areas,
  documentKey,
  fieldId,
  pageIndex,
  pageWidth,
  pageHeight,
}: MarkingSurfaceProps) => {
  const t = manualRedactionCatalog.useTranslations();
  const dispatch = useManualRedactionStore((s) => s.dispatch);
  const dragRef = useRef<Drag | null>(null);
  const [preview, setPreview] = useState<ManualRedactionRegion | null>(null);

  const endDrag = (event: PointerEvent<HTMLDivElement>) => {
    dragRef.current = null;
    setPreview(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const cancelDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId === event.pointerId) {
      endDrag(event);
    }
  };

  const dragRegion = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (drag === null || drag.pointerId !== event.pointerId) {
      return null;
    }
    // Never commit against a different layout from the one the drag began on.
    if (
      !isManualRedactionPageRectUnchanged(
        drag.pageRect,
        event.currentTarget.getBoundingClientRect(),
      )
    ) {
      endDrag(event);
      return null;
    }
    return manualRedactionFromDrag({
      pageIndex,
      pageRect: drag.pageRect,
      start: drag.start,
      end: { x: event.clientX, y: event.clientY },
    });
  };

  return (
    <div
      aria-label={t("manualRedaction.markingSurface")}
      className="absolute inset-0 z-20 cursor-crosshair touch-none select-none"
      data-testid="manual-redaction-surface"
      dir="ltr"
      onLostPointerCapture={cancelDrag}
      onPointerCancel={cancelDrag}
      onPointerDown={(event) => {
        if (
          !event.isPrimary ||
          event.button !== 0 ||
          dragRef.current !== null
        ) {
          return;
        }
        const bounds = event.currentTarget.getBoundingClientRect();
        if (bounds.width <= 0 || bounds.height <= 0) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        event.currentTarget.setPointerCapture(event.pointerId);
        dragRef.current = {
          pointerId: event.pointerId,
          pageRect: {
            left: bounds.left,
            top: bounds.top,
            width: bounds.width,
            height: bounds.height,
          },
          start: { x: event.clientX, y: event.clientY },
        };
      }}
      onPointerMove={(event) => {
        if (dragRef.current?.pointerId !== event.pointerId) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        setPreview(dragRegion(event));
      }}
      onPointerUp={(event) => {
        if (dragRef.current?.pointerId !== event.pointerId) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        const region = dragRegion(event);
        endDrag(event);
        if (region === null) {
          return;
        }
        dispatch({
          fieldId,
          documentKey,
          action: {
            type: "add",
            area: { ...region, id: createUuid(), pageWidth, pageHeight },
          },
        });
      }}
      role="group"
    >
      <AreaFills areas={areas} />
      {preview !== null && (
        <div
          aria-hidden="true"
          className="outline-ring pointer-events-none absolute bg-(--pdf-redaction-fill) opacity-60 outline-1"
          data-testid="manual-redaction-preview"
          style={regionStyle(preview)}
        />
      )}
    </div>
  );
};
