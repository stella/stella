// pdf.js runs its worker on this page's thread: Metro cannot emit a separate
// worker bundle, and pdf.js uses `globalThis.pdfjsWorker` when one is
// loaded. The legacy build carries the polyfills an older iPhone's WebKit
// needs (`Map.prototype.getOrInsertComputed` and others the modern build
// assumes).
import "pdfjs-dist/legacy/build/pdf.worker.mjs";
import {
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import { Result } from "better-result";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import type {
  PDFDocumentProxy,
  RenderTask,
} from "pdfjs-dist/legacy/build/pdf.mjs";

import { anchoredScroll, canvasScale, scaledScroll } from "./zoom";

/** The canvas showing between pages and around them, as on the web. */
const PAGE_GAP = 12;

/** The web's dark-mode page: inverted, with hues turned back. */
const DARK_PAGE_FILTER = "invert(1) hue-rotate(180deg)";

/** A page's height over its width. */
const pageRatio = async (
  pdf: PDFDocumentProxy,
  number: number,
): Promise<number> => {
  const viewport = (await pdf.getPage(number)).getViewport({ scale: 1 });
  return viewport.height / viewport.width;
};

/**
 * A PDF drawn by pdf.js, each page when it nears the screen, `zoom` times
 * the screen's width.
 */
export const PdfPages = ({
  bytes,
  clearance,
  invert,
  zoom,
  onReady,
  onFailed,
}: {
  bytes: Uint8Array;
  /** Room under the last page, in CSS pixels, for what the app floats there. */
  clearance: number;
  /** Draw the pages inverted, as the web does in dark mode. */
  invert: boolean;
  /** The pages' width as a factor of the screen's (see ./zoom.ts). */
  zoom: number;
  onReady: () => void;
  onFailed: (message: string) => void;
}) => {
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [layout, setLayout] = useState<{
    width: number;
    ratios: number[];
  } | null>(null);
  // The pages watch how near they are to the screen within this scroller.
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
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
      const opened = await Result.tryPromise(async () => await task.promise);
      if (Result.isError(opened)) {
        failed(opened.error);
        return;
      }
      setPdf(opened.value);
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
    let width = document.documentElement.clientWidth - 2 * PAGE_GAP;
    let ratios: number[] | null = null;
    const show = () => {
      if (current && ratios !== null) {
        setLayout({ width, ratios });
      }
    };
    // The first page's proportions stand in for every page's until all are
    // measured, so a long document does not wait on each page to draw.
    const measure = async () => {
      const first = await Result.tryPromise(
        async () => await pageRatio(pdf, 1),
      );
      if (Result.isError(first)) {
        failed(first.error);
        return;
      }
      ratios = Array.from({ length: pdf.numPages }, () => first.value);
      show();
      const all = await Result.tryPromise(
        async () =>
          await Promise.all(
            Array.from(
              { length: pdf.numPages },
              async (_, index) => await pageRatio(pdf, index + 1),
            ),
          ),
      );
      if (Result.isError(all)) {
        failed(all.error);
        return;
      }
      if (all.value.some((ratio) => ratio !== first.value)) {
        ratios = all.value;
        show();
      }
    };
    const resized = () => {
      width = document.documentElement.clientWidth - 2 * PAGE_GAP;
      show();
    };
    void measure();
    window.addEventListener("resize", resized);
    return () => {
      current = false;
      window.removeEventListener("resize", resized);
    };
  }, [pdf]);

  // A new zoom keeps the point at the middle of the screen on the same spot
  // of the same page. The offsets are read as the person scrolls, before a
  // zoom out shortens the pages and the browser clamps them.
  const scrolling = useRef<HTMLDivElement | null>(null);
  const scrolled = useRef({ top: 0, left: 0 });
  const shownZoom = useRef(zoom);
  useLayoutEffect(() => {
    const previous = shownZoom.current;
    shownZoom.current = zoom;
    const box = scrolling.current;
    if (box === null || layout === null || zoom === previous) {
      return;
    }
    const heights = (at: number) =>
      layout.ratios.map((ratio) => ratio * layout.width * at);
    box.scrollTop = anchoredScroll({
      offset: scrolled.current.top,
      viewport: box.clientHeight,
      lead: PAGE_GAP,
      gap: PAGE_GAP,
      before: heights(previous),
      after: heights(zoom),
    });
    box.scrollLeft = scaledScroll({
      offset: scrolled.current.left,
      viewport: box.clientWidth,
      ratio: zoom / previous,
      lead: PAGE_GAP,
    });
  }, [layout, zoom]);
  const holdScroller = useCallback((node: HTMLDivElement | null) => {
    scrolling.current = node;
    setScroller(node);
  }, []);

  if (pdf === null || layout === null) {
    return null;
  }
  return (
    <div
      onScroll={(event) => {
        scrolled.current = {
          top: event.currentTarget.scrollTop,
          left: event.currentTarget.scrollLeft,
        };
      }}
      ref={holdScroller}
      style={{
        height: "100%",
        overflow: "auto",
        padding: PAGE_GAP,
        paddingBottom: PAGE_GAP + clearance,
      }}
    >
      {layout.ratios.map((ratio, index) => (
        <PdfPage
          height={ratio * layout.width * zoom}
          invert={invert}
          // Pages never reorder; the number is the page's identity.
          key={`page-${String(index + 1)}`}
          number={index + 1}
          onFailed={pageFailed}
          onPainted={pagePainted}
          pdf={pdf}
          scroller={scroller}
          width={layout.width * zoom}
        />
      ))}
    </div>
  );
};

const PdfPage = ({
  invert,
  pdf,
  number,
  width,
  height,
  scroller,
  onPainted,
  onFailed,
}: {
  invert: boolean;
  pdf: PDFDocumentProxy;
  number: number;
  width: number;
  height: number;
  scroller: HTMLDivElement | null;
  onPainted: () => void;
  onFailed: (error: unknown) => void;
}) => {
  const canvas = useRef<HTMLCanvasElement>(null);
  const painted = useEffectEvent(onPainted);
  const failed = useEffectEvent(onFailed);

  useEffect(() => {
    const element = canvas.current;
    if (element === null || scroller === null) {
      return undefined;
    }
    const drawing: { task: RenderTask | null } = { task: null };
    let drawn = false;
    // Counts releases, so a draw that outlived its page's release stops.
    let generation = 0;
    const draw = async () => {
      const started = generation;
      const page = await pdf.getPage(number);
      if (started !== generation) {
        return;
      }
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({
        scale: canvasScale({
          cssWidth: width,
          pageWidth: base.width,
          pageHeight: base.height,
          pixelRatio: window.devicePixelRatio,
        }),
      });
      element.width = Math.floor(viewport.width);
      element.height = Math.floor(viewport.height);
      drawing.task = page.render({ canvas: element, viewport });
      await drawing.task.promise;
      painted();
    };
    // An iPhone page's canvas holds several megabytes, so a page far from the
    // screen gives it back and draws again when it nears. A zero-sized canvas
    // keeps the page's place by its style.
    const release = () => {
      generation += 1;
      drawn = false;
      drawing.task?.cancel();
      drawing.task = null;
      element.width = 0;
      element.height = 0;
    };
    const near = new IntersectionObserver(
      (entries) => {
        if (drawn || !entries.some((entry) => entry.isIntersecting)) {
          return;
        }
        drawn = true;
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
      { root: scroller, rootMargin: "100% 0px" },
    );
    const far = new IntersectionObserver(
      (entries) => {
        if (drawn && !entries.some((entry) => entry.isIntersecting)) {
          release();
        }
      },
      // A screen beyond where pages draw, so a page at the edge does not
      // draw and release with every small scroll.
      { root: scroller, rootMargin: "200% 0px" },
    );
    near.observe(element);
    far.observe(element);
    return () => {
      near.disconnect();
      far.disconnect();
      drawing.task?.cancel();
    };
  }, [pdf, number, width, scroller]);

  return (
    <canvas
      ref={canvas}
      style={{
        background: "white",
        boxShadow: "0 0 0 1px var(--border)",
        display: "block",
        filter: invert ? DARK_PAGE_FILTER : "none",
        height,
        // A page narrower than the screen sits in its middle.
        margin: `0 auto ${String(PAGE_GAP)}px`,
        width,
      }}
    />
  );
};
