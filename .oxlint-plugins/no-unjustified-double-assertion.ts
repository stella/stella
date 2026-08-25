// Require an explicit safety argument for TypeScript double assertions that
// first widen a value through `unknown`, `object`, or an open record and then
// assert a narrower contract.
//
// A double assertion discards the evidence that lets TypeScript compare the
// source and target. It is sometimes necessary at a third-party type boundary,
// but the exception must state the runtime invariant that makes it sound or
// explicitly point to the canonical safety explanation.
//
// Flagged:
//   value as unknown as Widget
//   value as Record<string, unknown> as Widget
//
// Accepted:
//   value as Widget
//   // SAFETY: the adapter constructs every field consumed by Widget.
//   value as unknown as Widget
//
// Boundary: this is a syntax check. It recognizes direct assertion chains and
// a small set of deliberately broad intermediate spellings. It does not follow
// aliases or variables, and a SAFETY comment is evidence of review rather than
// proof that the assertion is sound.

import { eslintCompatPlugin } from "@oxlint/plugins";

import { isAstNode } from "./utils.ts";

const BROAD_INTERMEDIATE =
  /^(?:unknown|object|Record<(?:string|number|symbol|PropertyKey),(?:unknown|object)>|Readonly<Record<(?:string|number|symbol|PropertyKey),(?:unknown|object)>>)$/u;
const SAFETY_COMMENT = /\bSAFETY(?::|\s+comment\b)/u;
const COMMENT_TEXT = /\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/gu;
const MAX_SAFETY_COMMENT_DISTANCE = 12;

type Comment = { range: [number, number]; value: string };

const isComment = (value: unknown): value is Comment =>
  typeof value === "object" &&
  value !== null &&
  "value" in value &&
  typeof value.value === "string" &&
  "loc" in value &&
  "range" in value &&
  Array.isArray(value.range) &&
  value.range.length === 2 &&
  value.range.every((offset) => typeof offset === "number");

const locationLine = (
  value: unknown,
  edge: "end" | "start",
): number | undefined => {
  if (
    typeof value !== "object" ||
    value === null ||
    !("loc" in value) ||
    typeof value.loc !== "object" ||
    value.loc === null ||
    !(edge in value.loc)
  ) {
    return undefined;
  }
  const point = value.loc[edge];
  if (
    typeof point !== "object" ||
    point === null ||
    !("line" in point) ||
    typeof point.line !== "number"
  ) {
    return undefined;
  }
  return point.line;
};

const unwrapParentheses = (node: unknown): unknown => {
  let current = node;
  while (isAstNode(current) && current.type === "ParenthesizedExpression") {
    current = current.expression;
  }
  return current;
};

export default eslintCompatPlugin({
  meta: { name: "no-unjustified-double-assertion" },
  rules: {
    "no-unjustified-double-assertion": {
      meta: {
        type: "problem",
        messages: {
          unjustified:
            "This double assertion discards source-type evidence. Remove it, " +
            "narrow or validate the value, or add a nearby safety rationale " +
            "that states the runtime invariant or references its canonical explanation.",
        },
      },
      createOnce(context) {
        let comments: readonly Comment[] = [];

        const check = (node: unknown): void => {
          if (
            !isAstNode(node) ||
            (node.type !== "TSAsExpression" && node.type !== "TSTypeAssertion")
          ) {
            return;
          }
          const inner = unwrapParentheses(node.expression);
          if (
            !isAstNode(inner) ||
            (inner.type !== "TSAsExpression" &&
              inner.type !== "TSTypeAssertion") ||
            !isAstNode(inner.typeAnnotation)
          ) {
            return;
          }
          const intermediate = context.sourceCode
            .getText(inner.typeAnnotation)
            .replaceAll(/\s+/gu, "");
          if (!BROAD_INTERMEDIATE.test(intermediate)) {
            return;
          }
          const startLine = locationLine(node, "start");
          const assertionLineStart =
            context.sourceCode.text.lastIndexOf("\n", node.range[0] - 1) + 1;
          if (
            startLine !== undefined &&
            comments.some((comment) => {
              const endLine = locationLine(comment, "end");
              return (
                endLine !== undefined &&
                endLine < startLine &&
                startLine - endLine <= MAX_SAFETY_COMMENT_DISTANCE &&
                SAFETY_COMMENT.test(comment.value) &&
                context.sourceCode.text
                  .slice(comment.range[1], assertionLineStart)
                  .replaceAll(COMMENT_TEXT, "")
                  .trim() === ""
              );
            })
          ) {
            return;
          }
          context.report({ node, messageId: "unjustified" });
        };

        return {
          Program() {
            comments = context.sourceCode.getAllComments().filter(isComment);
          },
          TSAsExpression: check,
          TSTypeAssertion: check,
        };
      },
    },
  },
});
