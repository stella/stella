import { Result } from "better-result";
import { RenderingCancelledException, TextLayer } from "pdfjs-dist";
import type { PageViewport, PDFPageProxy } from "pdfjs-dist";

import { EOC_CLASS_NAME } from "@/lib/pdf/consts";
import type { RenderedPage } from "@/lib/pdf/pdf-context";
import { PDFViewerError } from "@/lib/pdf/pdf-errors";
import { getCanvasSize, getCanvasTransform } from "@/lib/pdf/utils";

const isRenderingCancelledError = (err: unknown): boolean =>
  err instanceof RenderingCancelledException ||
  (err instanceof Error && err.name === "AbortError");

const createCanvasElement = (viewport: PageViewport): HTMLCanvasElement => {
  const canvas = document.createElement("canvas");

  canvas.style.position = "absolute";
  canvas.style.insetInlineStart = "0";
  canvas.style.top = "0";
  canvas.style.transformOrigin = "top left";
  canvas.style.contain = "content";

  const canvasSize = getCanvasSize(viewport);
  canvas.width = canvasSize.width;
  canvas.height = canvasSize.height;
  canvas.style.width = "100%";
  canvas.style.height = "100%";

  return canvas;
};

const createTextLayerElement = (viewport: PageViewport): HTMLDivElement => {
  const textLayerDiv = document.createElement("div");

  textLayerDiv.style.position = "absolute";
  textLayerDiv.style.inset = "0";
  textLayerDiv.style.width = `${viewport.width}px`;
  textLayerDiv.style.height = `${viewport.height}px`;
  textLayerDiv.style.lineHeight = "1";

  const eoc = createEndOfContent();
  textLayerDiv.append(eoc);

  return textLayerDiv;
};

const createEndOfContent = () => {
  const eoc = document.createElement("div");

  eoc.className = EOC_CLASS_NAME;
  eoc.style.display = "none";
  eoc.style.position = "absolute";
  eoc.style.top = "0";
  eoc.style.zIndex = "0";
  eoc.style.userSelect = "none";
  eoc.style.width = "100%";
  eoc.style.height = "100%";
  // additional style to not lose text cursor when selecting text
  eoc.style.cursor = "text";

  return eoc;
};

export const renderPage = async (
  proxy: PDFPageProxy,
  viewport: PageViewport,
  signal: AbortSignal,
): Promise<Result<RenderedPage, PDFViewerError>> =>
  await Result.tryPromise({
    try: async (): Promise<Result<RenderedPage, PDFViewerError>> => {
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
      isRenderingCancelledError(err)
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
