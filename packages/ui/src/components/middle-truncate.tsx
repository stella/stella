"use client";

import { cn } from "../lib/utils";
import { graphemesOf, splitForMiddleTruncate } from "./middle-truncate.logic";

type MiddleTruncateProps = {
  value: string;
  className?: string;
};

/**
 * One line of text that, when it does not fit, gives up its middle and keeps
 * its end: `Smlouva o dílo – revize…klienta.docx`. For names whose end tells
 * them apart (file names, versions, case numbers), where a trailing ellipsis
 * would cut exactly that part.
 *
 * The head clips after its last whole character and the tail slides over the
 * slack, so the ellipsis sits flush against the text instead of after a gap
 * or half a glyph. The ellipsis is generated content with empty alternative
 * text: the element's text and accessible name stay the full value.
 */
export const MiddleTruncate = ({ value, className }: MiddleTruncateProps) => {
  const split = splitForMiddleTruncate(value);
  if (split === null) {
    return (
      <span
        className={cn(
          "min-w-0 overflow-hidden text-ellipsis whitespace-pre [unicode-bidi:isolate]",
          className,
        )}
        dir="auto"
        title={value}
      >
        {value}
      </span>
    );
  }
  return (
    <span
      className={cn(
        "inline-flex max-w-full min-w-0 overflow-hidden whitespace-pre [unicode-bidi:isolate]",
        className,
      )}
      data-slot="middle-truncate"
      dir="auto"
      title={value}
    >
      <span
        className="peer min-w-0 overflow-hidden"
        // Either part can change the available head width.
        key={value}
        ref={fitHeadWhileMounted}
      >
        {split.head}
      </span>
      <span className="shrink-0 peer-data-overflow:before:content-['…'_/_'']">
        {split.tail}
      </span>
    </span>
  );
};

// Observes the root, not the head: showing the ellipsis resizes the head, and
// an observer that resizes its own target re-notifies within the frame and
// reports a ResizeObserver loop. The root keeps its width while the head and
// tail trade space inside it.
function fitHeadWhileMounted(head: HTMLSpanElement) {
  fitHead(head);
  const root = head.parentElement;
  if (!root) {
    return undefined;
  }
  let frame: number | undefined;
  const scheduleFit = () => {
    if (frame !== undefined) {
      return;
    }
    frame = requestAnimationFrame(() => {
      frame = undefined;
      fitHead(head);
    });
  };
  // The ellipsis can change intrinsic size; write after observer delivery.
  const observer = new ResizeObserver(scheduleFit);
  observer.observe(root);
  document.fonts.addEventListener("loadingdone", scheduleFit);
  return () => {
    observer.disconnect();
    document.fonts.removeEventListener("loadingdone", scheduleFit);
    if (frame !== undefined) {
      cancelAnimationFrame(frame);
    }
  };
}

/**
 * Cuts an overflowing head after its last whole grapheme: clips the partial
 * one and slides the tail over the slack. Measured from the inline-start edge,
 * so the cut is right in either direction. Clipping and translating do not
 * change layout, so the observed size stays the width the head is given.
 */
function fitHead(head: HTMLElement) {
  const tail = head.nextElementSibling;
  const text = head.firstChild;
  if (!(tail instanceof HTMLElement) || !(text instanceof Text)) {
    return;
  }
  // Measure without the ellipsis: it takes width from the head while shown,
  // so a stale one would keep the text cut after it fits again.
  delete head.dataset["overflow"];
  head.style.clipPath = "";
  tail.style.translate = "";
  if (head.scrollWidth <= head.clientWidth) {
    return;
  }
  head.dataset["overflow"] = "";

  const rtl = getComputedStyle(head).direction === "rtl";
  const box = head.getBoundingClientRect();
  const availableWidth = box.width;
  const range = document.createRange();
  const widthTo = (end: number) => {
    if (end === 0) {
      return 0;
    }
    range.setStart(text, 0);
    range.setEnd(text, end);
    const rect = range.getBoundingClientRect();
    return rtl ? box.right - rect.left : rect.right - box.left;
  };
  // Code-unit offset after each grapheme.
  const ends: number[] = [];
  let offset = 0;
  for (const grapheme of graphemesOf(text.data)) {
    offset += grapheme.length;
    ends.push(offset);
  }
  // The longest prefix of whole graphemes that fits.
  let fits = 0;
  let over = ends.length;
  while (over - fits > 1) {
    const middle = Math.floor((fits + over) / 2);
    if (widthTo(ends[middle - 1] ?? 0) <= availableWidth) {
      fits = middle;
    } else {
      over = middle;
    }
  }
  const slack = availableWidth - widthTo(ends[fits - 1] ?? 0);
  if (slack <= 0) {
    return;
  }
  head.style.clipPath = rtl
    ? `inset(-0.25em 0 -0.25em ${String(slack)}px)`
    : `inset(-0.25em ${String(slack)}px -0.25em 0)`;
  tail.style.translate = `${String(rtl ? slack : -slack)}px 0`;
}
