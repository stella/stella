// pdf.js runs its worker on this page's thread: Metro cannot emit a separate
// worker bundle, and pdf.js uses `globalThis.pdfjsWorker` when one is
// loaded. The legacy build carries the polyfills an older iPhone's WebKit
// needs (`Map.prototype.getOrInsertComputed` and others the modern build
// assumes).
import "pdfjs-dist/legacy/build/pdf.worker.mjs";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import type {
  PDFDocumentProxy,
  RenderTask,
} from "pdfjs-dist/legacy/build/pdf.mjs";

const PAGE_GAP = 8;

/** Each page's height for a column `width` wide, from its own proportions. */
const pageHeights = async (
  pdf: PDFDocumentProxy,
  width: number,
): Promise<number[]> =>
  await Promise.all(
    Array.from({ length: pdf.numPages }, async (_, index) => {
      const viewport = (await pdf.getPage(index + 1)).getViewport({ scale: 1 });
      return (viewport.height / viewport.width) * width;
    }),
  );

/** A PDF drawn by pdf.js, each page when it nears the screen. */
export const PdfPages = ({
  bytes,
  onReady,
  onFailed,
}: {
  bytes: Uint8Array;
  onReady: () => void;
  onFailed: (message: string) => void;
}) => {
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [layout, setLayout] = useState<{
    width: number;
    heights: number[];
  } | null>(null);
  const painted = useRef(false);

  const failed = useEffectEvent((error: unknown) => {
    onFailed(String(error));
  });
  const pageFailed = (error: unknown) => {
    onFailed(String(error));
  };
  const pagePainted = () => {
    if (!painted.current) {
      painted.current = true;
      onReady();
    }
  };

  useEffect(() => {
    // pdf.js takes ownership of the bytes it is given.
    const task = getDocument({ data: bytes.slice() });
    const open = async () => {
      try {
        setPdf(await task.promise);
      } catch (error) {
        failed(error);
      }
    };
    void open();
    return () => {
      void task.destroy();
    };
  }, [bytes]);

  useEffect(() => {
    if (pdf === null) {
      return undefined;
    }
    let current = true;
    const measure = async () => {
      const width = document.documentElement.clientWidth;
      try {
        const heights = await pageHeights(pdf, width);
        if (current) {
          setLayout({ width, heights });
        }
      } catch (error) {
        failed(error);
      }
    };
    const remeasure = () => {
      void measure();
    };
    remeasure();
    window.addEventListener("resize", remeasure);
    return () => {
      current = false;
      window.removeEventListener("resize", remeasure);
    };
  }, [pdf]);

  if (pdf === null || layout === null) {
    return null;
  }
  return (
    <div style={{ height: "100%", overflowY: "auto" }}>
      {layout.heights.map((height, index) => (
        <PdfPage
          height={height}
          // Pages never reorder; the number is the page's identity.
          key={`page-${String(index + 1)}`}
          number={index + 1}
          onFailed={pageFailed}
          onPainted={pagePainted}
          pdf={pdf}
          width={layout.width}
        />
      ))}
    </div>
  );
};

const PdfPage = ({
  pdf,
  number,
  width,
  height,
  onPainted,
  onFailed,
}: {
  pdf: PDFDocumentProxy;
  number: number;
  width: number;
  height: number;
  onPainted: () => void;
  onFailed: (error: unknown) => void;
}) => {
  const canvas = useRef<HTMLCanvasElement>(null);
  const painted = useEffectEvent(onPainted);
  const failed = useEffectEvent(onFailed);

  useEffect(() => {
    const element = canvas.current;
    if (element === null) {
      return undefined;
    }
    const drawing: { task: RenderTask | null } = { task: null };
    let done = false;
    const draw = async () => {
      const page = await pdf.getPage(number);
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({
        scale: (width / base.width) * window.devicePixelRatio,
      });
      element.width = Math.floor(viewport.width);
      element.height = Math.floor(viewport.height);
      drawing.task = page.render({ canvas: element, viewport });
      await drawing.task.promise;
      painted();
    };
    const observer = new IntersectionObserver(
      (entries) => {
        if (done || !entries.some((entry) => entry.isIntersecting)) {
          return;
        }
        done = true;
        observer.disconnect();
        draw().catch((error: unknown) => {
          // A page left before it finished drawing is not a failure.
          if (!(
            error instanceof Error &&
            error.name === "RenderingCancelledException"
          )) {
            failed(error);
          }
        });
      },
      // Draw a screen ahead, so scrolling meets drawn pages.
      { rootMargin: "100% 0px" },
    );
    observer.observe(element);
    return () => {
      observer.disconnect();
      drawing.task?.cancel();
    };
  }, [pdf, number, width]);

  return (
    <canvas
      ref={canvas}
      style={{
        background: "white",
        display: "block",
        height,
        marginBottom: PAGE_GAP,
        width,
      }}
    />
  );
};
