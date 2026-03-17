import { memo, useEffect, useEffectEvent, useRef } from "react";
import type { CSSProperties } from "react";

import { usePostHog } from "@posthog/react";
import {
  AbortException,
  RenderingCancelledException,
  TextLayer,
} from "pdfjs-dist";
import type { PDFPageProxy, PageViewport } from "pdfjs-dist";
import { useShallow } from "zustand/react/shallow";

import { transformUnknownError } from "@/lib/errors/utils";
import {
  EOC_CLASS_NAME,
  PAGE_NUMBER_ATTRIBUTE,
  TEXT_LAYER_ATTRIBUTE,
} from "@/lib/pdf/consts";
import { usePdfStore } from "@/lib/pdf/pdf-store";
import { markRenderEnd, markRenderStart } from "@/lib/pdf/perf";
import {
  createEndOfContent,
  getCanvasSize,
  getCanvasTransform,
} from "@/lib/pdf/utils";
import { captureError } from "@/lib/posthog/utils";
import { PageAnonymisation } from "@/routes/_protected.workspaces/$workspaceId/-components/pdf/page-anonymisation";
import { PageCitation } from "@/routes/_protected.workspaces/$workspaceId/-components/pdf/page-citation";

type PdfPageProps = {
  fileId: string;
  pageId: string;
  isActive: boolean;
};

/**
 * Outer shell: always mounted for every page. Renders a
 * correctly-sized div so scroll position is stable. Only
 * mounts the heavy inner component when `isActive` is true.
 */
export const PdfPage = memo(function PdfPage({
  fileId,
  pageId,
  isActive,
}: PdfPageProps) {
  const page = usePdfStore(useShallow((s) => s.pages.get(fileId)?.get(pageId)));
  const pageNumber = page?.proxy.pageNumber;

  const shouldScrollToPage = usePdfStore(
    useShallow((s) => {
      const scrollTo = s.scrollTo.get(fileId);

      if (scrollTo === undefined || pageNumber === undefined) {
        return false;
      }

      return scrollTo.justificationId
        ? false
        : scrollTo.pageNumber === pageNumber;
    }),
  );
  const consumeScrollTo = usePdfStore((s) => s.consumeScrollTo);

  return (
    <div
      ref={(el) => {
        if (!el || !shouldScrollToPage) {
          return;
        }
        el.scrollIntoView({ block: "start" });
        consumeScrollTo(fileId);
      }}
      {...{ [PAGE_NUMBER_ATTRIBUTE]: pageNumber }}
      className="relative mx-auto border-transparent"
      style={
        {
          "--total-scale-factor": "var(--scale-factor)",
          width: `round(down, var(--total-scale-factor) * ${page?.originalWidth ?? 0}px, var(--scale-round-x))`,
          height: `round(down, var(--total-scale-factor) * ${page?.originalHeight ?? 0}px, var(--scale-round-y))`,
        } as CSSProperties
      }
    >
      {isActive && page && (
        <PdfPageCanvas fileId={fileId} page={page} pageId={pageId} />
      )}
    </div>
  );
});

type PageData = {
  proxy: PDFPageProxy;
  originalWidth: number;
  originalHeight: number;
  viewport: PageViewport;
};

type PdfPageCanvasProps = {
  fileId: string;
  pageId: string;
  page: PageData;
};

/**
 * Heavy inner component: canvas rendering, text layer,
 * citations. Only mounted for pages in/near the viewport.
 *
 * Uses double-buffering to eliminate flicker on zoom: the
 * new scale is rendered to a hidden offscreen canvas, then
 * swapped in once the render completes. The old canvas
 * stays visible throughout.
 */
const PdfPageCanvas = ({ fileId, pageId, page }: PdfPageCanvasProps) => {
  const posthog = usePostHog();

  const containerRef = useRef<HTMLDivElement>(null);
  const textLayerRef = useRef<HTMLDivElement>(null);
  /** The currently visible (front) canvas. */
  const frontCanvasRef = useRef<HTMLCanvasElement | null>(null);
  /** The scale at which the front canvas was rendered. */
  const frontScaleRef = useRef<number | null>(null);

  const shouldRenderPage = usePdfStore(
    useShallow(
      (s) =>
        s.renderMap.get(fileId)?.renderingPageIds.includes(pageId) ?? false,
    ),
  );
  const advancePageRendering = usePdfStore((s) => s.advancePageRendering);

  const reportError = useEffectEvent((error: Error) => {
    if (
      error instanceof RenderingCancelledException ||
      error instanceof AbortException
    ) {
      return;
    }

    captureError(posthog, error);
  });

  useEffect(() => {
    const container = containerRef.current;
    const textLayerContainer = textLayerRef.current;

    if (
      container === null ||
      textLayerContainer === null ||
      !shouldRenderPage
    ) {
      return;
    }

    const { proxy, viewport } = page;

    if (proxy.destroyed) {
      return;
    }

    // Create a back-buffer canvas for rendering. Once the
    // render completes, swap it in and remove the old one.
    const backCanvas = document.createElement("canvas");
    backCanvas.className =
      "absolute start-0 top-0 origin-top-left contain-content";
    // Hide until render is done; use explicit CSS
    // dimensions so the canvas doesn't stretch (the CSS
    // transform on the old canvas handles visual scaling).
    backCanvas.style.visibility = "hidden";
    backCanvas.style.width = `${viewport.width}px`;
    backCanvas.style.height = `${viewport.height}px`;

    const canvasSize = getCanvasSize(viewport);
    backCanvas.width = canvasSize.width;
    backCanvas.height = canvasSize.height;

    const ctx = backCanvas.getContext("2d");
    if (ctx) {
      ctx.globalCompositeOperation = "source-over";
    }

    // Scale the old front canvas with a CSS transform for
    // instant GPU-accelerated visual feedback while the
    // back buffer renders at the new scale.
    const oldFrontCanvas = frontCanvasRef.current;
    const oldScale = frontScaleRef.current;
    if (oldFrontCanvas && oldScale !== null && oldScale !== viewport.scale) {
      const ratio = viewport.scale / oldScale;
      oldFrontCanvas.style.transformOrigin = "top left";
      oldFrontCanvas.style.transform = `scale(${ratio})`;
    }

    // Insert behind the current front canvas so it renders
    // offscreen while the old content stays visible.
    container.prepend(backCanvas);

    markRenderStart(pageId);

    const renderTask = proxy.render({
      canvas: backCanvas,
      viewport,
      transform: getCanvasTransform(),
    });
    renderTask.onError = reportError;

    const textLayer = new TextLayer({
      container: textLayerContainer,
      viewport,
      textContentSource: proxy.streamTextContent(),
    });

    let cancelled = false;

    // eslint-disable-next-line typescript/no-floating-promises
    renderTask.promise.then(async () => {
      if (cancelled) {
        return;
      }

      try {
        markRenderEnd(pageId);

        // Swap: show crisp back canvas, remove old front
        backCanvas.style.visibility = "visible";
        const oldFront = frontCanvasRef.current;
        if (oldFront && oldFront !== backCanvas) {
          oldFront.remove();
        }
        frontCanvasRef.current = backCanvas;
        frontScaleRef.current = viewport.scale;

        textLayerContainer.innerHTML = "";
        await textLayer.render();

        const eoc = createEndOfContent();
        textLayerContainer.append(eoc);

        advancePageRendering(fileId, pageId);
      } catch (unknownError) {
        const error = transformUnknownError(unknownError);
        if (error) {
          reportError(error);
        }
      }
    });

    return () => {
      cancelled = true;
      renderTask.cancel();
      // eslint-disable-next-line typescript/no-floating-promises
      renderTask.promise.finally(() => proxy.cleanup());
      textLayer.cancel();
      // If the render was cancelled before completing,
      // remove the unused back canvas.
      if (frontCanvasRef.current !== backCanvas) {
        backCanvas.remove();
      }
      // On unmount (LRU eviction), release the front
      // canvas ref so the detached element can be GC'd.
      // On zoom re-runs the container is still mounted,
      // so the ref is kept for CSS-scale feedback.
      // `container` is captured at effect start; reading
      // `.isConnected` avoids accessing the ref in cleanup.
      if (!container.isConnected) {
        frontCanvasRef.current = null;
        frontScaleRef.current = null;
      }
    };
  }, [page, fileId, pageId, advancePageRendering, shouldRenderPage]);

  // Prevent memory leaks from detached layers
  useEffect(() => {
    const textLayerContainer = textLayerRef.current;

    return () => {
      if (textLayerContainer) {
        textLayerContainer.innerHTML = "";
      }
    };
  }, []);

  return (
    <>
      <div className="absolute inset-0 overflow-hidden" ref={containerRef} />
      <div
        className="absolute inset-0 leading-none [&>br,span]:absolute [&>br,span]:z-1 [&>br,span]:origin-top-left [&>br,span]:cursor-text [&>br,span]:whitespace-pre [&>br,span]:text-transparent [&>br::selection]:bg-transparent [&>span::selection]:bg-indigo-600/25"
        {...{ [TEXT_LAYER_ATTRIBUTE]: true }}
        onPointerUpCapture={() => {
          const endDiv = textLayerRef.current?.querySelector<HTMLDivElement>(
            `.${EOC_CLASS_NAME}`,
          );
          if (endDiv) {
            endDiv.style.display = "none";
          }
        }}
        ref={textLayerRef}
      />
      <PageAnonymisation
        fileId={fileId}
        originalHeight={page.originalHeight}
        originalWidth={page.originalWidth}
        pageIndex={page.proxy.pageNumber - 1}
        scale={page.viewport.scale}
      />
      <PageCitation
        fileId={fileId}
        originalHeight={page.originalHeight}
        originalWidth={page.originalWidth}
        pageNumber={page.proxy.pageNumber}
        scale={page.viewport.scale}
      />
    </>
  );
};
