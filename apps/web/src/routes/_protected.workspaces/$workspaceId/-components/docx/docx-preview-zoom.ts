import { useCallback, useEffect, useState } from "react";
import type { RefObject } from "react";

// Target the typical Word text area (page minus ~1-inch margins on
// each side at 96 DPI). Fitting to this rather than the full 816px
// page keeps the body text full-width in the inspector instead of
// leaving the page margins as dead whitespace. The page edges then
// overflow horizontally and the user can scroll to inspect margins.
const DOCX_TEXT_AREA_WIDTH = 624;
const DOCX_FIT_PADDING = 4;
const DOCX_DEFAULT_ZOOM = 1;
const DOCX_MIN_ZOOM = 0.25;
const DOCX_MAX_ZOOM = 2;
const DOCX_PINCH_SENSITIVITY = 0.005;

type ZoomableDocxEditor = {
  getZoom: () => number;
  setZoom: (zoom: number) => void;
};

export const clampDocxZoom = (zoom: number) =>
  Math.max(DOCX_MIN_ZOOM, Math.min(DOCX_MAX_ZOOM, zoom));

type DocxFitZoomResult = {
  containerRef: (node: HTMLElement | null) => (() => void) | undefined;
  fitZoom: number;
};

export const useDocxFitZoom = (
  scaleOffset: number = 0,
  maxAutoZoom: number = DOCX_MAX_ZOOM,
): DocxFitZoomResult => {
  const [fitZoom, setFitZoom] = useState(DOCX_DEFAULT_ZOOM);

  // Callback ref: React invokes this once when the container
  // attaches to the DOM and runs the returned cleanup when it
  // detaches. Subscribing via useEffect on a passed-in RefObject
  // does not work here because the real container only appears
  // after a loading fallback unmounts, and useEffect does not
  // re-run on ref mutation. The callback-ref form attaches the
  // ResizeObserver exactly once per node lifetime regardless of
  // parent re-renders.
  const containerRef = useCallback(
    (node: HTMLElement | null) => {
      if (!node) {
        return undefined;
      }

      const updateZoom = () => {
        const { clientWidth } = node;
        if (clientWidth <= 0) {
          return;
        }
        const availableWidth = Math.max(1, clientWidth - DOCX_FIT_PADDING * 2);
        const nextFitZoom = availableWidth / DOCX_TEXT_AREA_WIDTH;
        const cappedFitZoom = Math.min(maxAutoZoom, nextFitZoom);
        setFitZoom(clampDocxZoom(Math.round(cappedFitZoom * 100) / 100));
      };

      updateZoom();
      // Belt-and-braces retry on the next frame for surfaces
      // where the parent finishes sizing after our first measure
      // (e.g., inspector pane expanding on the same commit as
      // the docx tab opening).
      const rafId = requestAnimationFrame(updateZoom);
      const observer = new ResizeObserver(updateZoom);
      observer.observe(node);

      return () => {
        cancelAnimationFrame(rafId);
        observer.disconnect();
      };
    },
    [maxAutoZoom],
  );

  return { containerRef, fitZoom: clampDocxZoom(fitZoom + scaleOffset) };
};

export const useDocxWheelZoom = (
  containerRef: RefObject<HTMLElement | null>,
  editorRef: RefObject<ZoomableDocxEditor | null>,
) => {
  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return undefined;
    }

    const handleWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) {
        return;
      }
      event.preventDefault();

      const editor = editorRef.current;
      if (!editor) {
        return;
      }

      const delta = -event.deltaY * DOCX_PINCH_SENSITIVITY;
      const currentZoom = editor.getZoom();
      const nextZoom =
        Math.round(clampDocxZoom(currentZoom + delta) * 100) / 100;

      editor.setZoom(nextZoom);
    };

    container.addEventListener("wheel", handleWheel, { passive: false });
    return () => {
      container.removeEventListener("wheel", handleWheel);
    };
  }, [containerRef, editorRef]);
};
