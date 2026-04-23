import { PAGE_ID_ATTRIBUTE } from "@/lib/pdf/consts";
import type { PageViewport } from "@/lib/pdf/pdfjs-loader";
import { approximateFraction, floorToMultiple } from "@/lib/pdf/pdfjs-utils";

export const getPageId = (instanceId: string, pageNumber: number): string =>
  `${instanceId}-page-${pageNumber}`;

export const getDevicePixelRatio = () => {
  if (typeof window.devicePixelRatio !== "number") {
    return 1;
  }

  return window.devicePixelRatio;
};

// this follows what mozilla pdf viewer does
export const getCanvasSize = (viewport: PageViewport) => {
  const dpr = getDevicePixelRatio();
  const [roundX] = approximateFraction(dpr);

  const width = floorToMultiple(Math.fround(viewport.width * dpr), roundX);
  const height = floorToMultiple(Math.fround(viewport.height * dpr), roundX);

  return { width, height };
};

// this follows what mozilla pdf viewer does
export const getCanvasTransform = () => {
  const dpr = getDevicePixelRatio();

  return [dpr, 0, 0, dpr, 0, 0];
};

export type ScrollAnchor = {
  pageId: string;
  ratio: number;
};

/**
 * Finds the page at the viewport top and captures the
 * fractional offset within it. Returns `null` when there
 * are no pages or the viewport is scrolled to the top.
 */
export const captureScrollAnchor = (
  viewport: HTMLElement,
): ScrollAnchor | null => {
  if (viewport.scrollTop <= 0) {
    return null;
  }

  const viewportRect = viewport.getBoundingClientRect();
  const pages = viewport.querySelectorAll<HTMLElement>(
    `[${PAGE_ID_ATTRIBUTE}]`,
  );

  for (const page of pages) {
    const rect = page.getBoundingClientRect();
    if (rect.bottom <= viewportRect.top) {
      continue;
    }

    const offsetInPage = viewportRect.top - rect.top;
    const ratio = rect.height > 0 ? offsetInPage / rect.height : 0;
    const pageId = page.getAttribute(PAGE_ID_ATTRIBUTE);
    if (pageId) {
      return { pageId, ratio };
    }
    break;
  }

  return null;
};

/**
 * Restores scroll position so that the anchored page and
 * fractional offset appear at the viewport top.
 */
export const restoreScrollAnchor = (
  viewport: HTMLElement,
  anchor: ScrollAnchor,
) => {
  const page = viewport.querySelector<HTMLElement>(
    `[${PAGE_ID_ATTRIBUTE}="${anchor.pageId}"]`,
  );
  if (!page) {
    return;
  }

  const viewportRect = viewport.getBoundingClientRect();
  const pageRect = page.getBoundingClientRect();
  const pageScrollPos = viewport.scrollTop + pageRect.top - viewportRect.top;
  viewport.scrollTop = pageScrollPos + anchor.ratio * pageRect.height;
};
