// A refusal the caller can act on carries a stable code.
//
// `require-refusal-code`: a `new HandlerError({ status, ... })` whose status
// is a client refusal names a `code`. Clients localize a refusal by its code:
// the web app translates known codes and shows its own fallback otherwise,
// because the `message` and `hint` are English text for agents and logs. A
// codeless refusal therefore reaches a person as "something went wrong", with
// the reason and the next step dropped; agents and the CLI cannot branch on
// it either. Give the refusal a code from @stll/api-contract (and a message
// key in the web app when a person can act on it).
//
// 401 and 403 are exempt: the client shows them by status as a sign-in or
// permission refusal. A status the rule cannot read statically (a variable,
// a spread of props) is not checked.
//
// Existing sites are budgeted per file, enclosing function and status in
// scripts/refusal-code-ledger.json (no line numbers, a reason per row). A
// budget can only shrink: a hit beyond it fails, and so does a budget the
// code no longer reaches, until the row is lowered or removed. Regenerate
// with `bun scripts/refusal-code-ledger.ts --write`.

import type { ESTree } from "@oxlint/plugins";
import { eslintCompatPlugin } from "@oxlint/plugins";

import ledger from "../scripts/refusal-code-ledger.json" with { type: "json" };
import { createBudgetLedger } from "./budget-ledger.ts";
import {
  type AstNode,
  filenameForContext,
  getPropertyName,
  isAstNode,
  isIdentifier,
  memberPropertyName,
  unwrapExpression,
} from "./utils.ts";

const RULE = "require-refusal-code";
const LEDGER_PATH = "scripts/refusal-code-ledger.json";

const { tracker: budgetTracker, staleMessage: STALE_MESSAGE } =
  createBudgetLedger(LEDGER_PATH, ledger);

/** Client refusals a person or agent acts on by their code. */
const CODED_STATUSES: ReadonlySet<number> = new Set([
  400, 402, 404, 409, 413, 422, 426, 428, 429,
]);

const isHandlerErrorConstructor = (callee: unknown): boolean => {
  const node = unwrapExpression(callee);
  if (isIdentifier(node, "HandlerError")) {
    return true;
  }
  return (
    node?.type === "MemberExpression" &&
    memberPropertyName(node) === "HandlerError"
  );
};

/** The statuses a `status` value can take, or null when not static. */
const staticStatuses = (value: unknown): number[] | null => {
  const node = unwrapExpression(value);
  if (node?.type === "Literal" && typeof node.value === "number") {
    return [node.value];
  }
  if (node?.type === "ConditionalExpression") {
    const consequent = staticStatuses(node.consequent);
    const alternate = staticStatuses(node.alternate);
    return consequent === null || alternate === null
      ? null
      : [...consequent, ...alternate];
  }
  return null;
};

const propertyOf = (properties: unknown[], name: string): AstNode | null => {
  for (const property of properties) {
    if (
      isAstNode(property) &&
      property.type === "Property" &&
      property.computed !== true &&
      getPropertyName(property.key) === name
    ) {
      return property;
    }
  }
  return null;
};

const isUndefined = (value: unknown): boolean =>
  isIdentifier(unwrapExpression(value), "undefined");

/** The ledger spelling of a codeless refusal, or null. */
const codelessRefusal = (node: AstNode): string | null => {
  if (!isHandlerErrorConstructor(node.callee)) {
    return null;
  }
  const args = Array.isArray(node.arguments) ? node.arguments : [];
  const props = unwrapExpression(args.at(0));
  if (props?.type !== "ObjectExpression" || !Array.isArray(props.properties)) {
    return null;
  }
  const { properties } = props;
  // A spread may carry the code; the rule reads only what it can see.
  if (
    properties.some(
      (property) => isAstNode(property) && property.type === "SpreadElement",
    )
  ) {
    return null;
  }
  const code = propertyOf(properties, "code");
  if (code !== null && !isUndefined(code.value)) {
    return null;
  }
  const status = propertyOf(properties, "status");
  const statuses = status === null ? null : staticStatuses(status.value);
  const refused = statuses?.filter((value) => CODED_STATUSES.has(value)) ?? [];
  return refused.length === 0
    ? null
    : `status ${[...new Set(refused)].toSorted((left, right) => left - right).join("|")}`;
};

export default eslintCompatPlugin({
  meta: { name: "refusal-code" },
  rules: {
    [RULE]: {
      meta: {
        type: "problem",
        schema: [],
        messages: {
          codeless:
            "This HandlerError ({{pattern}}) has no `code`: clients localize a refusal by its code and drop the message and hint of a codeless one. Add a stable code from @stll/api-contract (and its message in the web app when a person can act on it). Ledger key: {{key}}",
          stale: STALE_MESSAGE,
        },
      },
      createOnce(context) {
        const tracker = budgetTracker(RULE);
        return {
          before() {
            tracker.reset(filenameForContext(context));
          },
          NewExpression(node: ESTree.NewExpression) {
            if (!isAstNode(node)) {
              return;
            }
            const pattern = codelessRefusal(node);
            const report =
              pattern === null
                ? null
                : tracker.record(node, pattern, "codeless");
            if (report !== null) {
              context.report({ node, ...report });
            }
          },
          "Program:exit"(node) {
            for (const report of tracker.stale()) {
              context.report({ node, ...report });
            }
          },
        };
      },
    },
  },
});
