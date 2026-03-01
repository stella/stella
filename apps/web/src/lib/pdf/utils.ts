import type { PageViewport } from "pdfjs-dist";

import { EOC_CLASS_NAME, PAGE_NUMBER_ATTRIBUTE } from "@/lib/pdf/consts";
import { approximateFraction, floorToMultiple } from "@/lib/pdf/pdfjs-utils";

export const getOrderedPages = <T>(
  pages: T[],
  startIndex: number,
): { immediatePages: T[]; items: T[] } => {
  if (pages.length === 0) {
    return { immediatePages: [], items: [] };
  }

  const clamped = Math.max(0, Math.min(startIndex, pages.length - 1));

  // Current page ±1 render immediately
  const immediatePages: T[] = [];
  if (clamped > 0) {
    immediatePages.push(pages[clamped - 1]);
  }
  immediatePages.push(pages[clamped]);
  if (clamped < pages.length - 1) {
    immediatePages.push(pages[clamped + 1]);
  }

  // Build the rest in outward-spiral order
  const reordered: T[] = [];
  let offset = 2;

  while (reordered.length + immediatePages.length < pages.length) {
    const rightIndex = clamped + offset;

    if (rightIndex < pages.length) {
      reordered.push(pages[rightIndex]);
      if (reordered.length + immediatePages.length === pages.length) {
        break;
      }
    }

    const leftIndex = clamped - offset;

    if (leftIndex >= 0) {
      reordered.push(pages[leftIndex]);
    }

    offset += 1;
  }

  return { immediatePages, items: reordered };
};

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

// this follows what mozilla pdf viewer does
export const createEndOfContent = () => {
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
    `[${PAGE_NUMBER_ATTRIBUTE}]`,
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

  const pageNumber = topPage.getAttribute(PAGE_NUMBER_ATTRIBUTE);

  return () => {
    // After scale change, find the same page element and
    // apply the saved ratio to its new height.
    const updated = viewport.querySelector<HTMLElement>(
      `[${PAGE_NUMBER_ATTRIBUTE}="${pageNumber}"]`,
    );

    if (!updated) {
      return;
    }

    viewport.scrollTop = updated.offsetTop + updated.offsetHeight * ratio;
  };
};
