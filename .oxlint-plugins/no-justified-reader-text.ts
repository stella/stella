// Reader text is start-aligned: `reader.css` sets running text with the
// `reader-prose` class (`text-align: start`), so a right-to-left document
// aligns right. Justification stretches the word spaces of every line that
// holds a long unbreakable token (a case number, a file reference, a
// citation), and decision text is full of them.
//
// Every string in these modules is checked, not only the `className`
// attribute: utilities travel through `cn()`/`cva()` arguments, template
// literals and variant maps, and CSS travels in style strings. An inline
// style object is checked by its `textAlign`/`textAlignLast` property.
//
// Flagged:
//   <p className="text-justify">…</p>
//   <p className={cn("lg:text-justify", className)} />
//   <p style={{ textAlign: "justify" }} />
//   const css = "p { text-align: justify }";
// Allowed:
//   <p className="reader-prose">…</p>
//   <p className="text-center" />, <p style={{ textAlign: "start" }} />
//   `justify-between` and other flex/grid alignment: they set no text.
//
// Scoped by the config's file globs to the reader modules.

import { eslintCompatPlugin } from "@oxlint/plugins";

import { getPropertyName, isStringLiteral } from "./utils.ts";

// Class strings arrive as one attribute, a template, or a helper argument;
// splitting on whitespace and the punctuation around interpolations leaves
// the bare utilities.
const SPLIT = /[\s"'`{}()]+/u;

const JUSTIFIED_DECLARATION = /text-align(?:-last)?\s*:\s*justify/u;

const STYLE_ALIGNMENT_KEYS: ReadonlySet<string> = new Set([
  "textAlign",
  "textAlignLast",
]);

/** A Tailwind token stripped of its variant prefixes and `!` modifier. */
const baseClass = (token: string): string => {
  const withoutPrefix = token.startsWith("!") ? token.slice(1) : token;
  const bare = withoutPrefix.endsWith("!")
    ? withoutPrefix.slice(0, -1)
    : withoutPrefix;
  const lastVariant = bare.lastIndexOf(":");
  return lastVariant === -1 ? bare : bare.slice(lastVariant + 1);
};

const justifiesText = (value: string): boolean => {
  if (!value.includes("justify")) {
    return false;
  }
  return (
    JUSTIFIED_DECLARATION.test(value) ||
    value
      .split(SPLIT)
      .some((token) => token !== "" && baseClass(token) === "text-justify")
  );
};

const MESSAGE =
  "Reader text is start-aligned by `reader-prose` in reader.css. " +
  "Justification stretches the word spaces around long unbreakable tokens " +
  "(case numbers, file references, citations); drop this justified alignment.";

export default eslintCompatPlugin({
  meta: { name: "no-justified-reader-text" },
  rules: {
    "no-justified-reader-text": {
      meta: {
        type: "problem",
        messages: { justified: MESSAGE },
      },
      createOnce(context) {
        return {
          Literal(node) {
            if (typeof node.value === "string" && justifiesText(node.value)) {
              context.report({ node, messageId: "justified" });
            }
          },
          TemplateElement(node) {
            if (justifiesText(node.value.raw)) {
              context.report({ node, messageId: "justified" });
            }
          },
          Property(node) {
            const key = node.computed ? null : getPropertyName(node.key);
            if (key === null || !STYLE_ALIGNMENT_KEYS.has(key)) {
              return;
            }
            if (isStringLiteral(node.value) && node.value.value === "justify") {
              context.report({ node, messageId: "justified" });
            }
          },
        };
      },
    },
  },
});
