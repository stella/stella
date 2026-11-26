import { useState } from "react";
import type { Dispatch, RefObject, SetStateAction } from "react";

import { panic } from "better-result";

import { fitWidthZoom } from "@stll/folio-core/paged-layout/fitWidthZoom";
import { useExternalSyncEffect } from "@stll/ui/effects";
import { useObservedValue } from "@stll/ui/effects-dom";

import { DOCX_PAGE_WIDTH } from "@/components/docx/docx-page.logic";

// Target the typical Word text area (page minus ~1-inch margins on
// each side at 96 DPI). Fitting to this rather than the full 816px
// page keeps the body text full-width in the inspector instead of
// leaving the page margins as dead whitespace. The page edges then
// overflow horizontally and the user can scroll to inspect margins.
const DOCX_TEXT_AREA_WIDTH = 624;

// Fit target for whole-page surfaces: inflating the page width by a per-side
// gutter reserves ~7.5% of the container width as symmetric breathing space,
// so the fitted page never touches the panel edges.
const DOCX_PAGE_SIDE_GUTTER = 0.075;
export const DOCX_PAGE_FIT_WIDTH =
  DOCX_PAGE_WIDTH / (1 - 2 * DOCX_PAGE_SIDE_GUTTER);
const DOCX_FIT_PADDING = 4;
const DOCX_DEFAULT_ZOOM = 1;
const DOCX_MIN_ZOOM = 0.25;
const DOCX_MAX_ZOOM = 2;
const DOCX_PINCH_SENSITIVITY = 0.005;

type ZoomableDocxEditor = {
  getZoom: () => number;
  setZoom: (zoom: number) => void;
};

const clampDocxZoom = (zoom: number) =>
  Math.max(DOCX_MIN_ZOOM, Math.min(DOCX_MAX_ZOOM, zoom));

type DocxFitZoomResult = {
  containerRef: Dispatch<SetStateAction<HTMLElement | null>>;
  fitZoom: number;
};

/**
 * How a view fits a DOCX page to its container:
 * - `editor`: the whole page, by the rule Folio's editor fits with
 *   (`fitWidthZoom`), for the editor and every view that stands in for it
 *   (its loading sheet, a zoom nudged from the fit, the read-only viewer), so
 *   the page keeps its box when the editor replaces them;
 * - `width`: `fitWidth` px fitted to the container, up to `maxAutoZoom`. The
 *   Word text area (the default) fills the panel with body text and lets the
 *   page margins overflow; the full page plus a gutter allowance fits the
 *   whole page with the spare width as symmetric side padding.
 */
type DocxFit =
  | { type: "editor" }
  | { type: "width"; fitWidth?: number; maxAutoZoom?: number };

type DocxFitZoomOptions = {
  fit: DocxFit;
  /** Added to the auto-fit zoom after clamping (a manual zoom nudge). */
  scaleOffset?: number;
};

export const useDocxFitZoom = ({
  fit,
  scaleOffset = 0,
}: DocxFitZoomOptions): DocxFitZoomResult => {
  const [container, setContainer] = useState<HTMLElement | null>(null);
  // The fit as primitives, so a caller's fresh `fit` object does not
  // re-subscribe the observer.
  const fitType = fit.type;
  const fitWidth =
    fit.type === "width" ? (fit.fitWidth ?? DOCX_TEXT_AREA_WIDTH) : null;
  const maxAutoZoom =
    fit.type === "width" ? (fit.maxAutoZoom ?? DOCX_MAX_ZOOM) : null;

  // The container is held in state (`ref={containerRef}`): the real container
  // only appears after a loading fallback unmounts, and the observer follows
  // whichever node is attached, once per node lifetime.
  const fitZoom = useObservedValue<HTMLElement, number>(
    container,
    (node, emit) => {
      // The widest scrollbar edge seen so far, which the editor's fit keeps.
      let reservedEdge = 0;
      const updateZoom = () => {
        const { clientWidth, offsetWidth } = node;
        if (clientWidth <= 0) {
          return;
        }
        switch (fitType) {
          case "editor": {
            const editorFit = fitWidthZoom({
              clientWidth,
              offsetWidth,
              pageWidth: DOCX_PAGE_WIDTH,
              reservedEdge,
            });
            reservedEdge = editorFit.reservedEdge;
            if (editorFit.zoom !== null) {
              emit(clampDocxZoom(editorFit.zoom));
            }
            return;
          }
          case "width": {
            const availableWidth = Math.max(
              1,
              clientWidth - DOCX_FIT_PADDING * 2,
            );
            const cappedFitZoom = Math.min(
              maxAutoZoom ?? DOCX_MAX_ZOOM,
              availableWidth / (fitWidth ?? DOCX_TEXT_AREA_WIDTH),
            );
            emit(clampDocxZoom(Math.round(cappedFitZoom * 100) / 100));
            return;
          }
          default: {
            fitType satisfies never;
            panic("Unhandled DOCX fit");
          }
        }
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
    [fitType, fitWidth, maxAutoZoom],
    DOCX_DEFAULT_ZOOM,
  );

  return {
    containerRef: setContainer,
    fitZoom: clampDocxZoom(fitZoom + scaleOffset),
  };
};

export const useDocxWheelZoom = (
  containerRef: RefObject<HTMLElement | null>,
  editorRef: RefObject<ZoomableDocxEditor | null>,
) => {
  useExternalSyncEffect(() => {
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
