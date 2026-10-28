// The e2e tsconfig is node-only; the collector runs in the browser.
/// <reference lib="dom" />
import type { Page } from "@playwright/test";

/**
 * Layout rules every page must keep on a phone, as readable problem lines.
 *
 * - The page never scrolls sideways.
 * - No control is cut off: when a control runs past the edge of a box that
 *   clips it (or past the screen), that box must scroll so it can be reached.
 * - Touch targets are at least 24×24 px (WCAG 2.5.8), counting the hit area a
 *   pseudo-element adds, unless nothing else is within reach of them.
 * - No control is invisible until hovered: a touch screen has no hover.
 *
 * Runs inside the page, so it is self-contained: nothing from this module is
 * in scope there.
 */
const collectPhoneLayoutProblems = (): string[] => {
  // Layout positions are fractional under zoom; a pixel of slack absorbs it.
  const tolerance = 1;
  const minTarget = 24;
  const listedPerRule = 8;
  const interactiveSelector = [
    "a[href]",
    "button",
    "input:not([type='hidden'])",
    "select",
    "textarea",
    "summary",
    "[role='button']",
    "[role='link']",
    "[role='tab']",
    "[role='checkbox']",
    "[role='switch']",
    "[role='radio']",
    "[role='menuitem']",
    "[role='combobox']",
  ].join(",");
  const formFieldTags = new Set(["INPUT", "SELECT", "TEXTAREA"]);

  const describe = (element: Element) => {
    const tag = element.tagName.toLowerCase();
    const slot =
      element instanceof HTMLElement ? element.dataset["slot"] : undefined;
    const name = (
      element.getAttribute("aria-label") ??
      element.getAttribute("title") ??
      element.textContent
    )
      .replaceAll(/\s+/gu, " ")
      .trim()
      .slice(0, 40);
    return `${tag}${slot === undefined ? "" : `[data-slot=${slot}]`}${name === "" ? "" : ` "${name}"`}`;
  };
  const effectiveOpacity = (element: Element) => {
    let opacity = 1;
    for (
      let current: Element | null = element;
      current !== null;
      current = current.parentElement
    ) {
      opacity *= Number.parseFloat(getComputedStyle(current).opacity);
    }
    return opacity;
  };
  const isScrollable = (overflow: string) =>
    overflow === "auto" || overflow === "scroll";
  // Buttons widen their hit area on touch with an absolutely positioned
  // pseudo-element; the target is whichever is larger.
  const targetSize = (element: Element, rect: DOMRect) => {
    let width = rect.width;
    let height = rect.height;
    for (const pseudo of ["::before", "::after"]) {
      const style = getComputedStyle(element, pseudo);
      if (style.content === "none" || style.position !== "absolute") {
        continue;
      }
      width = Math.max(
        width,
        Number.parseFloat(style.width) || 0,
        Number.parseFloat(style.minWidth) || 0,
      );
      height = Math.max(
        height,
        Number.parseFloat(style.height) || 0,
        Number.parseFloat(style.minHeight) || 0,
      );
    }
    return { width, height };
  };

  const controls = [...document.querySelectorAll(interactiveSelector)].flatMap(
    (element) => {
      const rect = element.getBoundingClientRect();
      // One-pixel boxes are visually hidden on purpose (sr-only, native
      // inputs behind a styled control).
      if (rect.width <= 1 || rect.height <= 1) {
        return [];
      }
      if (element.closest("[aria-hidden='true'],[inert]") !== null) {
        return [];
      }
      if (getComputedStyle(element).visibility !== "visible") {
        return [];
      }
      return [{ element, rect, opacity: effectiveOpacity(element) }];
    },
  );

  const sideways: string[] = [];
  const pageWidth = document.documentElement.scrollWidth;
  if (pageWidth > window.innerWidth + tolerance) {
    sideways.push(
      `page is ${pageWidth}px wide on a ${window.innerWidth}px screen, so it scrolls sideways`,
    );
  }

  const cutOff: string[] = [];
  for (const { element, rect, opacity } of controls) {
    if (opacity === 0) {
      continue;
    }
    let reachableX = false;
    let reachableY = false;
    let fixed = getComputedStyle(element).position === "fixed";
    let problem: string | null = null;
    for (
      let box = element.parentElement;
      box !== null &&
      box !== document.body &&
      box !== document.documentElement &&
      problem === null;
      box = box.parentElement
    ) {
      const style = getComputedStyle(box);
      const boxRect = box.getBoundingClientRect();
      if (!reachableX && style.overflowX !== "visible") {
        const outside =
          rect.left < boxRect.left - tolerance ||
          rect.right > boxRect.right + tolerance;
        // Wholly outside is a collapsed or off-canvas region, not a cut.
        const overlaps = rect.right > boxRect.left && rect.left < boxRect.right;
        if (outside) {
          if (
            isScrollable(style.overflowX) &&
            box.scrollWidth > box.clientWidth
          ) {
            reachableX = true;
          } else if (overlaps) {
            problem = `${describe(element)} is cut off at the side of ${describe(box)}`;
          }
        }
      }
      if (!reachableY && style.overflowY !== "visible" && problem === null) {
        const outside =
          rect.top < boxRect.top - tolerance ||
          rect.bottom > boxRect.bottom + tolerance;
        const overlaps = rect.bottom > boxRect.top && rect.top < boxRect.bottom;
        if (outside) {
          if (
            isScrollable(style.overflowY) &&
            box.scrollHeight > box.clientHeight
          ) {
            reachableY = true;
          } else if (overlaps) {
            problem = `${describe(element)} is cut off at the top or bottom of ${describe(box)}`;
          }
        }
      }
      fixed ||= style.position === "fixed";
    }
    if (
      problem === null &&
      !reachableX &&
      (rect.left < -tolerance || rect.right > window.innerWidth + tolerance)
    ) {
      problem = `${describe(element)} runs past the side of the screen`;
    }
    // The page scrolls vertically, so only fixed layers can strand a control
    // below or above the screen.
    if (
      problem === null &&
      !reachableY &&
      fixed &&
      (rect.top < -tolerance || rect.bottom > window.innerHeight + tolerance)
    ) {
      problem = `${describe(element)} sits in a fixed layer past the top or bottom of the screen`;
    }
    if (problem !== null) {
      cutOff.push(problem);
    }
  }

  const sized = controls
    .filter(
      ({ element, opacity }) =>
        opacity > 0 &&
        // Links inside running text are exempt from the target size rule.
        !(
          element.tagName === "A" &&
          getComputedStyle(element).display === "inline"
        ),
    )
    .map((control) => ({
      ...control,
      size: targetSize(control.element, control.rect),
    }));
  const small: string[] = [];
  for (const target of sized) {
    const { width, height } = target.size;
    if (width >= minTarget && height >= minTarget) {
      continue;
    }
    // WCAG spacing exception: a small target passes when a 24px circle on its
    // centre touches no other target.
    const centerX = target.rect.left + target.rect.width / 2;
    const centerY = target.rect.top + target.rect.height / 2;
    const crowdedBy = sized.find((other) => {
      if (
        other === target ||
        other.element.contains(target.element) ||
        target.element.contains(other.element)
      ) {
        return false;
      }
      const nearestX = Math.max(
        other.rect.left,
        Math.min(centerX, other.rect.right),
      );
      const nearestY = Math.max(
        other.rect.top,
        Math.min(centerY, other.rect.bottom),
      );
      return Math.hypot(centerX - nearestX, centerY - nearestY) < minTarget / 2;
    });
    if (crowdedBy !== undefined) {
      small.push(
        `${describe(target.element)} is a ${Math.round(width)}×${Math.round(height)}px target next to ${describe(crowdedBy.element)}`,
      );
    }
  }

  const hoverOnly: string[] = [];
  for (const { element, rect, opacity } of controls) {
    // Native file and form inputs are laid transparently over a styled
    // control on purpose; tapping them works.
    if (opacity > 0.05 || formFieldTags.has(element.tagName)) {
      continue;
    }
    if (
      rect.right <= 0 ||
      rect.left >= window.innerWidth ||
      rect.bottom <= 0 ||
      rect.top >= window.innerHeight
    ) {
      continue;
    }
    hoverOnly.push(`${describe(element)} is invisible until hovered`);
  }

  const summarize = (rule: string, lines: string[]) => {
    const unique = [...new Set(lines)];
    if (unique.length === 0) {
      return [];
    }
    const listed = unique.slice(0, listedPerRule);
    const more = unique.length - listed.length;
    return [
      `${rule}:`,
      ...listed.map((line) => `  ${line}`),
      ...(more > 0 ? [`  …and ${more} more`] : []),
    ];
  };
  return [
    ...summarize("sideways scroll", sideways),
    ...summarize("cut-off controls", cutOff),
    ...summarize("small touch targets", small),
    ...summarize("hover-only controls", hoverOnly),
  ];
};

export const findPhoneLayoutProblems = async (page: Page): Promise<string[]> =>
  await page.evaluate(collectPhoneLayoutProblems);
