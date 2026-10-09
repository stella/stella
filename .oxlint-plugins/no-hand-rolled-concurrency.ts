import { type Context, eslintCompatPlugin } from "@oxlint/plugins";

import {
  type AstNode,
  isAstNode,
  isIdentifier,
  isIdentifierReference,
  memberPropertyName,
  repoRelativeFilename,
  resolveVariable,
} from "./utils.ts";

const SLEEP_HELPERS = new Set([
  "sleep",
  "delay",
  "abortableSleep",
  "waitForAbortableDelay",
  "sleepWithSignal",
]);

const sourceOf = (context: Context, node: unknown): string =>
  isAstNode(node) ? context.sourceCode.getText(node) : "";

type GlobalIdentifierOptions = {
  context: Context;
  node: unknown;
  name: string;
};
const globalIdentifier = ({
  context,
  node,
  name,
}: GlobalIdentifierOptions): boolean =>
  isIdentifierReference(node) &&
  node.name === name &&
  (resolveVariable(context, node)?.defs.length ?? 0) === 0;

const isTimer = (context: Context, callee: unknown): boolean =>
  globalIdentifier({ context, node: callee, name: "setTimeout" }) ||
  (isAstNode(callee) &&
    callee.type === "MemberExpression" &&
    memberPropertyName(callee) === "setTimeout" &&
    ["globalThis", "window", "self"].some((name) =>
      globalIdentifier({ context, node: callee.object, name }),
    ));

const containsTimer = (context: Context, node: unknown): boolean => {
  if (!isAstNode(node)) {
    return false;
  }
  if (
    node.type === "CallExpression" &&
    (isTimer(context, node.callee) ||
      (isAstNode(node.callee) &&
        node.callee.type === "MemberExpression" &&
        globalIdentifier({
          context,
          node: node.callee.object,
          name: "AbortSignal",
        }) &&
        memberPropertyName(node.callee) === "timeout"))
  ) {
    return true;
  }
  for (const [key, child] of Object.entries(node)) {
    if (key === "parent") {
      continue;
    }
    if (Array.isArray(child)) {
      if (child.some((value: unknown) => containsTimer(context, value))) {
        return true;
      }
      continue;
    }
    if (containsTimer(context, child)) {
      return true;
    }
  }
  return false;
};

type DuplicateNameOptions = { context: Context; id: unknown; body: unknown };
const duplicateName = ({
  context,
  id,
  body,
}: DuplicateNameOptions): "sleep" | "chunk" | "backoff" | null => {
  if (!isIdentifier(id)) {
    return null;
  }
  const filename = repoRelativeFilename(context);
  if (SLEEP_HELPERS.has(id.name) && containsTimer(context, body)) {
    return "sleep";
  }
  if (
    (filename.endsWith("apps/api/src/lib/chunked.ts") &&
      id.name === "chunked") ||
    (filename.endsWith("apps/web/src/features/case-law/research/queries.ts") &&
      id.name === "chunk")
  ) {
    return "chunk";
  }
  if (
    filename.endsWith(
      "apps/api/src/handlers/case-law/ingestion/adapters/retry.ts",
    ) &&
    id.name === "backoffMs"
  ) {
    return "backoff";
  }
  return null;
};

export default eslintCompatPlugin({
  meta: { name: "no-hand-rolled-concurrency" },
  rules: {
    "no-hand-rolled-concurrency": {
      meta: {
        type: "problem",
        schema: [
          {
            type: "object",
            properties: {
              exceptions: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    path: { type: "string" },
                    source: { type: "string" },
                    reason: { type: "string" },
                  },
                  required: ["path", "source", "reason"],
                  additionalProperties: false,
                },
              },
            },
            additionalProperties: false,
          },
        ],
        messages: {
          sleep:
            "Use sleep from @stll/concurrency/sleep for a promise-based delay.",
          backoff:
            "Use backoffDelay from @stll/concurrency/backoff-delay instead of the duplicate backoff helper.",
          chunk:
            "Use chunk from @stll/concurrency/chunk instead of the duplicate partition helper.",
        },
      },
      createOnce(context) {
        const usedExceptions = new Set<number>();
        const report = (
          node: AstNode,
          messageId: "sleep" | "backoff" | "chunk",
        ) => {
          const filename = repoRelativeFilename(context);
          if (/(?:^|\/)packages\/concurrency\//u.test(filename)) {
            return;
          }
          const source = sourceOf(context, node);
          const options = context.options.at(0);
          const configured =
            typeof options === "object" &&
            options !== null &&
            !Array.isArray(options)
              ? options.exceptions
              : undefined;
          const exceptions = Array.isArray(configured) ? configured : [];
          const index = exceptions.findIndex(
            (entry: unknown, candidate) =>
              !usedExceptions.has(candidate) &&
              typeof entry === "object" &&
              entry !== null &&
              "path" in entry &&
              typeof entry.path === "string" &&
              "source" in entry &&
              typeof entry.source === "string" &&
              filename.endsWith(entry.path) &&
              entry.source === source,
          );
          if (index !== -1) {
            usedExceptions.add(index);
            return;
          }
          context.report({ node, messageId });
        };
        return {
          Program() {
            usedExceptions.clear();
          },
          VariableDeclarator(node) {
            if (
              !isAstNode(node.init) ||
              !["ArrowFunctionExpression", "FunctionExpression"].includes(
                node.init.type,
              )
            ) {
              return;
            }
            const kind = duplicateName({
              context,
              id: node.id,
              body: node.init.body,
            });
            if (kind !== null && isAstNode(node.id)) {
              report(node.id, kind);
            }
          },
          FunctionDeclaration(node) {
            const kind = duplicateName({
              context,
              id: node.id,
              body: node.body,
            });
            if (kind !== null && isAstNode(node.id)) {
              report(node.id, kind);
            }
          },
          CallExpression(node) {
            if (!isAstNode(node)) {
              return;
            }
            if (!isTimer(context, node.callee) || node.arguments.length !== 2) {
              return;
            }
            // Only the direct resolver shape is a sleep. Timer handles retained
            // by deadline races and callback lifecycle work have other owners.
            let current: unknown = node.parent;
            while (isAstNode(current) && current.type !== "Program") {
              if (
                current.type === "VariableDeclarator" ||
                current.type === "AssignmentExpression"
              ) {
                return;
              }
              if (
                current.type === "ArrowFunctionExpression" ||
                current.type === "FunctionExpression"
              ) {
                const params = Array.isArray(current.params)
                  ? current.params
                  : [];
                const resolver = params.at(0);
                if (
                  isIdentifier(resolver) &&
                  isIdentifier(node.arguments.at(0), resolver.name) &&
                  isAstNode(current.parent) &&
                  current.parent.type === "NewExpression" &&
                  globalIdentifier({
                    context,
                    node: current.parent.callee,
                    name: "Promise",
                  })
                ) {
                  report(node, "sleep");
                }
                return;
              }
              current = current.parent;
            }
          },
        };
      },
    },
  },
});
