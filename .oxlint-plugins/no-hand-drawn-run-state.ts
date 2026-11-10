// A run state (a chat waiting on the reader, a chat working) is drawn by one
// owner: `RunStateMark` in `@stll/ui/run-state-mark`, whose shared table
// (run-state-mark.shared.ts) gives each state its glyph and tone for the web
// and the phone alike. Anything else that branches on a run state and draws
// in a branch is a second look that will drift from it.
//
// A run state is the literal "needs-you" or a `CHAT_ACTIVE_RUN_STATE.<state>`
// read. Flagged, when markup or a colour utility depends on one:
//   switch (state) { case "needs-you": return <span>!</span>; }
//   state === CHAT_ACTIVE_RUN_STATE.working ? <StatusMark status="running" /> : null
//   state === "needs-you" && <Icon />
//   const tone = state === "needs-you" ? "text-warning-foreground" : "";
//   const marks = { "needs-you": <span>!</span>, working: <Spinner /> };
// Allowed: choosing words, counts or order by state, and
//   <RunStateMark state={state} />
//
// Known limit: a bare "working" literal is too common a word to count as a
// run state on its own; a branch on it alone is not read.

import { eslintCompatPlugin } from "@oxlint/plugins";

import {
  classBaseName,
  classTokens,
  everyNode,
  isAstNode,
  isIdentifier,
  staticStringValue,
  unwrapExpression,
} from "./utils.ts";

const NEEDS_YOU = "needs-you";
const RUN_STATE_CONSTANT = "CHAT_ACTIVE_RUN_STATE";
const EQUALITY_OPERATORS = new Set(["===", "!==", "==", "!="]);

/** A utility that paints with a theme or palette colour. */
const COLOUR_UTILITY =
  /^(?:text|bg|fill|stroke|border|ring|outline|decoration|accent)-(?:[a-z]+-)*(?:foreground|warning|destructive|success|info|primary|muted|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)(?:-|\/|$)/u;

const isRunStateValue = (node: unknown): boolean => {
  if (staticStringValue(node) === NEEDS_YOU) {
    return true;
  }
  const expression = unwrapExpression(node);
  return (
    expression?.type === "MemberExpression" &&
    isIdentifier(expression.object, RUN_STATE_CONSTANT)
  );
};

/** `x === "needs-you"`, either way round, anywhere inside a test. */
const testsRunState = (test: unknown): boolean =>
  everyNode(test).some(
    (node) =>
      node.type === "BinaryExpression" &&
      typeof node.operator === "string" &&
      EQUALITY_OPERATORS.has(node.operator) &&
      (isRunStateValue(node.left) || isRunStateValue(node.right)),
  );

const hasColourUtility = (text: string): boolean =>
  classTokens(text).some((token) => COLOUR_UTILITY.test(classBaseName(token)));

/** Whether a branch draws: renders markup or names a colour utility. */
const draws = (branch: unknown): boolean =>
  everyNode(branch).some((node) => {
    if (node.type === "JSXElement" || node.type === "JSXFragment") {
      return true;
    }
    if (node.type === "Literal" && typeof node.value === "string") {
      return hasColourUtility(node.value);
    }
    if (node.type === "TemplateElement") {
      const value = node.value;
      return (
        typeof value === "object" &&
        value !== null &&
        "raw" in value &&
        typeof value.raw === "string" &&
        hasColourUtility(value.raw)
      );
    }
    return false;
  });

const propertyKeyIsRunState = (property: unknown): boolean =>
  isAstNode(property) &&
  property.type === "Property" &&
  (property.computed === true
    ? isRunStateValue(property.key)
    : staticStringValue(property.key) === NEEDS_YOU);

const propertyDraws = (property: unknown): boolean =>
  isAstNode(property) && property.type === "Property" && draws(property.value);

export default eslintCompatPlugin({
  meta: { name: "no-hand-drawn-run-state" },
  rules: {
    "no-hand-drawn-run-state": {
      meta: {
        type: "problem",
        messages: {
          handDrawn:
            "Render `RunStateMark` from '@stll/ui/run-state-mark' instead " +
            "of drawing a run state here: its shared table gives each state " +
            "its glyph and tone on the web and the phone.",
        },
      },
      createOnce(context) {
        return {
          SwitchStatement(node) {
            if (
              node.cases.some(({ test }) => isRunStateValue(test)) &&
              draws(node.cases)
            ) {
              context.report({ node, messageId: "handDrawn" });
            }
          },
          IfStatement(node) {
            if (
              testsRunState(node.test) &&
              (draws(node.consequent) || draws(node.alternate))
            ) {
              context.report({ node, messageId: "handDrawn" });
            }
          },
          ConditionalExpression(node) {
            if (
              testsRunState(node.test) &&
              (draws(node.consequent) || draws(node.alternate))
            ) {
              context.report({ node, messageId: "handDrawn" });
            }
          },
          LogicalExpression(node) {
            if (
              node.operator === "&&" &&
              testsRunState(node.left) &&
              draws(node.right)
            ) {
              context.report({ node, messageId: "handDrawn" });
            }
          },
          ObjectExpression(node) {
            if (
              node.properties.some(propertyKeyIsRunState) &&
              node.properties.some(propertyDraws)
            ) {
              context.report({ node, messageId: "handDrawn" });
            }
          },
        };
      },
    },
  },
});
