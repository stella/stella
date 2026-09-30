import { useCallback, useState } from "react";

// ── Fit-to-width ─────────────────────────────────────────

// Letter width at 96 DPI (816px); a touch wider than A4 so either page size
// fits without horizontal scroll. Sets only the initial zoom; the editor's own
// zoom control (Ctrl/Cmd+scroll) takes over after.
const DOCX_PAGE_WIDTH = 816;
const FIT_PADDING = 16;
const MIN_ZOOM = 0.25;
const MAX_FIT_ZOOM = 1;

const clampFitZoom = (zoom: number) =>
  Math.max(MIN_ZOOM, Math.min(MAX_FIT_ZOOM, zoom));

export const useFitToWidth = () => {
  const [fitZoom, setFitZoom] = useState(MAX_FIT_ZOOM);

  const containerRef = useCallback((node: HTMLElement | null) => {
    if (!node) {
      return undefined;
    }
    const updateZoom = () => {
      const { clientWidth } = node;
      if (clientWidth <= 0) {
        return;
      }
      const available = Math.max(1, clientWidth - FIT_PADDING * 2);
      setFitZoom(
        clampFitZoom(Math.round((available / DOCX_PAGE_WIDTH) * 100) / 100),
      );
    };
    updateZoom();
    const rafId = requestAnimationFrame(updateZoom);
    const observer = new ResizeObserver(updateZoom);
    observer.observe(node);
    return () => {
      cancelAnimationFrame(rafId);
      observer.disconnect();
    };
  }, []);

  return { containerRef, fitZoom };
};
