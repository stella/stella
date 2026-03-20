import type { PageViewport } from "pdfjs-dist";

import { PAGE_ID_ATTRIBUTE } from "@/lib/pdf/consts";
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

/**
 * Captures the current scroll position relative to the page at
 * the top of the viewport. Returns a restore function that, when
 * called after a scale change, scrolls the container so the same
 * relative position within that page stays at the viewport top.
 */
export const captureScrollPosition = (
  viewport: HTMLElement,
): (() => void) | null => {
  const pages = viewport.querySelectorAll<HTMLElement>(
    `[${PAGE_ID_ATTRIBUTE}]`,
  );

  if (pages.length === 0) {
    return null;
  }

  const scrollTop = viewport.scrollTop;

  // Find the page whose top edge is at or just above the
  // viewport top, and compute the fractional offset within it.
  let topPage: HTMLElement | null = null;
  let ratio = 0;

  for (const page of pages) {
    if (page.offsetTop + page.offsetHeight <= scrollTop) {
      continue;
    }
    topPage = page;
    const offsetWithinPage = scrollTop - page.offsetTop;
    ratio = page.offsetHeight > 0 ? offsetWithinPage / page.offsetHeight : 0;
    break;
  }

  if (!topPage) {
    return null;
  }

  const pageId = topPage.getAttribute(PAGE_ID_ATTRIBUTE);

  return () => {
    // After scale change, find the same page element and
    // apply the saved ratio to its new height.
    const updated = viewport.querySelector<HTMLElement>(
      `[${PAGE_ID_ATTRIBUTE}="${pageId}"]`,
    );

    if (!updated) {
      return;
    }

    viewport.scrollTop = updated.offsetTop + updated.offsetHeight * ratio;
  };
};
