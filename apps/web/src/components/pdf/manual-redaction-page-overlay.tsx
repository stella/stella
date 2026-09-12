import { useRef, useState } from "react";
import type { CSSProperties, PointerEvent } from "react";

import { useTranslations } from "use-intl";

import { cn } from "@stll/ui/utils";

import {
  isManualRedactionPageRectUnchanged,
  manualRedactionFromDrag,
} from "./manual-redaction.logic";
import type {
  ManualRedactionPageRect,
  ManualRedactionRegion,
  ManualRedactionSelection,
} from "./manual-redaction.logic";

type ManualRedactionPageOverlayProps = {
  pageIndex: number;
  selections: readonly ManualRedactionSelection[];
  onAdd: (region: ManualRedactionRegion) => void;
  onRemove: (id: string) => void;
  disabled: boolean;
};

type Drag = {
  pointerId: number;
  pageRect: ManualRedactionPageRect;
  start: { x: number; y: number };
};

const regionStyle = (region: ManualRedactionRegion): CSSProperties => ({
  insetInlineStart: `${region.left * 100}%`,
  insetBlockStart: `${region.top * 100}%`,
  width: `${(region.right - region.left) * 100}%`,
  height: `${(region.bottom - region.top) * 100}%`,
});

export const ManualRedactionPageOverlay = (
  props: ManualRedactionPageOverlayProps,
) => (
  <ManualRedactionGestureSurface
    {...props}
    key={`${props.pageIndex}:${props.disabled}`}
  />
);

const ManualRedactionGestureSurface = ({
  pageIndex,
  selections,
  onAdd,
  onRemove,
  disabled,
}: ManualRedactionPageOverlayProps) => {
  const t = useTranslations("inspector.anonymization");
  const dragRef = useRef<Drag | null>(null);
  const [preview, setPreview] = useState<ManualRedactionRegion | null>(null);

  const cancelDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) {
      return;
    }
    dragRef.current = null;
    setPreview(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const dragRegion = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (disabled || drag === null || drag.pointerId !== event.pointerId) {
      return null;
    }
    const pageRect = event.currentTarget.getBoundingClientRect();
    // Never commit against a different layout from the one the user started on.
    if (!isManualRedactionPageRectUnchanged(drag.pageRect, pageRect)) {
      cancelDrag(event);
      return null;
    }
    return manualRedactionFromDrag({
      pageIndex,
      pageRect,
      start: drag.start,
      end: { x: event.clientX, y: event.clientY },
    });
  };

  return (
    <div
      aria-label={t("pdfDrawRegion")}
      className={cn(
        "absolute inset-0 z-20 select-none",
        disabled ? "touch-auto" : "touch-none",
      )}
      data-page-index={pageIndex}
      data-testid="manual-redaction-page-overlay"
      dir="ltr"
      onLostPointerCapture={cancelDrag}
      onPointerCancel={cancelDrag}
      onPointerDown={(event) => {
        if (
          disabled ||
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
          start: {
            x: event.clientX,
            y: event.clientY,
          },
        };
        setPreview(null);
      }}
      onPointerMove={(event) => {
        if (dragRef.current?.pointerId === event.pointerId) {
          event.preventDefault();
          event.stopPropagation();
          setPreview(dragRegion(event));
        }
      }}
      onPointerUp={(event) => {
        if (dragRef.current?.pointerId !== event.pointerId) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        const region = dragRegion(event);
        cancelDrag(event);
        if (
          region !== null &&
          preview !== null &&
          region.left === preview.left &&
          region.top === preview.top &&
          region.right === preview.right &&
          region.bottom === preview.bottom
        ) {
          onAdd(preview);
        }
      }}
      role="group"
    >
      {selections.map((selection) => (
        <button
          aria-label={t("pdfRemoveRegion")}
          // Black is document output here, not application chrome.
          className="outline-ring absolute cursor-pointer bg-[var(--pdf-redaction-fill)] outline-1 focus-visible:outline-2 focus-visible:outline-offset-2"
          data-manual-redaction-selection={selection.id}
          disabled={disabled}
          key={selection.id}
          onClick={(event) => {
            event.stopPropagation();
            onRemove(selection.id);
          }}
          onKeyDown={(event) => {
            if (
              disabled ||
              (event.key !== "Delete" && event.key !== "Backspace")
            ) {
              return;
            }
            event.preventDefault();
            event.stopPropagation();
            onRemove(selection.id);
          }}
          onPointerDown={(event) => event.stopPropagation()}
          style={regionStyle(selection)}
          type="button"
        />
      ))}
      {!disabled && preview !== null && (
        <div
          aria-hidden="true"
          className="outline-ring pointer-events-none absolute bg-[var(--pdf-redaction-fill)] opacity-60 outline-1"
          data-testid="manual-redaction-preview"
          style={regionStyle(preview)}
        />
      )}
    </div>
  );
};
