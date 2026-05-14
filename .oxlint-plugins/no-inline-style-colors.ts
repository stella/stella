// Detect hardcoded color values in ANY string literal inside style objects
// or config props. Flags hex colors (#fff, #000000), named colors (white,
// black), and color functions (rgb, rgba, hsl, hsla) regardless of
// property name — catching border shorthands, boxShadow, custom props, etc.
//
// Safe: var(--token), transparent, inherit, currentColor, none, unset, initial.

import { getPropertyName } from "./utils.ts";

// Hex color pattern anywhere in a string
const HEX_IN_STRING = /#[0-9a-f]{3,8}\b/i;

// rgb/rgba/hsl/hsla function anywhere in a string
const COLOR_FUNC_IN_STRING = /\b(?:rgb|rgba|hsl|hsla)\s*\(/i;

// Named colors that break dark mode (as whole words)
const NAMED_COLOR_PATTERN = /\b(?:white|black|red|blue|green|gray|grey)\b/i;

// CSS properties that contain "white", "black", etc. as substrings but
// are not colors — strip these before running the named-color check.
const CSS_PROP_FALSE_POSITIVES = /\bwhite-space\b/gi;

// Strings that are entirely safe — skip these
function isSafe(value: string): boolean {
  if (value.startsWith("var(")) {
    return true;
  }
  const lower = value.toLowerCase().trim();
  if (
    lower === "transparent" ||
    lower === "inherit" ||
    lower === "currentcolor" ||
    lower === "unset" ||
    lower === "initial" ||
    lower === "none" ||
    lower === "auto"
  ) {
    return true;
  }
  return false;
}

// Strip var(...) expressions (including nested parens) so that colors
// used as fallbacks inside CSS custom-property references are not flagged.
function stripVarExpressions(value: string): string {
  let result = "";
  let i = 0;
  while (i < value.length) {
    // Look for "var("
    if (value[i] === "v" && value.slice(i, i + 4) === "var(") {
      // Skip past the matching closing paren
      let depth = 1;
      i += 4; // skip "var("
      while (i < value.length && depth > 0) {
        if (value[i] === "(") {
          depth++;
        } else if (value[i] === ")") {
          depth--;
        }
        i++;
      }
    } else {
      result += value[i];
      i++;
    }
  }
  return result;
}

function containsHardcodedColor(value: string): string | null {
  if (isSafe(value)) {
    return null;
  }

  // Strip var(...) expressions so fallback colors inside them are not flagged
  const stripped = stripVarExpressions(value);

  // Check for hex colors
  const hexMatch = HEX_IN_STRING.exec(stripped);
  if (hexMatch) {
    return hexMatch[0];
  }

  // Check for color functions
  const funcMatch = COLOR_FUNC_IN_STRING.exec(stripped);
  if (funcMatch) {
    return funcMatch[0];
  }

  // Check for named colors — first remove CSS property false positives
  const sanitized = stripped.replace(CSS_PROP_FALSE_POSITIVES, "");
  const namedMatch = NAMED_COLOR_PATTERN.exec(sanitized);
  if (namedMatch) {
    return namedMatch[0];
  }

  return null;
}

export default {
  meta: { name: "no-inline-style-colors" },
  rules: {
    "no-inline-style-colors": {
      meta: {
        type: "problem",
        messages: {
          inlineColor:
            "Hardcoded color '{{match}}' in '{{prop}}' breaks dark mode. " +
            "Use a CSS variable or Tailwind class instead.",
        },
      },
      create(context) {
        return {
          // Check every Property node — any object property with a
          // string value containing a hardcoded color is flagged.
          Property(node) {
            const propName = getPropertyName(node.key) ?? "?";

            const val = node.value;
            if (val.type !== "Literal" || typeof val.value !== "string") {
              return;
            }

            const match = containsHardcodedColor(val.value);
            if (match) {
              context.report({
                node: val,
                messageId: "inlineColor",
                data: { match, prop: propName },
              });
            }
          },
        };
      },
    },
  },
};
