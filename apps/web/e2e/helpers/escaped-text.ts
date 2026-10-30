// The e2e tsconfig is node-only; the collector runs in the browser.
/// <reference lib="dom" />
import type { Locator, Page } from "@playwright/test";

/**
 * Text painted outside the box it belongs to, described as
 * `"text…" escapes tag.class…`.
 *
 * A box is the nearest element around the text that the reader sees as one:
 * one with a border, a background or a shadow. Text that runs past its box
 * (a nowrap line in a card that does not stretch it, an unbroken URL, a label
 * wider than a fixed-width chip) reads as a broken layout wherever it happens,
 * whatever caused it. The text is measured as painted: every element on the
 * way up that clips its overflow (`truncate`, a scroll area, `sr-only`) cuts it
 * to its own box first, so an ellipsis inside the box passes, while a clipping
 * element that is itself wider than the box still escapes it.
 *
 * Runs inside the page, so it is self-contained: nothing from this module is
 * in scope there.
 */
const collectEscapedText = (root: Element): string[] => {
  // Layout positions are fractional under zoom; a pixel of slack keeps
  // subpixel glyph overhang from reading as an escape.
  const tolerance = 1;
  const isInvisibleColor = (color: string) =>
    color === "transparent" || /[,/]\s*0(?:\.0+)?\)$/u.test(color);
  const clipsAll = (style: CSSStyleDeclaration) =>
    style.contain.includes("paint") ||
    style.contain === "strict" ||
    style.contain === "content" ||
    style.clipPath !== "none";
  const drawsBox = (style: CSSStyleDeclaration) =>
    !isInvisibleColor(style.backgroundColor) ||
    style.boxShadow !== "none" ||
    (["Top", "Right", "Bottom", "Left"] as const).some(
      (side) =>
        style[`border${side}Style`] !== "none" &&
        style[`border${side}Style`] !== "hidden" &&
        Number.parseFloat(style[`border${side}Width`]) > 0 &&
        !isInvisibleColor(style[`border${side}Color`]),
    );
  const describe = (element: Element) => {
    const classes = [...element.classList].slice(0, 6).join(".");
    return classes === ""
      ? element.tagName.toLowerCase()
      : `${element.tagName.toLowerCase()}.${classes}`;
  };

  const problems: string[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const text = node.textContent?.trim() ?? "";
    const parent = node.parentElement;
    if (text === "" || parent === null) {
      continue;
    }
    range.selectNodeContents(node);
    let lines = [...range.getClientRects()].filter(
      (rect) => rect.width > 0 && rect.height > 0,
    );
    if (
      lines.length === 0 ||
      getComputedStyle(parent).visibility !== "visible"
    ) {
      continue;
    }
    // Up to the first box around the text, which it must stay inside; every
    // clip on the way cuts the painted lines to the clipping element first.
    for (
      let element: Element | null = parent;
      element !== null && element !== document.documentElement;
      element = element.parentElement
    ) {
      const style = getComputedStyle(element);
      const box = element.getBoundingClientRect();
      const clipX = clipsAll(style) || style.overflowX !== "visible";
      const clipY = clipsAll(style) || style.overflowY !== "visible";
      if (clipX || clipY) {
        lines = lines
          .map((line) => {
            const left = clipX ? Math.max(line.left, box.left) : line.left;
            const right = clipX ? Math.min(line.right, box.right) : line.right;
            const top = clipY ? Math.max(line.top, box.top) : line.top;
            const bottom = clipY
              ? Math.min(line.bottom, box.bottom)
              : line.bottom;
            return new DOMRect(left, top, right - left, bottom - top);
          })
          .filter((line) => line.width > 0 && line.height > 0);
        if (lines.length === 0) {
          break;
        }
      }
      if (!drawsBox(style)) {
        continue;
      }
      const escapes = lines.some(
        (line) =>
          line.left < box.left - tolerance ||
          line.right > box.right + tolerance ||
          line.top < box.top - tolerance ||
          line.bottom > box.bottom + tolerance,
      );
      if (escapes) {
        const snippet = text.length > 40 ? `${text.slice(0, 40)}…` : text;
        problems.push(`"${snippet}" escapes ${describe(element)}`);
      }
      break;
    }
  }
  return problems;
};

/** Text on the page, or inside one element, painted outside its box. */
export const findEscapedText = async (
  scope: Page | Locator,
): Promise<string[]> =>
  await ("goto" in scope ? scope.locator("body") : scope).evaluate(
    collectEscapedText,
  );
