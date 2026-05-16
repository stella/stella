import { Result } from "better-result";

import { EOC_CLASS_NAME } from "@/lib/pdf/consts";
import type { RenderedPage } from "@/lib/pdf/pdf-context";
import { PDFViewerError } from "@/lib/pdf/pdf-errors";
import { loadPdfjs } from "@/lib/pdf/pdfjs-loader";
import type { PageViewport, PDFPageProxy } from "@/lib/pdf/pdfjs-loader";
import { getCanvasSize, getCanvasTransform } from "@/lib/pdf/utils";

const isRenderingCancelledError = (
  err: unknown,
  RenderingCancelledException: unknown,
): boolean =>
  (typeof RenderingCancelledException === "function" &&
    err instanceof RenderingCancelledException) ||
  (err instanceof Error && err.name === "AbortError");

const createCanvasElement = (viewport: PageViewport): HTMLCanvasElement => {
  const canvas = document.createElement("canvas");

  Object.assign(canvas.style, {
    contain: "content",
    insetInlineStart: "0",
    position: "absolute",
    top: "0",
    transformOrigin: "top left",
  });

  const canvasSize = getCanvasSize(viewport);
  canvas.width = canvasSize.width;
  canvas.height = canvasSize.height;
  Object.assign(canvas.style, {
    height: "100%",
    width: "100%",
  });

  return canvas;
};

const createTextLayerElement = (viewport: PageViewport): HTMLDivElement => {
  const textLayerDiv = document.createElement("div");

  Object.assign(textLayerDiv.style, {
    height: `${viewport.height}px`,
    inset: "0",
    lineHeight: "1",
    position: "absolute",
    width: `${viewport.width}px`,
  });

  const eoc = createEndOfContent();
  textLayerDiv.append(eoc);

  return textLayerDiv;
};

const createEndOfContent = () => {
  const eoc = document.createElement("div");

  eoc.className = EOC_CLASS_NAME;
  Object.assign(eoc.style, {
    cursor: "text",
    display: "none",
    height: "100%",
    position: "absolute",
    top: "0",
    userSelect: "none",
    width: "100%",
    zIndex: "0",
  });

  return eoc;
};

export const renderPage = async (
  proxy: PDFPageProxy,
  viewport: PageViewport,
  signal: AbortSignal,
): Promise<Result<RenderedPage, PDFViewerError>> => {
  let renderingCancelledException: unknown = null;

  return await Result.tryPromise({
    try: async (): Promise<Result<RenderedPage, PDFViewerError>> => {
      const { RenderingCancelledException, TextLayer } = await loadPdfjs();
      renderingCancelledException = RenderingCancelledException;

      signal.throwIfAborted();

      if (proxy.destroyed) {
        return Result.err(
          new PDFViewerError({
            code: "LOAD_FAILED",
            message: "Page proxy is destroyed",
          }),
        );
      }

      const canvas = createCanvasElement(viewport);
      const textLayerDiv = createTextLayerElement(viewport);

      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.globalCompositeOperation = "source-over";
      }

      const renderTask = proxy.render({
        canvas,
        viewport,
        transform: getCanvasTransform(),
      });
      const textLayer = new TextLayer({
        container: textLayerDiv,
        viewport,
        textContentSource: proxy.streamTextContent(),
      });

      const onAbort = () => {
        renderTask.cancel();
        textLayer.cancel();
        canvas.remove();
        textLayerDiv.remove();
      };
      signal.addEventListener("abort", onAbort);

      try {
        await Promise.all([renderTask.promise, textLayer.render()]);
      } finally {
        signal.removeEventListener("abort", onAbort);
      }

      return Result.ok({ canvas, textLayerDiv, viewport });
    },
    catch: (err) =>
      isRenderingCancelledError(err, renderingCancelledException)
        ? new PDFViewerError({
            code: "CANCELLED",
            message: "Rendering cancelled",
            cause: err,
          })
        : new PDFViewerError({
            code: "LOAD_FAILED",
            message:
              err instanceof Error ? err.message : "Failed to render page",
            cause: err,
          }),
  }).then(Result.flatten);
};
