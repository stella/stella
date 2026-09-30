// The e2e tsconfig is node-only; the collector runs in the browser.
/// <reference lib="dom" />
import type { Page } from "@playwright/test";

/**
 * Missing chrome dividers and content borders on the same boundary,
 * described as `tag.class…`.
 *
 * The divider under the breadcrumb bar belongs to the app chrome: the shell's
 * top bar draws it once. A page that also draws a top border on its first row
 * stacks a second 1px line on the first, which reads as one heavy 2px rule.
 * The content slot takes the top border off its direct first child; this finds
 * the cases it cannot see, such as a nested layout's first pane.
 *
 * Runs inside the page, so it is self-contained: nothing from this module is
 * in scope there. Null when the page has no shell, which the caller reports
 * rather than reading as "exactly one divider".
 */
const collectChromeDividerProblems = (): string[] | null => {
  const topBar = document.querySelector(
    '[data-slot="workspace-shell-top-bar"]',
  );
  const content = document.querySelector(
    '[data-slot="workspace-shell-content"]',
  );
  if (topBar === null || content === null) {
    return null;
  }
  const dividerY = topBar.getBoundingClientRect().bottom;
  // Layout positions are fractional under zoom; half a pixel still lands on
  // the same device row as the divider.
  const tolerance = 0.5;
  // Computed colours serialise as rgb()/oklch()/lab(); a zero alpha is the
  // last argument after a comma or slash.
  const isInvisibleColor = (color: string) =>
    color === "transparent" || /[,/]\s*0(?:\.0+)?\)$/u.test(color);
  const describe = (element: Element) => {
    const classes = [...element.classList].slice(0, 6).join(".");
    return classes === ""
      ? element.tagName.toLowerCase()
      : `${element.tagName.toLowerCase()}.${classes}`;
  };

  const problems: string[] = [];
  const header = topBar.querySelector("header");
  const headerStyle = header === null ? null : getComputedStyle(header);
  const headerRect = header?.getBoundingClientRect();
  if (
    headerStyle === null ||
    headerRect === undefined ||
    headerRect.width === 0 ||
    headerRect.height === 0 ||
    Math.abs(headerRect.bottom - dividerY) > tolerance ||
    headerStyle.visibility !== "visible" ||
    headerStyle.borderBottomStyle === "none" ||
    headerStyle.borderBottomStyle === "hidden" ||
    !(Number.parseFloat(headerStyle.borderBottomWidth) > 0) ||
    isInvisibleColor(headerStyle.borderBottomColor)
  ) {
    problems.push("Missing visible chrome header bottom border");
  }
  for (const element of content.querySelectorAll("*")) {
    const rect = element.getBoundingClientRect();
    if (
      rect.width === 0 ||
      rect.height === 0 ||
      Math.abs(rect.top - dividerY) > tolerance
    ) {
      continue;
    }
    const style = getComputedStyle(element);
    if (
      style.visibility !== "visible" ||
      style.borderTopStyle === "none" ||
      style.borderTopStyle === "hidden" ||
      Number.parseFloat(style.borderTopWidth) === 0 ||
      isInvisibleColor(style.borderTopColor)
    ) {
      continue;
    }
    problems.push(describe(element));
  }
  return problems;
};

export const findChromeDividerProblems = async (
  page: Page,
): Promise<string[]> => {
  const problems = await page.evaluate(collectChromeDividerProblems);
  if (problems === null) {
    throw new Error(
      "No workspace shell on the page, so the chrome divider was not checked",
    );
  }
  return problems;
};
