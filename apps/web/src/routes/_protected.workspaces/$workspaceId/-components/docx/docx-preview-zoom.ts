import { useEffect, useLayoutEffect, useState } from "react";
import type { RefObject } from "react";

const DOCX_PAGE_WIDTH = 816;
const DOCX_FIT_PADDING = 16;
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

export const useDocxFitZoom = (
  containerRef: RefObject<HTMLElement | null>,
  scaleOffset: number = 0,
  maxAutoZoom: number = DOCX_MAX_ZOOM,
) => {
  const [fitZoom, setFitZoom] = useState(DOCX_DEFAULT_ZOOM);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return undefined;
    }

    const updateZoom = () => {
      const { clientWidth } = container;
      if (clientWidth <= 0) {
        return;
      }

      const availableWidth = Math.max(1, clientWidth - DOCX_FIT_PADDING * 2);
      const nextFitZoom = availableWidth / DOCX_PAGE_WIDTH;

      const cappedFitZoom = Math.min(maxAutoZoom, nextFitZoom);

      setFitZoom(clampDocxZoom(Math.round(cappedFitZoom * 100) / 100));
    };

    updateZoom();
    const observer = new ResizeObserver(updateZoom);
    observer.observe(container);

    return () => {
      observer.disconnect();
    };
  }, [containerRef, maxAutoZoom]);

  return clampDocxZoom(fitZoom + scaleOffset);
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
      const nextZoom = clampDocxZoom(editor.getZoom() + delta);
      editor.setZoom(Math.round(nextZoom * 100) / 100);
    };

    container.addEventListener("wheel", handleWheel, { passive: false });
    return () => {
      container.removeEventListener("wheel", handleWheel);
    };
  }, [containerRef, editorRef]);
};
