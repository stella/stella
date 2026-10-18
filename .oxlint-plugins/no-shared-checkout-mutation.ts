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
  "cpSync",
  "copyFile",
  "copyFileSync",
]);
// Copies mutate their second argument; every other mutator its first.
const COPIES = new Set(["cp", "cpSync", "copyFile", "copyFileSync"]);

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

  // `path.resolve` / `resolve` -> "resolve"; anything else -> its name or null.
  const calleeName = (callee: unknown): string | null => {
    if (!isAstNode(callee)) {
      return null;
    }
    if (callee.type === "MemberExpression") {
      return memberPropertyName(callee);
    }
    return callee.type === "Identifier" && typeof callee.name === "string"
      ? callee.name
      : null;
  };

  // A temporary directory: tmpdir(), a mkdtemp result, or a value built on one.
  const isTemporaryRoot = (
    input: unknown,
    seen = new Set<Variable>(),
  ): boolean => {
    const node = unwrapExpression(input);
    if (isIdentifierReference(node)) {
      const variable = variableOf(node);
      if (variable === null || seen.has(variable)) {
        return false;
      }
      seen.add(variable);
      return isTemporaryRoot(stableInitializer(variable), seen);
    }
    if (!isAstNode(node)) {
      return false;
    }
    if (node.type === "AwaitExpression") {
      return isTemporaryRoot(node.argument, seen);
    }
    if (node.type !== "CallExpression" || !Array.isArray(node.arguments)) {
      return false;
    }
    const binding = resolveImport(context, node.callee);
    if (
      binding !== null &&
      ((binding.imported === "tmpdir" &&
        (binding.moduleId === "node:os" || binding.moduleId === "os")) ||
        ((binding.imported === "mkdtemp" ||
          binding.imported === "mkdtempSync") &&
          NODE_FS_MODULES.has(binding.moduleId)))
    ) {
      return true;
    }
    const parts: unknown[] = node.arguments;
    const operation = calleeName(node.callee);
    // path.resolve: the last absolute segment decides, as for checkout paths.
    if (operation === "resolve") {
      for (const part of parts.toReversed()) {
        if (isCheckoutPath(part, new Set(seen))) {
          return false;
        }
        if (isTemporaryRoot(part, new Set(seen))) {
          return true;
        }
      }
      return false;
    }
    // path.join: the first segment is the base.
    return (
      operation === "join" &&
      parts.length > 0 &&
      isTemporaryRoot(parts[0], new Set(seen))
    );
  };

  const isCheckoutPath = (
    input: unknown,
    seen = new Set<Variable>(),
  ): boolean => {
    const node = unwrapExpression(input);
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
      node.type === "BinaryExpression" &&
      node.operator === "+"
    ) {
      return (
        isCheckoutPath(node.left, new Set(seen)) ||
        isCheckoutPath(node.right, new Set(seen))
      );
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
      const operation = calleeName(node.callee);
      const parts: unknown[] = node.arguments;
      // path.resolve: the last absolute segment decides the destination.
      if (operation === "resolve") {
        for (const part of parts.toReversed()) {
          if (isTemporaryRoot(part, new Set(seen))) {
            return false;
          }
          if (isCheckoutPath(part, new Set(seen))) {
            return true;
          }
        }
        return false;
      }
      // path.join: the first segment is the base the rest is joined under.
      if (operation === "join") {
        return parts.length > 0 && isCheckoutPath(parts[0], new Set(seen));
      }
      return parts.some((argument) => isCheckoutPath(argument, new Set(seen)));
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
                  : COPIES.has(mutator)
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
