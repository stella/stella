// Detect hardcoded color values in JSX style object literals. Flags hex
// colors (#fff, #000000), named colors (white, black), and color functions
// (rgb, rgba, hsl, hsla) regardless of property name, catching border
// shorthands, boxShadow, custom props, etc.
//
// Safe: var(--token), transparent, inherit, currentColor, none, unset, initial.

import { eslintCompatPlugin, type ESTree } from "@oxlint/plugins";

import { getPropertyName, isAstNode, unwrapExpression } from "./utils.ts";

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

function getStaticStyleValue(value: ESTree.Expression): string | undefined {
  if (value.type === "Literal" && typeof value.value === "string") {
    return value.value;
  }
  if (value.type !== "TemplateLiteral" || value.expressions.length > 0) {
    return undefined;
  }
  const quasi = value.quasis.at(0);
  return quasi?.value.cooked ?? quasi?.value.raw;
}

const isObjectExpression = (node: unknown): node is ESTree.ObjectExpression =>
  isAstNode(node) && node.type === "ObjectExpression";

export default eslintCompatPlugin({
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
      createOnce(context) {
        const checkStyleObject = (styleObject: ESTree.ObjectExpression) => {
          for (const property of styleObject.properties) {
            if (property.type !== "Property") {
              continue;
            }

            const value = property.value;
            const staticValue = getStaticStyleValue(value);
            if (staticValue === undefined) {
              continue;
            }

            const match = containsHardcodedColor(staticValue);
            if (match === null) {
              continue;
            }

            context.report({
              node: value,
              messageId: "inlineColor",
              data: {
                match,
                prop: getPropertyName(property.key) ?? "?",
              },
            });
          }
        };

        return {
          JSXAttribute(node) {
            if (
              node.name.type !== "JSXIdentifier" ||
              node.name.name !== "style" ||
              node.value?.type !== "JSXExpressionContainer"
            ) {
              return;
            }

            const expression = unwrapExpression(node.value.expression);
            if (isObjectExpression(expression)) {
              checkStyleObject(expression);
            }
          },
        };
      },
    },
  },
});
