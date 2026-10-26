/// <reference lib="dom" />
// The collector runs in the page; the DOM lib types it wherever it is checked.

/**
 * Text that must never reach a marketing capture: placeholder and fixture
 * markers that would show invented data as if it were the product's. The
 * capture scans each visible element's own text before it takes a screenshot.
 */

/** One visible element's own text, with where it sits on the page. */
export type CaptureTextElement = {
  descriptor: string;
  text: string;
};

/**
 * Each visible element's own text, read in the page: its text nodes, and for
 * a form field the text it shows (its value, or its placeholder while empty).
 * Self-contained, because `page.evaluate` runs it from its source; a DOM
 * without layout passes `checkLayout: false`.
 */
export const collectCaptureText = ({
  checkLayout,
}: {
  checkLayout: boolean;
}): CaptureTextElement[] => {
  const visible = (element: HTMLElement) => {
    if (!checkLayout) {
      return true;
    }
    const style = getComputedStyle(element);
    const bounds = element.getBoundingClientRect();
    return (
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      bounds.width > 0 &&
      bounds.height > 0
    );
  };
  const descriptorFor = (element: HTMLElement) => {
    const landmark = element.closest<HTMLElement>(
      "[id], [data-slot], [role], [aria-label], main, article, nav, aside, header, footer",
    );
    const described = landmark ?? element;
    if (described.id) {
      return `#${CSS.escape(described.id)}`;
    }
    for (const attribute of ["data-slot", "role", "aria-label"] as const) {
      const value = described.getAttribute(attribute);
      if (value) {
        return `${described.localName}[${attribute}=${JSON.stringify(value)}]`;
      }
    }
    return described.localName;
  };
  const shownText = (element: HTMLElement) => {
    if (
      element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement
    ) {
      // A password shows dots and a hidden input shows nothing; the
      // placeholder of either still shows while it is empty.
      const masked =
        element instanceof HTMLInputElement &&
        (element.type === "password" || element.type === "hidden");
      if (element.value.length > 0) {
        return masked ? "" : element.value;
      }
      return element instanceof HTMLInputElement && element.type === "hidden"
        ? ""
        : element.placeholder;
    }
    return [...element.childNodes]
      .filter((node) => node.nodeType === Node.TEXT_NODE)
      .map((node) => node.textContent ?? "")
      .join(" ");
  };
  return [...document.body.querySelectorAll<HTMLElement>("*")]
    .filter(visible)
    .flatMap((element) => {
      const text = shownText(element).replaceAll(/\s+/gu, " ").trim();
      return text ? [{ descriptor: descriptorFor(element), text }] : [];
    });
};

const wholeWord = (text: string) =>
  new RegExp(`(?<![\\p{L}\\p{N}_])${text}(?![\\p{L}\\p{N}_])`, "gu");

// The single owner of banned capture text. Matching is whole-word and
// case-sensitive, so real prose ("testament", "Barcelona", "Bar association")
// passes.
const BANNED_CAPTURE_TEXT = [
  // The prefix the development seed gives invented case numbers.
  { marker: "DEMO", pattern: wholeWord("DEMO") },
  // Uppercase fixture marker.
  { marker: "TEST", pattern: wholeWord("TEST") },
  // Placeholder prose, opener and continuation.
  { marker: "Lorem", pattern: wholeWord("Lorem") },
  { marker: "ipsum", pattern: wholeWord("ipsum") },
  // Copy that was never replaced.
  { marker: "placeholder", pattern: wholeWord("placeholder") },
  // The reserved example domain fixtures use.
  { marker: "example.com", pattern: wholeWord("example\\.com") },
  // Metasyntactic fixture values; lowercase only, so the proper noun Bar passes.
  { marker: "foo", pattern: wholeWord("foo") },
  { marker: "bar", pattern: wholeWord("bar") },
  // An unfinished implementation note.
  { marker: "TODO", pattern: wholeWord("TODO") },
  // The development corpus's own disclosure.
  { marker: "synthetic", pattern: wholeWord("synthetic") },
  // A whole case number in the shape seed-case-law-synthetic.ts generates.
  {
    marker: "synthetic case number",
    pattern:
      /(?<![\p{L}\p{N}_])DEMO\s+\d+\s+[\p{L}\p{N}]+\s+\d+\/\d{4}(?![\p{L}\p{N}_])/gu,
  },
] as const satisfies readonly { marker: string; pattern: RegExp }[];

export type CaptureTextViolation = {
  element: string;
  marker: (typeof BANNED_CAPTURE_TEXT)[number]["marker"];
  matchedText: string;
};

/** Every banned marker in the elements' text, with the element it sits in. */
export const findCaptureTextViolations = (
  elements: readonly CaptureTextElement[],
): CaptureTextViolation[] =>
  elements.flatMap(({ descriptor, text }) =>
    BANNED_CAPTURE_TEXT.flatMap(({ marker, pattern }) =>
      [...text.matchAll(pattern)].map(({ 0: matchedText }) => ({
        element: descriptor,
        marker,
        matchedText,
      })),
    ),
  );
