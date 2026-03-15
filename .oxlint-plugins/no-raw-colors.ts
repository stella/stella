// Detect hardcoded Tailwind color classes that break dark mode.
//
// Semantic tokens (bg-background, bg-muted, text-foreground, …)
// adapt via CSS variables. Raw palette colors (bg-stone-50,
// text-gray-900, bg-white, …) produce unreadable contrast in the
// opposite theme.
//
// Replaces: scripts/lint-colors.sh

const GRAY_SCALES = "stone|slate|gray|zinc|neutral";

// All utility prefixes that take color values
const COLOR_PREFIXES =
  "bg|text|border|ring|outline|shadow|from|to|via|fill|stroke|divide";

const GRAY_PATTERN = new RegExp(
  `(?:${COLOR_PREFIXES})-(?:${GRAY_SCALES})-\\d`,
);

// standalone white/black utilities (not bg-white/20 opacity)
const BW_PATTERN = new RegExp(
  `(?:${COLOR_PREFIXES})-(?:white|black)(?![/\\w-])`,
);

const isRawColorClass = (value: string): boolean =>
  GRAY_PATTERN.test(value) || BW_PATTERN.test(value);

function checkValue(context, node, value: string) {
  for (const token of value.split(/\s+/)) {
    if (isRawColorClass(token)) {
      context.report({
        node,
        messageId: "rawColor",
        data: { match: token },
      });
    }
  }
}

export default {
  meta: { name: "no-raw-colors" },
  rules: {
    "no-raw-colors": {
      meta: {
        type: "problem",
        messages: {
          rawColor:
            "Hardcoded color '{{match}}' breaks dark mode. " +
            "Use semantic tokens (bg-muted, text-foreground, " +
            "bg-background, etc.) instead.",
        },
      },
      create(context) {
        return {
          Literal(node) {
            if (typeof node.value !== "string") return;
            checkValue(context, node, node.value);
          },
          TemplateElement(node) {
            checkValue(context, node, node.value.raw);
          },
        };
      },
    },
  },
};
