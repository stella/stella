import { useEffect, useEffectEvent, useRef } from "react";
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
import {
  createEndOfContent,
  getCanvasSize,
  getCanvasTransform,
} from "@/lib/pdf/utils";
import { captureError } from "@/lib/posthog/utils";
import "pdfjs-dist/build/pdf.worker.mjs";
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
export const PdfPage = ({ fileId, pageId, isActive }: PdfPageProps) => {
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
};

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
 */
const PdfPageCanvas = ({ fileId, pageId, page }: PdfPageCanvasProps) => {
  const posthog = usePostHog();

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textLayerRef = useRef<HTMLDivElement>(null);

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
    const canvas = canvasRef.current;
    const textLayerContainer = textLayerRef.current;

    if (canvas === null || textLayerContainer === null || !shouldRenderPage) {
      return;
    }

    const { proxy, viewport } = page;

    if (proxy.destroyed) {
      return;
    }

    const canvasSize = getCanvasSize(viewport);

    canvas.width = canvasSize.width;
    canvas.height = canvasSize.height;

    const ctx = canvas.getContext("2d");

    if (ctx) {
      // Set default compositing so subpixel anti-aliasing
      // stays clean under the dark-mode invert+hue-rotate
      // filter. Without this, leftover blend modes from
      // prior renders produce magenta text outlines on
      // Windows (ClearType).
      ctx.globalCompositeOperation = "source-over";
    }

    const renderTask = proxy.render({
      canvas,
      viewport,
      transform: getCanvasTransform(),
    });
    renderTask.onError = reportError;

    const textLayer = new TextLayer({
      container: textLayerContainer,
      viewport,
      textContentSource: proxy.streamTextContent(),
    });

    // eslint-disable-next-line typescript/no-floating-promises
    renderTask.promise.then(async () => {
      try {
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
      renderTask.cancel();
      // eslint-disable-next-line typescript/no-floating-promises
      renderTask.promise.finally(() => proxy.cleanup());
      textLayer.cancel();
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
      <canvas
        className="absolute start-0 top-0 h-full w-full contain-content"
        ref={canvasRef}
      />
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
