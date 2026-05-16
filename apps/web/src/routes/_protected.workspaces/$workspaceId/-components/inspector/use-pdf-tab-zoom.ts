import { useCallback, useEffect, useRef, useState } from "react";

const ZOOM_STEP = 0.2;
const MIN_OFFSET = -0.8;
const MAX_OFFSET = 2;
const PINCH_ZOOM_SENSITIVITY = 0.005;

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

  const handleZoom = useCallback((tabId: string, direction: "in" | "out") => {
    setScaleOffsets((prev) => {
      const current = prev.get(tabId) ?? 0;
      const delta = direction === "in" ? ZOOM_STEP : -ZOOM_STEP;
      const next = Math.round((current + delta) * 10) / 10;

      if (next < MIN_OFFSET || next > MAX_OFFSET) {
        return prev;
      }

      const updated = new Map(prev);
      updated.set(tabId, next);
      return updated;
    });
  }, []);

  const handleResetZoom = useCallback((tabId: string) => {
    setScaleOffsets((prev) => {
      const updated = new Map(prev);
      updated.set(tabId, 0);
      return updated;
    });
  }, []);

  useEffect(() => {
    const el = pdfContentRef.current;
    if (!el || activeTabType !== "pdf") {
      return undefined;
    }

    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey || !activeId) {
        return;
      }
      event.preventDefault();

      setScaleOffsets((prev) => {
        const current = prev.get(activeId) ?? 0;
        const delta = -event.deltaY * PINCH_ZOOM_SENSITIVITY;
        const next =
          Math.round(
            Math.max(MIN_OFFSET, Math.min(MAX_OFFSET, current + delta)) * 100,
          ) / 100;

        if (next === current) {
          return prev;
        }

        const updated = new Map(prev);
        updated.set(activeId, next);
        return updated;
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
