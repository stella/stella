// App chrome scrolls through `ScrollArea` (`@stll/ui/scroll-area`), not a raw
// scrolling overflow utility. The primitive owns the scrollbar: its width, its
// hover and idle states, its overlay behaviour, and the corner where two axes
// meet. A raw `overflow-y-auto` hands that to the platform, so one pane gets a
// macOS overlay bar, another a Windows gutter that shifts the layout, and the
// two sit side by side in the same shell.
//
// Invariant: every scrolling surface in `apps/web` and `packages/ui` is either
// a `ScrollArea` or a native scroller whose content requires one.
//
// Rejected: `overflow-auto`, `overflow-scroll`, and their `-x-`/`-y-` forms,
// under any variant prefix (`md:overflow-y-auto`,
// `group-data-[collapsed=true]/rail:overflow-y-auto`,
// `not-data-transitioning:overflow-y-auto`), including a variant that only
// mentions the exempt content without selecting it:
// `data-[layout=table]:overflow-auto` reads an attribute value and
// `[&:not(pre)]:overflow-auto` selects everything the exemption is for.
//
// Accepted:
//   `overflow-hidden`, `overflow-clip`, `overflow-visible` — no scroller.
//   an `[&…]` arbitrary selector that targets `pre`, `table`, or
//   `.ProseMirror` through a descendant (`_`) or child (`>`) combinator
//   (`[&_pre]`, `[&>table]`, `[&_.ProseMirror]`, `[&_pre_code]`): the scroller
//   lands on markup a renderer emits, which no wrapper component can reach.
//
// Analysis boundary: this reads class strings, not the DOM. Every string
// literal and template chunk in a scoped file is tokenized, so a utility in a
// `cn()` argument or a `cva` variant map is read like one written on the
// element, and a string that merely spells a utility is read as one. It
// reports the string, not the element, and says nothing about whether a
// `ScrollArea` is mounted elsewhere.

import { eslintCompatPlugin } from "@oxlint/plugins";

import { classBaseName, classTokens, classVariants } from "./utils.ts";

const SCROLLING_OVERFLOW = new Set([
  "overflow-auto",
  "overflow-scroll",
  "overflow-x-auto",
  "overflow-x-scroll",
  "overflow-y-auto",
  "overflow-y-scroll",
]);

// Content whose scroller the browser has to own: a code block, a wide table,
// and the editor surface are emitted by a renderer, so a caller reaches them
// only through a descendant selector.
const NATIVE_SCROLL_ELEMENTS = new Set(["pre", "table", ".ProseMirror"]);

// Tailwind spells the descendant combinator `_`; `>` is the child combinator.
const COMBINATORS = new Set(["_", ">"]);

// What an element name is made of. `.` is included so a class selector
// (`.ProseMirror`) reads as one name rather than a bare `ProseMirror`.
const isNameCharacter = (character: string): boolean =>
  (character >= "a" && character <= "z") ||
  (character >= "A" && character <= "Z") ||
  (character >= "0" && character <= "9") ||
  character === "-" ||
  character === ".";

// The bracketed selectors of a token's variant prefixes, scanned rather than
// matched: `/\[[^\]]*\]/g` re-walks the text it already consumed on every
// retry, which the repository's super-linear-regex ratchet rejects.
const arbitrarySelectors = (variants: string): string[] => {
  const selectors: string[] = [];
  let cursor = variants.indexOf("[");
  while (cursor !== -1) {
    const close = variants.indexOf("]", cursor + 1);
    if (close === -1) {
      return selectors;
    }
    selectors.push(variants.slice(cursor, close + 1));
    cursor = variants.indexOf("[", close + 1);
  }
  return selectors;
};

/**
 * Whether an `[&…]` arbitrary selector selects one of the native-content
 * elements, as opposed to merely naming it. The name has to follow a
 * combinator at the selector's own nesting level: inside a functional
 * pseudo-class (`[&:not(pre)]`) or an attribute value
 * (`data-[layout=table]`, `[&_[data-slot=table]]`) the word is a condition on
 * some other element, and the scroller still lands on chrome.
 */
const selectsNativeScrollContent = (selector: string): boolean => {
  const body = selector.slice(1, -1);
  if (!body.startsWith("&")) {
    return false;
  }
  let depth = 0;
  let index = 0;
  while (index < body.length) {
    const character = body.charAt(index);
    if (character === "(" || character === "[") {
      depth += 1;
      index += 1;
      continue;
    }
    if (character === ")" || character === "]") {
      depth -= 1;
      index += 1;
      continue;
    }
    if (depth !== 0 || !COMBINATORS.has(character)) {
      index += 1;
      continue;
    }
    let end = index + 1;
    while (end < body.length && isNameCharacter(body.charAt(end))) {
      end += 1;
    }
    if (NATIVE_SCROLL_ELEMENTS.has(body.slice(index + 1, end))) {
      return true;
    }
    index = end === index + 1 ? index + 1 : end;
  }
  return false;
};

const targetsNativeScrollContent = (variants: string): boolean =>
  arbitrarySelectors(variants).some(selectsNativeScrollContent);

const hasRawScrollingOverflow = (value: string): boolean =>
  classTokens(value).some(
    (token) =>
      SCROLLING_OVERFLOW.has(classBaseName(token)) &&
      !targetsNativeScrollContent(classVariants(token)),
  );

export default eslintCompatPlugin({
  meta: { name: "no-raw-overflow-scroll" },
  rules: {
    "no-raw-overflow-scroll": {
      meta: {
        type: "problem",
        messages: {
          rawOverflowScroll:
            "App chrome scrolls through ScrollArea from @stll/ui/scroll-area, " +
            "not a raw overflow-auto/scroll utility, so every scrollbar in the " +
            "shell looks and behaves the same way. Wrap the content in a " +
            "ScrollArea: `viewportRef` hands the scrolling element to a " +
            "virtualizer, an intersection observer, or scroll restoration, and " +
            'axis="vertical" keeps the horizontal bar off. Native scrolling ' +
            "stays legitimate for a textarea, a <pre>, an editor or document " +
            "canvas, and a horizontally scrolling table; those belong in " +
            "scripts/design-lint-baseline.json with that reason understood.",
        },
      },
      createOnce(context) {
        return {
          Literal(node) {
            if (typeof node.value !== "string") {
              return;
            }
            if (hasRawScrollingOverflow(node.value)) {
              context.report({ node, messageId: "rawOverflowScroll" });
            }
          },
          TemplateElement(node) {
            if (hasRawScrollingOverflow(node.value.raw)) {
              context.report({ node, messageId: "rawOverflowScroll" });
            }
          },
        };
      },
    },
  },
});
