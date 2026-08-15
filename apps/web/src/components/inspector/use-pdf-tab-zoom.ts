import { useRef, useState } from "react";

import { useExternalSyncEffect } from "@/hooks/use-effect";
import {
  consumePDFWheelZoomEvent,
  getPDFWheelZoomScaleOffset,
  PDF_MAX_SCALE_OFFSET,
  PDF_MIN_SCALE_OFFSET,
  PDF_SCALE_OFFSET_STEP,
} from "@/lib/pdf/pdf-zoom.logic";

type UsePdfTabZoomOptions = {
  activeId: string | null;
  activeTabType: string | undefined;
};

export const usePdfTabZoom = ({
  activeId,
  activeTabType,
}: UsePdfTabZoomOptions) => {
  const [scaleOffsets, setScaleOffsets] = useState<Map<string, number>>(
    () => new Map(),
  );
  const pdfContentRef = useRef<HTMLDivElement>(null);

  const handleZoom = (tabId: string, direction: "in" | "out") => {
    setScaleOffsets((prev) => {
      const current = prev.get(tabId) ?? 0;
      const delta =
        direction === "in" ? PDF_SCALE_OFFSET_STEP : -PDF_SCALE_OFFSET_STEP;
      const next = Math.round((current + delta) * 10) / 10;

      if (next < PDF_MIN_SCALE_OFFSET || next > PDF_MAX_SCALE_OFFSET) {
        return prev;
      }

      const updated = new Map(prev);
      updated.set(tabId, next);
      return updated;
    });
  };

  const handleResetZoom = (tabId: string) => {
    setScaleOffsets((prev) => {
      const updated = new Map(prev);
      updated.set(tabId, 0);
      return updated;
    });
  };

  useExternalSyncEffect(() => {
    const el = pdfContentRef.current;
    if (!el || activeTabType !== "pdf") {
      return undefined;
    }

    const onWheel = (event: WheelEvent) => {
      if (!activeId) {
        return;
      }

      consumePDFWheelZoomEvent(event, (deltaY) => {
        setScaleOffsets((prev) => {
          const current = prev.get(activeId) ?? 0;
          const next = getPDFWheelZoomScaleOffset(current, deltaY);

          if (next === current) {
            return prev;
          }

          const updated = new Map(prev);
          updated.set(activeId, next);
          return updated;
        });
      });
    };

    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [activeId, activeTabType]);

  return {
    handleResetZoom,
    handleZoom,
    pdfContentRef,
    scaleOffsets,
    setScaleOffsets,
  };
};
