// The public-law readers get their face from `reader.css`: the reader root
// sets `--reader-body-font` (Source Serif 4) on the document, and everything
// inside inherits it. A Tailwind `font-sans`/`font-serif`/`font-mono` utility
// in a reader module overrides that inheritance for one element, so a title
// block ends up in the UI sans while the body it belongs to runs in the
// serif — two faces in one heading, which is what a reader notices first.
//
// Chrome drawn inside the text (page markers, the reference line, table
// bodies, toolbars, preview cards, controls) is sans on purpose and says so
// with the named `reader-chrome` class, which `reader.css` defines once.
// Document text that cannot inherit the serif — a provision quoted in a
// preview card, which portals out of the reader — takes `reader-body`.
//
// Every class string in these modules is checked, not only the `className`
// attribute: the utilities travel through `cn()`/`cva()` arguments, template
// literals and variant maps (`HEADING_CLASS`) just as often as they are
// written on the element.
//
// Flagged:
//   <p className="font-sans text-xs">…</p>
//   <span className={cn("font-serif", className)} />
//   <div className={`md:font-mono ${extra}`} />
// Allowed:
//   <p className="reader-chrome text-xs">…</p>
//   <span className="reader-body" />
//   weights and sizes (`font-semibold`, `font-medium`): they name no family.
//
// Scoped by the config's file globs to the reader modules; the rest of the
// app names its face freely.

import { eslintCompatPlugin } from "@oxlint/plugins";

// Class strings arrive as one attribute, a template, or a helper argument;
// splitting on whitespace and the punctuation around interpolations leaves
// the bare utilities.
const SPLIT = /[\s"'`{}()]+/u;

const FONT_FAMILY_UTILITIES: ReadonlySet<string> = new Set([
  "font-sans",
  "font-serif",
  "font-mono",
]);

/**
 * A Tailwind token stripped of its variant prefixes and `!` modifier.
 *
 * Sliced rather than matched: the important modifier is one character on
 * either end, and a quantified pattern here would be a backtracking regex in
 * a hot path.
 */
const baseClass = (token: string): string => {
  const withoutPrefix = token.startsWith("!") ? token.slice(1) : token;
  const bare = withoutPrefix.endsWith("!")
    ? withoutPrefix.slice(0, -1)
    : withoutPrefix;
  const lastVariant = bare.lastIndexOf(":");
  return lastVariant === -1 ? bare : bare.slice(lastVariant + 1);
};

const namesFontFamily = (value: string): boolean =>
  value
    .split(SPLIT)
    .filter(Boolean)
    .some((token) => FONT_FAMILY_UTILITIES.has(baseClass(token)));

export default eslintCompatPlugin({
  meta: { name: "no-font-utility-in-reader" },
  rules: {
    "no-font-utility-in-reader": {
      meta: {
        type: "problem",
        messages: {
          fontUtility:
            "The reader's face comes from reader.css (--reader-body-font) and " +
            "every element inherits it. Drop this font-sans/font-serif/" +
            "font-mono utility: UI chrome inside the reader takes the named " +
            "`reader-chrome` class, and document text rendered outside the " +
            "reader root takes `reader-body`.",
        },
      },
      createOnce(context) {
        return {
          Literal(node) {
            if (typeof node.value !== "string") {
              return;
            }
            if (namesFontFamily(node.value)) {
              context.report({ node, messageId: "fontUtility" });
            }
          },
          TemplateElement(node) {
            if (namesFontFamily(node.value.raw)) {
              context.report({ node, messageId: "fontUtility" });
            }
          },
        };
      },
    },
  },
});
