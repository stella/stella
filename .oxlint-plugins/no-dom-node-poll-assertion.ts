// A polled wait (`waitFor`) calls its callback again until it stops throwing.
// When the assertion inside fails on a DOM node, as with
// `expect(queryByText(…)).toBeNull()` while the text is still there, the
// matcher formats the received node for its failure message. Under happy-dom
// that walks the whole node graph and blocks the event loop for seconds on
// every poll, so the work the wait is waiting for (a refetch, a render) is
// held back behind the formatting. A test that should take milliseconds
// takes seconds, and times out under load.
//
// Flagged: inside a `waitFor` callback, `expect(<DOM query>)` with a matcher
// that can fail while the query returned a node.
//   await waitFor(() => expect(view.queryByText("Saved")).toBeNull());
//   await waitFor(() => expect(getByRole("switch")).toHaveAttribute("aria-checked", "true"));
// Allowed: compare a boolean or a string the node gives, and a `getBy*`
// presence check (the query throws its own bounded error before `expect`).
//   await waitFor(() => expect(view.queryByText("Saved") === null).toBe(true));
//   await waitFor(() => expect(getByRole("switch").getAttribute("aria-checked")).toBe("true"));
//   await waitFor(() => expect(getByText("Saved")).toBeTruthy());

import { eslintCompatPlugin } from "@oxlint/plugins";

import { guardEnforcesLine } from "../scripts/guard-rollouts.ts";
import type { AstNode } from "./utils.ts";
import {
  everyNode,
  filenameForContext,
  isAstNode,
  isIdentifier,
} from "./utils.ts";

const RULE_NAME = "no-dom-node-poll-assertion";
const POLLED_WAITS = new Set(["waitFor"]);

/** Testing Library and DOM queries that return a node (or nodes). */
const NODE_QUERY =
  /^(?:(?:get|query|find)(?:All)?By[A-Z]\w*|querySelector(?:All)?|closest|getElementById|getElementsBy[A-Z]\w*)$/u;
const THROWING_QUERY = /^(?:get|find)(?:All)?By[A-Z]/u;

/** Matchers that cannot fail once a throwing query returned a node. */
const PRESENCE_MATCHERS = new Set(["toBeTruthy", "toBeDefined"]);

const calleeName = (call: AstNode): string | null => {
  const { callee } = call;
  if (isIdentifier(callee)) {
    return callee.name;
  }
  if (
    isAstNode(callee) &&
    callee.type === "MemberExpression" &&
    isIdentifier(callee.property)
  ) {
    return callee.property.name;
  }
  return null;
};

/** Whether an `expect(…)` call is chained into a presence matcher that is
 *  not negated: `.toBeTruthy()`, never `.not.toBeTruthy()`. */
const isPresenceCheck = (expectCall: AstNode): boolean => {
  let node: unknown = expectCall.parent;
  while (isAstNode(node) && node.type === "MemberExpression") {
    if (isIdentifier(node.property)) {
      return (
        node.property.name !== "not" &&
        PRESENCE_MATCHERS.has(node.property.name)
      );
    }
    node = node.parent;
  }
  return false;
};

const isPolledWait = (call: AstNode): boolean => {
  const name = calleeName(call);
  return name !== null && POLLED_WAITS.has(name);
};

export default eslintCompatPlugin({
  meta: { name: RULE_NAME },
  rules: {
    [RULE_NAME]: {
      meta: {
        type: "problem",
        messages: {
          nodeInPoll:
            "A polled assertion on a DOM node ({{query}}): when it fails, the matcher formats the whole happy-dom node graph, which blocks the event loop for seconds on every poll and holds back what the wait is waiting for. Compare a boolean or a string instead, such as `expect(… === null).toBe(true)` or `expect(node.getAttribute(…)).toBe(…)`.",
        },
        schema: [],
      },
      createOnce(context) {
        return {
          CallExpression(node: unknown) {
            if (!isAstNode(node) || !isPolledWait(node)) {
              return;
            }
            const callback = Array.isArray(node.arguments)
              ? node.arguments.at(0)
              : undefined;
            for (const inner of everyNode(callback)) {
              if (
                inner.type !== "CallExpression" ||
                !isIdentifier(inner.callee, "expect") ||
                !Array.isArray(inner.arguments)
              ) {
                continue;
              }
              const subject: unknown = inner.arguments.at(0);
              if (!isAstNode(subject) || subject.type !== "CallExpression") {
                continue;
              }
              const query = calleeName(subject);
              if (query === null || !NODE_QUERY.test(query)) {
                continue;
              }
              if (THROWING_QUERY.test(query) && isPresenceCheck(inner)) {
                continue;
              }
              // First-week rollout: only assertions on lines this change
              // touched (scripts/guard-rollouts/no-dom-node-poll-assertion.json).
              if (
                !guardEnforcesLine({
                  guard: RULE_NAME,
                  file: filenameForContext(context),
                  line: context.sourceCode.getLocFromIndex(inner.range[0]).line,
                })
              ) {
                continue;
              }
              context.report({
                node: inner,
                messageId: "nodeInPoll",
                data: { query },
              });
            }
          },
        };
      },
    },
  },
});
