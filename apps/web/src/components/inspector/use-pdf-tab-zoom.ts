import { useState } from "react";

import {
  getPDFScaleOffset,
  getPDFWheelZoomScaleOffset,
  PDF_SCALE_OFFSET_STEP,
} from "@/lib/pdf/pdf-zoom.logic";

export const usePdfTabZoom = () => {
  const [scaleOffsets, setScaleOffsets] = useState<Map<string, number>>(
    () => new Map(),
  );

  const handleZoom = (tabId: string, direction: "in" | "out") => {
    setScaleOffsets((prev) => {
      const current = prev.get(tabId) ?? 0;
      const delta =
        direction === "in" ? PDF_SCALE_OFFSET_STEP : -PDF_SCALE_OFFSET_STEP;
      const next = getPDFScaleOffset(current, delta);

      if (next === current) {
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

  const handleWheelZoom = (tabId: string, deltaY: number) => {
    setScaleOffsets((prev) => {
      const current = prev.get(tabId) ?? 0;
      const next = getPDFWheelZoomScaleOffset(current, deltaY);

      if (next === current) {
        return prev;
      }

      const updated = new Map(prev);
      updated.set(tabId, next);
      return updated;
    });
  };

  return {
    handleResetZoom,
    handleWheelZoom,
    handleZoom,
    scaleOffsets,
    setScaleOffsets,
  };
};
