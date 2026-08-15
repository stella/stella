import { useCallback } from "react";

import { useLatestCallback } from "@/hooks/use-latest-callback";
import { consumePDFWheelZoomEvent } from "@/lib/pdf/pdf-zoom.logic";

export const usePDFWheelZoom = (
  onWheelZoom: ((deltaY: number) => void) | undefined,
) => {
  const handleWheel = useLatestCallback((event: WheelEvent) => {
    if (!onWheelZoom) {
      return;
    }

    consumePDFWheelZoomEvent(event, onWheelZoom);
  });
  const enabled = onWheelZoom !== undefined;

  return useCallback(
    (node: HTMLDivElement | null) => {
      if (!node || !enabled) {
        return undefined;
      }

      node.addEventListener("wheel", handleWheel, { passive: false });
      return () => node.removeEventListener("wheel", handleWheel);
    },
    [enabled, handleWheel],
  );
};
