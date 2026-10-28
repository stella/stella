// Colour has two sources of truth: the theme tokens (CSS custom properties in
// the theme stylesheets, used as `var(--token)` or a token class) and the brand
// palette in `@stll/brand`. Everything else names one of them.
//
// `no-raw-color-literals` reports a colour written into a string: a hex colour,
// or a CSS colour function with literal channels.
//
//   Flagged:  "#59a1d4"  "border: 1px solid #d4d4d8"  "bg-[#fafafa]"
//             "rgb(0 0 0 / 0.2)"  "rgba(255, 255, 255, 0.5)"  "hsl(210 50% 40%)"
//             "oklch(0.7 0.1 240)"  "color(display-p3 1 0 0)"
//   Accepted: "var(--primary)"  "rgb(from var(--info) r g b / 0.12)"
//             "issue #1139"  "(#4072)"  "&#124;"  "#main"  `rgb(${r} ${g} ${b})`
//
// A hex of digits only ("#123") is ambiguous with an issue reference, so it
// counts as a colour only where CSS puts one: the whole string, after a
// colour-bearing property or an attribute, after a length or a border style,
// or inside a function that takes colours (a gradient, `color-mix`, ...).
//
// `no-raw-pdf-color-operators` reports colour written straight into a PDF
// content stream, `"0.35 0.35 0.35 RG"` or `"0 g"`, a PDF library colour
// constructor called with literal channels, `rgb(0, 0, 0)` from @libpdf/core,
// and the libraries' ready-made colours (`black`, `white`, ...).
// Those colours come from the typed helpers in
// apps/api/src/lib/files/pdf-color.ts instead.

import { eslintCompatPlugin } from "@oxlint/plugins";
import type { Context, ESTree, Ranged } from "@oxlint/plugins";

import {
  isAstNode,
  isIdentifier,
  isImportedFrom,
  unwrapExpression,
} from "./utils.ts";

const HEX_CANDIDATE =
  /(?<![\w&#/$\\-])#(?<digits>[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})(?![\w-])/giu;

// Where a digits-only hex is a CSS value rather than an issue reference: after
// a colour-bearing property, an attribute, a length or a border style. Read
// by scanning back from the hex, so the check stays linear in the string.
const COLOR_PROPERTIES: ReadonlySet<string> = new Set([
  "accent-color",
  "background",
  "background-color",
  "box-shadow",
  "caret-color",
  "color",
  "column-rule",
  "column-rule-color",
  "fill",
  "flood-color",
  "lighting-color",
  "outline",
  "outline-color",
  "stop-color",
  "stroke",
  "text-decoration",
  "text-decoration-color",
  "text-shadow",
]);
const BORDER_STYLES: ReadonlySet<string> = new Set([
  "dashed",
  "dotted",
  "double",
  "groove",
  "inset",
  "outset",
  "ridge",
  "solid",
]);
const LENGTH_UNITS = ["px", "rem", "em", "pt", "%"] as const;
const WORD_CHARACTERS = "abcdefghijklmnopqrstuvwxyz0123456789_-";
const DIGITS = "0123456789";

const isWordCharacter = (character: string): boolean =>
  character !== "" && WORD_CHARACTERS.includes(character.toLowerCase());

// The run of word characters (letters, digits, `_`, `-`) that ends `text`.
const trailingWord = (text: string): string => {
  let start = text.length;
  while (start > 0 && isWordCharacter(text.charAt(start - 1))) {
    start -= 1;
  }
  return text.slice(start);
};

const isColorProperty = (property: string): boolean => {
  const name = property.toLowerCase();
  return (
    COLOR_PROPERTIES.has(name) ||
    name === "border" ||
    name.startsWith("border-") ||
    (name.startsWith("--") && name.length > 2)
  );
};

const isLength = (token: string): boolean =>
  token === "0" ||
  LENGTH_UNITS.some(
    (unit) =>
      token.endsWith(unit) &&
      DIGITS.includes(token.charAt(token.length - unit.length - 1) || "x"),
  );

const isCssValueBefore = (before: string): boolean => {
  const trimmed = before.trimEnd();
  const last = trimmed.slice(-1);
  if (before.endsWith("[")) {
    return true;
  }
  if (last === ":") {
    return isColorProperty(trailingWord(trimmed.slice(0, -1).trimEnd()));
  }
  if (before.endsWith('"') || before.endsWith("'")) {
    return before.slice(0, -1).trimEnd().endsWith("=");
  }
  if (trimmed.length === before.length) {
    return false;
  }
  const word = trailingWord(trimmed);
  const precededBySpace =
    trimmed.length === word.length ||
    trimmed.charAt(trimmed.length - word.length - 1).trim() === "";
  return (
    BORDER_STYLES.has(word.toLowerCase()) ||
    (isLength(word) && (word !== "0" || precededBySpace))
  );
};

// Functions whose arguments are colours, so a hex inside them is one.
const COLOR_ARGUMENT_FUNCTION =
  /(?:gradient|light-dark|color-mix|var|drop-shadow)\([^()]*$/iu;

const isCssValuePosition = (
  value: string,
  candidate: string,
  index: number,
): boolean => {
  const before = value.slice(0, index);
  return (
    value.trim() === candidate ||
    isCssValueBefore(before) ||
    COLOR_ARGUMENT_FUNCTION.test(before)
  );
};

const COLOR_FUNCTION =
  /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|device-cmyk)\(\s*[-+.\d][^()]*\)?/iu;

const COLOR_SPACE_FUNCTION =
  /\bcolor\(\s*(?:srgb|srgb-linear|display-p3|a98-rgb|prophoto-rgb|rec2020|xyz|xyz-d50|xyz-d65)\b[^()]*\)?/iu;

/** The first raw colour in `value`, or null. */
export const findRawColor = (value: string): string | null => {
  for (const match of value.matchAll(HEX_CANDIDATE)) {
    const digits = match.groups?.digits ?? "";
    if (/[a-f]/iu.test(digits)) {
      return match[0];
    }
    if (isCssValuePosition(value, match[0], match.index)) {
      return match[0];
    }
  }
  return (
    COLOR_FUNCTION.exec(value)?.[0] ??
    COLOR_SPACE_FUNCTION.exec(value)?.[0] ??
    null
  );
};

const PDF_NUMBER = String.raw`[-+]?(?:\d+(?:\.\d*)?|\.\d+)`;
// `r g b rg` / `RG` and `c m y k k` / `K` anywhere in a content stream.
const PDF_CHANNEL_OPERATOR = new RegExp(
  String.raw`(?:^|\s)(?:${PDF_NUMBER}\s+){2}${PDF_NUMBER}\s+(?:rg|RG)(?=\s|$)|(?:^|\s)(?:${PDF_NUMBER}\s+){3}${PDF_NUMBER}\s+[kK](?=\s|$)`,
  "u",
);
// `n g` / `G` reads as prose ("5 g") inside a sentence, so it counts only as a
// whole line of a content stream.
const PDF_GRAY_OPERATOR_LINE = new RegExp(
  String.raw`^[ \t]*${PDF_NUMBER}[ \t]+[gG][ \t]*$`,
  "u",
);

/** The first PDF colour operator written with literal operands, or null. */
export const findPdfColorOperator = (value: string): string | null =>
  PDF_CHANNEL_OPERATOR.exec(value)?.[0].trim() ??
  value
    .split("\n")
    .find((line) => PDF_GRAY_OPERATOR_LINE.test(line))
    ?.trim() ??
  null;

const PDF_LIBRARIES = ["@libpdf/core", "pdf-lib"] as const;
const PDF_COLOR_CONSTRUCTORS: ReadonlySet<string> = new Set([
  "cmyk",
  "grayscale",
  "rgb",
]);
// The libraries' ready-made colours, which name a colour just as inline.
const PDF_NAMED_COLORS: ReadonlySet<string> = new Set([
  "black",
  "blue",
  "green",
  "red",
  "white",
]);

const isNumericLiteral = (node: unknown): boolean => {
  const expression = unwrapExpression(node);
  if (!isAstNode(expression)) {
    return false;
  }
  if (expression.type === "Literal") {
    return typeof expression.value === "number";
  }
  return (
    expression.type === "UnaryExpression" &&
    (expression.operator === "-" || expression.operator === "+") &&
    isNumericLiteral(expression.argument)
  );
};

const templateText = (node: ESTree.TemplateLiteral): string =>
  node.quasis
    .map((quasi) => quasi.value.cooked ?? quasi.value.raw)
    // An interpolated operand stands for a number, so `${x} ${y} ${z} rg`
    // still reads as an operator with operands nobody named.
    .join("0");

type ReportContext = Pick<Context, "report">;

const reportRawColor = (
  context: ReportContext,
  node: Ranged,
  value: string,
) => {
  const match = findRawColor(value);
  if (match !== null) {
    context.report({ node, messageId: "rawColor", data: { match } });
  }
};

const reportPdfOperator = (
  context: ReportContext,
  node: Ranged,
  value: string,
) => {
  const match = findPdfColorOperator(value);
  if (match !== null) {
    context.report({ node, messageId: "rawOperator", data: { match } });
  }
};

export default eslintCompatPlugin({
  meta: { name: "no-raw-color-literals" },
  rules: {
    "no-raw-color-literals": {
      meta: {
        type: "problem",
        messages: {
          rawColor:
            "Raw colour '{{match}}' bypasses the theme and the brand palette. " +
            "Use a theme token (`var(--token)` or a token class) or a " +
            "`BRAND_COLORS` entry from @stll/brand. Colour that is document " +
            "data, not design, is exempted by path in oxlint.config.ts with its reason.",
        },
      },
      createOnce(context) {
        return {
          Literal(node) {
            if (typeof node.value === "string") {
              reportRawColor(context, node, node.value);
            }
          },
          TemplateElement(node) {
            reportRawColor(context, node, node.value.cooked ?? node.value.raw);
          },
        };
      },
    },
    "no-raw-pdf-color-operators": {
      meta: {
        type: "problem",
        messages: {
          rawOperator:
            "PDF colour operator '{{match}}' names its colour inline. Build it " +
            "with `pdfFillColor` / `pdfStrokeColor` from " +
            "apps/api/src/lib/files/pdf-color.ts and a brand or named neutral colour.",
          rawConstructor:
            "PDF colour `{{name}}(...)` with literal channels names its colour " +
            "inline. Pass a brand or named neutral colour from " +
            "apps/api/src/lib/files/pdf-color.ts.",
          rawNamedColor:
            "`{{name}}` from {{source}} names a colour inline. Use a brand or " +
            "named neutral colour from apps/api/src/lib/files/pdf-color.ts.",
        },
      },
      createOnce(context) {
        return {
          Literal(node) {
            if (typeof node.value === "string") {
              reportPdfOperator(context, node, node.value);
            }
          },
          TemplateLiteral(node) {
            reportPdfOperator(context, node, templateText(node));
          },
          ImportDeclaration(node) {
            const source = node.source.value;
            if (!PDF_LIBRARIES.some((library) => library === source)) {
              return;
            }
            for (const specifier of node.specifiers) {
              if (
                specifier.type === "ImportSpecifier" &&
                specifier.imported.type === "Identifier" &&
                PDF_NAMED_COLORS.has(specifier.imported.name)
              ) {
                context.report({
                  node: specifier,
                  messageId: "rawNamedColor",
                  data: { name: specifier.imported.name, source },
                });
              }
            }
          },
          CallExpression(node) {
            const callee = unwrapExpression(node.callee);
            if (
              !isIdentifier(callee) ||
              !node.arguments.some(isNumericLiteral) ||
              !isImportedFrom({
                context,
                node: callee,
                modules: PDF_LIBRARIES,
                names: PDF_COLOR_CONSTRUCTORS,
              })
            ) {
              return;
            }
            context.report({
              node,
              messageId: "rawConstructor",
              data: { name: callee.name },
            });
          },
        };
      },
    },
  },
});
