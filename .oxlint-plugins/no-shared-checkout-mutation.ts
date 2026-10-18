import { eslintCompatPlugin, type Variable } from "@oxlint/plugins";

import {
  isAstNode,
  isIdentifierReference,
  memberPropertyName,
  resolveImport,
  resolveVariable,
  stableInitializer,
  unwrapExpression,
  type ScopeContext,
} from "./utils.ts";

const NODE_FS_MODULES = new Set([
  "node:fs",
  "node:fs/promises",
  "fs",
  "fs/promises",
]);
const MUTATORS = new Set([
  "rm",
  "rmSync",
  "unlink",
  "unlinkSync",
  "writeFile",
  "writeFileSync",
  "rename",
  "renameSync",
  "cp",
  "copyFile",
]);

const isImportMetaProperty = (input: unknown, names: ReadonlySet<string>) => {
  const node = unwrapExpression(input);
  return (
    isAstNode(node) &&
    node.type === "MemberExpression" &&
    names.has(memberPropertyName(node) ?? "") &&
    isAstNode(node.object) &&
    node.object.type === "MetaProperty"
  );
};

const createPathResolver = (context: ScopeContext) => {
  const variableOf = (node: unknown) =>
    isIdentifierReference(node) ? resolveVariable(context, node) : null;

  const isCheckoutPath = (
    input: unknown,
    seen = new Set<Variable>(),
  ): boolean => {
    const node = unwrapExpression(input);
    // Any checkout-derived part makes the destination a checkout path, even
    // beside a temporary one: path.resolve keeps the last absolute segment.
    if (isImportMetaProperty(node, new Set(["dir", "dirname", "url"]))) {
      return true;
    }
    if (isIdentifierReference(node)) {
      const variable = variableOf(node);
      if (variable === null || seen.has(variable)) {
        return false;
      }
      seen.add(variable);
      return isCheckoutPath(stableInitializer(variable), seen);
    }
    if (
      isAstNode(node) &&
      node.type === "TemplateLiteral" &&
      Array.isArray(node.expressions)
    ) {
      return node.expressions.some((expression) =>
        isCheckoutPath(expression, new Set(seen)),
      );
    }
    if (
      isAstNode(node) &&
      node.type === "NewExpression" &&
      Array.isArray(node.arguments)
    ) {
      return (
        isIdentifierReference(node.callee) &&
        node.callee.name === "URL" &&
        node.arguments.some((argument) =>
          isCheckoutPath(argument, new Set(seen)),
        )
      );
    }
    if (
      isAstNode(node) &&
      node.type === "CallExpression" &&
      Array.isArray(node.arguments)
    ) {
      return node.arguments.some((argument) =>
        isCheckoutPath(argument, new Set(seen)),
      );
    }
    if (isAstNode(node) && node.type === "MemberExpression") {
      return isCheckoutPath(node.object, seen);
    }
    return false;
  };

  return { isCheckoutPath };
};

export default eslintCompatPlugin({
  meta: { name: "no-shared-checkout-mutation" },
  rules: {
    "no-shared-checkout-mutation": {
      meta: {
        type: "problem",
        messages: {
          mutation:
            "Tests run concurrently in one checkout. Mutate a temporary copy instead of a repository-derived path.",
        },
      },
      createOnce(context) {
        const { isCheckoutPath } = createPathResolver(context);
        return {
          CallExpression(node) {
            const binding = resolveImport(context, node.callee);
            let mutator =
              binding !== null && NODE_FS_MODULES.has(binding.moduleId)
                ? binding.imported
                : null;
            if (
              mutator === null &&
              isAstNode(node.callee) &&
              node.callee.type === "MemberExpression" &&
              memberPropertyName(node.callee) === "write" &&
              isIdentifierReference(node.callee.object) &&
              node.callee.object.name === "Bun"
            ) {
              mutator = "Bun.write";
            }
            if (mutator === "Bun.write" || MUTATORS.has(mutator ?? "")) {
              const pathArguments =
                mutator === "rename" || mutator === "renameSync"
                  ? node.arguments.slice(0, 2)
                  : mutator === "cp" || mutator === "copyFile"
                    ? node.arguments.slice(1, 2)
                    : node.arguments.slice(0, 1);
              if (pathArguments.some((argument) => isCheckoutPath(argument))) {
                context.report({ node, messageId: "mutation" });
              }
            }
          },
        };
      },
    },
  },
});
