// Words in running text are marked one way: `@stll/ui/text-mark` owns the
// fill, the lines, the hues and the active state, so a search hit, a reader's
// highlight and a verdict underline cannot drift into three looks.
//
// Flagged:
//   <mark className="bg-warning/30">found</mark>     (render `TextMark`)
//   <p className="[&_mark]:bg-warning/30" />          (a hand-styled descendant)
//   <span className="bg-highlight/45" />              (the retired hit fill)
// Allowed:
//   <TextMark {...SEARCH_HIT_MARK}>found</TextMark>
//   <p className={cn("text-xs", SEARCH_HIT_DESCENDANT_MARK_CLASS)} />
//   <div className={textMarkClass({ variant: "fill", tone: "warning" })} />
//
// The owner module is out of scope, set in oxlint.config.ts. Every class string
// is tokenized, so a utility in a `cn()` argument or a variant map is read like
// one written on the element.

import { eslintCompatPlugin } from "@oxlint/plugins";

import { classBaseName, classTokens, classVariants, jsxName } from "./utils.ts";

type MessageId = "descendantMark" | "highlightFill";

const HIGHLIGHT_FILL = /^bg-highlight(?:\/\d+)?$/u;

const messageIdIn = (value: string): MessageId | undefined => {
  for (const token of classTokens(value)) {
    if (classVariants(token).includes("[&_mark]")) {
      return "descendantMark";
    }
    if (HIGHLIGHT_FILL.test(classBaseName(token))) {
      return "highlightFill";
    }
  }
  return undefined;
};

export default eslintCompatPlugin({
  meta: { name: "no-ad-hoc-text-mark" },
  rules: {
    "no-ad-hoc-text-mark": {
      meta: {
        type: "problem",
        messages: {
          rawMark:
            "Render `TextMark` from '@stll/ui/text-mark' instead of a " +
            "`<mark>`: it owns how words in running text are marked.",
          descendantMark:
            "Do not style `<mark>` descendants by hand. Use " +
            "`SEARCH_HIT_DESCENDANT_MARK_CLASS` from '@stll/ui/text-mark' " +
            "for markup that arrives already highlighted.",
          highlightFill:
            "`bg-highlight` is not a text mark. Use `TextMark` or " +
            "`textMarkClass` from '@stll/ui/text-mark'; search hits take " +
            "`SEARCH_HIT_MARK`.",
        },
      },
      createOnce(context) {
        return {
          JSXOpeningElement(node) {
            if (jsxName(node.name) === "mark") {
              context.report({ node, messageId: "rawMark" });
            }
          },
          Literal(node) {
            if (typeof node.value !== "string") {
              return;
            }
            const messageId = messageIdIn(node.value);
            if (messageId !== undefined) {
              context.report({ node, messageId });
            }
          },
          TemplateElement(node) {
            const messageId = messageIdIn(node.value.raw);
            if (messageId !== undefined) {
              context.report({ node, messageId });
            }
          },
        };
      },
    },
  },
});
