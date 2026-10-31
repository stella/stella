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
  type ScrollReachabilityOptions = {
    box: Element;
    boxRect: DOMRect;
    rect: DOMRect;
    style: CSSStyleDeclaration;
  };
  const scrollReachability = ({
    box,
    boxRect,
    rect,
    style,
  }: ScrollReachabilityOptions) => {
    const horizontalRange = box.scrollWidth - box.clientWidth;
    const originX = boxRect.left + box.clientLeft;
    // scrollLeft is negative in RTL: the reachable origin is the right edge.
    const left = originX - (style.direction === "rtl" ? horizontalRange : 0);
    const right =
      originX +
      box.clientWidth +
      (style.direction === "rtl" ? 0 : horizontalRange);
    const top = boxRect.top + box.clientTop;
    return {
      x:
        isScrollable(style.overflowX) &&
        horizontalRange > 0 &&
        rect.left + box.scrollLeft >= left - tolerance &&
        rect.right + box.scrollLeft <= right + tolerance,
      y:
        isScrollable(style.overflowY) &&
        box.scrollHeight > box.clientHeight &&
        rect.top + box.scrollTop >= top - tolerance &&
        rect.bottom + box.scrollTop <= top + box.scrollHeight + tolerance,
    };
  };
  // Buttons widen their hit area on touch with an absolutely positioned
  // pseudo-element; the target is whichever is larger.
  const targetSize = (element: Element, rect: DOMRect) => {
    let width = rect.width;
    let height = rect.height;
    for (const pseudo of ["::before", "::after"]) {
      const style = getComputedStyle(element, pseudo);
      if (
        style.content === "none" ||
        style.position !== "absolute" ||
        style.pointerEvents === "none"
      ) {
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
      // Inherited visibility hides a whole region (for example a closed menu).
      // A control hidden on its own still needs the hover-only check.
      const visibility = getComputedStyle(element).visibility;
      if (
        visibility !== "visible" &&
        element.parentElement !== null &&
        getComputedStyle(element.parentElement).visibility !== "visible"
      ) {
        return [];
      }
      return [
        {
          element,
          rect,
          opacity: effectiveOpacity(element),
          visibility,
        },
      ];
    },
  );

  const sideways: string[] = [];
  const pageWidth = document.documentElement.scrollWidth;
  if (pageWidth > window.innerWidth + tolerance) {
    sideways.push(
      `page is ${pageWidth}px wide on a ${window.innerWidth}px screen, so it scrolls sideways`,
    );
  }

  const rootClipsY = [document.documentElement, document.body].some((root) => {
    const overflow = getComputedStyle(root).overflowY;
    return overflow === "hidden" || overflow === "clip";
  });
  const cutOff: string[] = [];
  for (const { element, rect, opacity, visibility } of controls) {
    if (opacity === 0 || visibility !== "visible") {
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
      const reachable = scrollReachability({ box, boxRect, rect, style });
      if (!reachableX && style.overflowX !== "visible") {
        const outside =
          rect.left < boxRect.left - tolerance ||
          rect.right > boxRect.right + tolerance;
        if (outside) {
          if (reachable.x) {
            reachableX = true;
          } else {
            problem = `${describe(element)} is cut off at the side of ${describe(box)}`;
          }
        }
      }
      if (!reachableY && style.overflowY !== "visible" && problem === null) {
        const outside =
          rect.top < boxRect.top - tolerance ||
          rect.bottom > boxRect.bottom + tolerance;
        if (outside) {
          if (reachable.y) {
            reachableY = true;
          } else {
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
    if (
      problem === null &&
      !reachableY &&
      (fixed || rootClipsY) &&
      (rect.top < -tolerance || rect.bottom > window.innerHeight + tolerance)
    ) {
      problem = fixed
        ? `${describe(element)} sits in a fixed layer past the top or bottom of the screen`
        : `${describe(element)} sits past the top or bottom of a non-scrollable page`;
    }
    if (problem !== null) {
      cutOff.push(problem);
    }
  }

  const sized = controls
    .filter(
      ({ element, opacity, visibility }) =>
        opacity > 0 &&
        visibility === "visible" &&
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
    // centre touches neither another target nor another small target's circle.
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
      if (Math.hypot(centerX - nearestX, centerY - nearestY) < minTarget / 2) {
        return true;
      }
      if (other.size.width >= minTarget && other.size.height >= minTarget) {
        return false;
      }
      const otherCenterX = other.rect.left + other.rect.width / 2;
      const otherCenterY = other.rect.top + other.rect.height / 2;
      return (
        Math.hypot(centerX - otherCenterX, centerY - otherCenterY) < minTarget
      );
    });
    if (crowdedBy !== undefined) {
      small.push(
        `${describe(target.element)} is a ${Math.round(width)}×${Math.round(height)}px target next to ${describe(crowdedBy.element)}`,
      );
    }
  }

  const hasVisibleProxy = (element: Element, rect: DOMRect) => {
    if (
      !(element instanceof HTMLInputElement) &&
      !(element instanceof HTMLSelectElement) &&
      !(element instanceof HTMLTextAreaElement)
    ) {
      return false;
    }
    const visible = (proxy: Element) => {
      const style = getComputedStyle(proxy);
      const proxyRect = proxy.getBoundingClientRect();
      return (
        style.visibility === "visible" &&
        effectiveOpacity(proxy) > 0.05 &&
        proxyRect.width > 1 &&
        proxyRect.height > 1 &&
        proxyRect.right > 0 &&
        proxyRect.left < window.innerWidth &&
        proxyRect.bottom > 0 &&
        proxyRect.top < window.innerHeight &&
        (proxy.textContent.trim() !== "" ||
          style.backgroundImage !== "none" ||
          (style.backgroundColor !== "rgba(0, 0, 0, 0)" &&
            style.backgroundColor !== "transparent") ||
          proxy.matches("img,svg,canvas,video") ||
          proxy.querySelector("img,svg,canvas,video") !== null)
      );
    };
    // A visible associated label can activate a transparent field even when
    // it is beside it; an unrelated label cannot stand in for that field.
    if ([...(element.labels ?? [])].some(visible)) {
      return true;
    }
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    // Painted siblings may use pointer-events:none so the native field above
    // them receives the tap; hit testing alone omits those visual proxies.
    const proxies = new Set([
      ...document.elementsFromPoint(centerX, centerY),
      ...(element.parentElement?.children ?? []),
    ]);
    return [...proxies].some((proxy) => {
      const proxyRect = proxy.getBoundingClientRect();
      return (
        proxy !== element &&
        !proxy.contains(element) &&
        centerX >= proxyRect.left &&
        centerX <= proxyRect.right &&
        centerY >= proxyRect.top &&
        centerY <= proxyRect.bottom &&
        visible(proxy)
      );
    });
  };
  const hoverOnly: string[] = [];
  for (const { element, rect, opacity, visibility } of controls) {
    if (
      visibility === "visible" &&
      (opacity > 0.05 || hasVisibleProxy(element, rect))
    ) {
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
