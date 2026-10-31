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
  type ReachablePositions = { min: number; max: number };
  type ClipReachabilityOptions = {
    positions: ReachablePositions;
    min: number;
    max: number;
    scroll: { offset: number; min: number; max: number };
  };
  // Track possible control start positions, including movement through inner
  // scrollers. Every outer clip must still leave room for the whole control.
  const clipReachability = ({
    positions,
    min,
    max,
    scroll,
  }: ClipReachabilityOptions) => ({
    min: Math.max(positions.min + scroll.offset - scroll.max, min - tolerance),
    max: Math.min(positions.max + scroll.offset - scroll.min, max + tolerance),
  });
  const stationaryScroll = { offset: 0, min: 0, max: 0 };
  const containingBlockProperties = [
    "transform",
    "translate",
    "rotate",
    "scale",
    "perspective",
    "filter",
    "backdrop-filter",
  ];
  const containingBlockWillChange = new Set([
    ...containingBlockProperties,
    "contain",
    "transform-style",
    "content-visibility",
  ]);
  const establishesFixedContainingBlock = (element: Element) => {
    const style = getComputedStyle(element);
    return (
      containingBlockProperties.some((property) => {
        // A filter on the document root does not change fixed positioning.
        if (property === "filter" && element === document.documentElement) {
          return false;
        }
        const value = style.getPropertyValue(property);
        return value !== "" && value !== "none";
      }) ||
      style.transformStyle === "preserve-3d" ||
      style.contain
        .split(/\s+/u)
        .some((value) =>
          ["layout", "paint", "strict", "content"].includes(value),
        ) ||
      style.contentVisibility === "auto" ||
      style.contentVisibility === "hidden" ||
      style.willChange
        .split(",")
        .some((value) => containingBlockWillChange.has(value.trim()))
    );
  };
  const clippingAncestors = (element: Element) => {
    const ancestors: Element[] = [];
    for (let current = element; ;) {
      let parent = current.parentElement;
      if (getComputedStyle(current).position === "fixed") {
        // A fixed box escapes intervening overflow clips until its containing
        // block; a fixed ancestor's descendants follow the same boundary.
        while (parent !== null && !establishesFixedContainingBlock(parent)) {
          parent = parent.parentElement;
        }
        if (parent === null) {
          return { ancestors, root: "viewport" } as const;
        }
      }
      if (parent === null) {
        return { ancestors, root: "document" } as const;
      }
      if (parent !== document.body && parent !== document.documentElement) {
        ancestors.push(parent);
      }
      current = parent;
    }
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
  const clippingProblem = (element: Element, rect: DOMRect) => {
    let positionsX = { min: rect.left, max: rect.left };
    let positionsY = { min: rect.top, max: rect.top };
    const { ancestors, root } = clippingAncestors(element);
    let problem: string | null = null;
    for (const box of ancestors) {
      if (problem !== null) {
        break;
      }
      const style = getComputedStyle(box);
      const boxRect = box.getBoundingClientRect();
      if (style.overflowX !== "visible") {
        const range = box.scrollWidth - box.clientWidth;
        const rtl = style.direction === "rtl";
        const start = boxRect.left + box.clientLeft;
        positionsX = clipReachability({
          positions: positionsX,
          min: start,
          max: start + box.clientWidth - rect.width,
          scroll: isScrollable(style.overflowX)
            ? {
                offset: box.scrollLeft,
                min: rtl ? -range : 0,
                max: rtl ? 0 : range,
              }
            : stationaryScroll,
        });
        if (positionsX.min > positionsX.max) {
          problem = `${describe(element)} is cut off at the side of ${describe(box)}`;
        }
      }
      if (style.overflowY !== "visible" && problem === null) {
        const start = boxRect.top + box.clientTop;
        positionsY = clipReachability({
          positions: positionsY,
          min: start,
          max: start + box.clientHeight - rect.height,
          scroll: isScrollable(style.overflowY)
            ? {
                offset: box.scrollTop,
                min: 0,
                max: box.scrollHeight - box.clientHeight,
              }
            : stationaryScroll,
        });
        if (positionsY.min > positionsY.max) {
          problem = `${describe(element)} is cut off at the top or bottom of ${describe(box)}`;
        }
      }
    }
    positionsX = clipReachability({
      positions: positionsX,
      min: 0,
      max: window.innerWidth - rect.width,
      scroll: stationaryScroll,
    });
    if (problem === null && positionsX.min > positionsX.max) {
      problem = `${describe(element)} runs past the side of the screen`;
    }
    positionsY = clipReachability({
      positions: positionsY,
      min: 0,
      max: window.innerHeight - rect.height,
      scroll:
        root === "viewport" || rootClipsY
          ? stationaryScroll
          : {
              offset: window.scrollY,
              min: 0,
              max:
                Math.max(
                  document.documentElement.scrollHeight,
                  document.body.scrollHeight,
                  window.innerHeight,
                ) - window.innerHeight,
            },
    });
    if (problem === null && positionsY.min > positionsY.max) {
      problem =
        root === "viewport"
          ? `${describe(element)} sits in a fixed layer past the top or bottom of the screen`
          : `${describe(element)} sits past the top or bottom of a non-scrollable page`;
    }
    return problem;
  };
  const checkedControls = controls.map((control) => ({
    ...control,
    clippingProblem: clippingProblem(control.element, control.rect),
  }));
  const cutOff = checkedControls.flatMap(
    ({ opacity, visibility, clippingProblem: problem }) =>
      opacity === 0 || visibility !== "visible" || problem === null
        ? []
        : [problem],
  );

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
        clippingProblem(proxy, proxyRect) === null &&
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
  for (const {
    element,
    rect,
    opacity,
    visibility,
    clippingProblem: problem,
  } of checkedControls) {
    if (
      visibility === "visible" &&
      (opacity > 0.05 || hasVisibleProxy(element, rect))
    ) {
      continue;
    }
    if (problem !== null) {
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
