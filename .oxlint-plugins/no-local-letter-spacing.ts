// Letter-spaced emphasis (`z a m í t á`, `p o s t a n a w i a`) is read in one
// place: collapseLetterSpacing and its fold collapseSpacedLetters in
// @stll/text-normalize (packages/text-normalize/src/letter-spacing.ts). A
// parser that joins letters with a regular expression of its own reads the
// same heading another way than search, the role vocabularies and the reader
// do, and misses the evidence the owner weighs (word gaps, rows of one-letter
// words, uneven chunks). Syntax only: a regular expression whose source joins
// two letters across a gap (`(?<=\p{L}) (?=\p{L})`), or repeats a letter and
// a gap (`(?:\p{L} )+`), in a regex literal or a `RegExp` string argument.

import { eslintCompatPlugin } from "@oxlint/plugins";

import { isAstNode } from "./utils.ts";

/** A letter class, perhaps with its combining marks. */
const LETTER = String.raw`\\p\{L[lu]?\}(?:\\p\{M\}(?:[*+?]|\{\d*,?\d*\}))?`;
/** A gap: a space, whitespace, or a class of spaces, perhaps repeated. */
const GAP = String.raw`(?: [+*]?|\\s[+*]?|\[[^\]]*\][+*]?|\(\?<\w+>\[[^\]]*\][+*]?\))`;

/** A letter, perhaps closing a lookbehind, a gap, then a following letter. */
const JOINED_LETTERS = new RegExp(
  String.raw`${LETTER}\)?${GAP}\(\?=\\p\{L`,
  "u",
);
/** A letter and a gap, repeated: a run of spaced letters. */
const SPACED_RUN = new RegExp(
  String.raw`\(\?:${LETTER}${GAP}\)(?:[*+]|\{\d+,\d*\})`,
  "u",
);

export const readsLetterSpacing = (pattern: string): boolean =>
  JOINED_LETTERS.test(pattern) || SPACED_RUN.test(pattern);

const regexPattern = (node: unknown): string | null => {
  if (
    !isAstNode(node) ||
    typeof node.regex !== "object" ||
    node.regex === null ||
    !("pattern" in node.regex)
  ) {
    return null;
  }
  const { pattern } = node.regex;
  return typeof pattern === "string" ? pattern : null;
};

const isRegExpCallee = (node: unknown): boolean =>
  isAstNode(node) && node.type === "Identifier" && node.name === "RegExp";

export default eslintCompatPlugin({
  meta: { name: "no-local-letter-spacing" },
  rules: {
    "no-local-letter-spacing": {
      meta: {
        type: "problem",
        messages: {
          owner:
            "Read letter-spaced text through collapseLetterSpacing() or collapseSpacedLetters() from @stll/text-normalize, so one rule reads spaced emphasis everywhere.",
        },
      },
      createOnce(context) {
        const check = (node: unknown, pattern: string | null) => {
          if (
            pattern !== null &&
            readsLetterSpacing(pattern) &&
            isAstNode(node)
          ) {
            context.report({ node, messageId: "owner" });
          }
        };
        const checkConstruction = (node: unknown) => {
          if (!isAstNode(node) || !isRegExpCallee(node.callee)) {
            return;
          }
          const [source] = Array.isArray(node.arguments) ? node.arguments : [];
          if (
            isAstNode(source) &&
            source.type === "Literal" &&
            typeof source.value === "string"
          ) {
            check(node, source.value);
          }
        };
        return {
          Literal(node) {
            check(node, regexPattern(node));
          },
          NewExpression: checkConstruction,
          CallExpression: checkConstruction,
        };
      },
    },
  },
});
