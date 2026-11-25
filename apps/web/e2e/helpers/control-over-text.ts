// The e2e tsconfig is node-only; the collector runs in the browser.
/// <reference lib="dom" />
import type { Locator, Page } from "@playwright/test";

/**
 * Controls painted over a textbox's text, described as
 * `button "label" covers text in tag.class…`.
 *
 * The rendered side of `no-control-beside-textbox`: the lint reads the
 * markup one file writes, so a row a wrapper component builds, or a control a
 * sibling component positions, escapes it. This measures what is painted
 * instead. A textbox's text is its text lines (an editor's, through a range
 * over its text) or its content box (a textarea's), each cut to what its
 * clipping ancestors (a scroll region) let show; a control is any visible
 * button. A control whose box crosses a visible text line covers the text,
 * whatever laid the two out.
 *
 * Runs inside the page, so it is self-contained: nothing from this module is
 * in scope there.
 */
const collectControlsOverText = (root: Element): string[] => {
  // Subpixel layout can put an edge a fraction past its neighbour.
  const tolerance = 1;
  type Box = { top: number; right: number; bottom: number; left: number };
  const intersect = (a: Box, b: Box): Box | null => {
    const box = {
      top: Math.max(a.top, b.top),
      right: Math.min(a.right, b.right),
      bottom: Math.min(a.bottom, b.bottom),
      left: Math.max(a.left, b.left),
    };
    return box.right - box.left > tolerance && box.bottom - box.top > tolerance
      ? box
      : null;
  };
  const visible = (element: Element) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return (
      rect.width > 0 &&
      rect.height > 0 &&
      style.visibility === "visible" &&
      Number.parseFloat(style.opacity) > 0 &&
      element.closest("[inert], [aria-hidden='true']") === null
    );
  };
  // The part of `box` its clipping ancestors (inside the scope) let show.
  const clipped = (element: Element, box: Box): Box | null => {
    let shown: Box | null = box;
    for (
      let ancestor = element.parentElement;
      ancestor !== null && shown !== null && ancestor !== root.parentElement;
      ancestor = ancestor.parentElement
    ) {
      const style = getComputedStyle(ancestor);
      if (style.overflowX === "visible" && style.overflowY === "visible") {
        continue;
      }
      shown = intersect(shown, ancestor.getBoundingClientRect());
    }
    return shown;
  };
  const describe = (element: Element) => {
    const classes = [...element.classList].slice(0, 6).join(".");
    return classes === ""
      ? element.tagName.toLowerCase()
      : `${element.tagName.toLowerCase()}.${classes}`;
  };
  const textLines = (textbox: Element): Box[] => {
    if (textbox instanceof HTMLTextAreaElement) {
      const style = getComputedStyle(textbox);
      const rect = textbox.getBoundingClientRect();
      const content = {
        top: rect.top + Number.parseFloat(style.paddingTop),
        right: rect.right - Number.parseFloat(style.paddingRight),
        bottom: rect.bottom - Number.parseFloat(style.paddingBottom),
        left: rect.left + Number.parseFloat(style.paddingLeft),
      };
      const shown = clipped(textbox, content);
      return shown === null ? [] : [shown];
    }
    const lines: Box[] = [];
    const range = document.createRange();
    const walker = document.createTreeWalker(textbox, NodeFilter.SHOW_TEXT);
    for (
      let node = walker.nextNode();
      node !== null;
      node = walker.nextNode()
    ) {
      if (
        (node.textContent?.trim() ?? "") === "" ||
        node.parentElement === null
      ) {
        continue;
      }
      range.selectNodeContents(node);
      for (const rect of range.getClientRects()) {
        const shown = clipped(node.parentElement, rect);
        if (shown !== null) {
          lines.push(shown);
        }
      }
    }
    return lines;
  };

  const textboxes = [
    ...root.querySelectorAll(
      "textarea, [contenteditable]:not([contenteditable='false'])",
    ),
  ].filter(
    (element) =>
      visible(element) &&
      // An editor's nested editable parts belong to the editor itself.
      (element.parentElement?.closest(
        "[contenteditable]:not([contenteditable='false'])",
      ) ?? null) === null,
  );
  const controls = [...root.querySelectorAll("button, [role='button']")].filter(
    visible,
  );
  const problems: string[] = [];
  for (const textbox of textboxes) {
    const lines = textLines(textbox);
    for (const control of controls) {
      // A chip's own control inside the text is part of the text.
      if (textbox.contains(control)) {
        continue;
      }
      const box = control.getBoundingClientRect();
      if (lines.some((line) => intersect(line, box) !== null)) {
        const label =
          control.getAttribute("aria-label") ??
          control.textContent.trim().slice(0, 30);
        problems.push(`button "${label}" covers text in ${describe(textbox)}`);
      }
    }
  }
  return problems;
};

/** Controls on the page, or inside one element, painted over a textbox's text. */
export const findControlsOverText = async (
  scope: Page | Locator,
): Promise<string[]> =>
  await ("goto" in scope ? scope.locator("body") : scope).evaluate(
    collectControlsOverText,
  );
