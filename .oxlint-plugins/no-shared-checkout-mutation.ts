import { eslintCompatPlugin, type Variable } from "@oxlint/plugins";

import {
  isAstNode,
  isIdentifierReference,
  memberPropertyName,
  resolveImport,
  resolveVariable,
  stableInitializer,
  unwrapExpression,
  type AstNode,
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
  "appendFile",
  "appendFileSync",
  "rmdir",
  "rmdirSync",
  "truncate",
  "truncateSync",
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

// The text of each static quasi; null for an interpolated or unknown one.
const quasiTexts = (quasis: unknown): string[] | null => {
  if (!Array.isArray(quasis)) {
    return null;
  }
  const texts = quasis.map((quasi: unknown) => {
    const value: unknown = isAstNode(quasi) ? quasi.value : null;
    return typeof value === "object" &&
      value !== null &&
      "cooked" in value &&
      typeof value.cooked === "string"
      ? value.cooked
      : null;
  });
  return texts.every((text): text is string => text !== null) ? texts : null;
};

// Text that cannot climb out of the directory it is appended to.
const descends = (text: string) => !text.split(/[/\\]/u).includes("..");

// A static relative segment without `..` cannot leave the directory it is
// joined under; anything else may.
const staysInside = (segments: readonly unknown[]) =>
  segments.every((input) => {
    const segment = unwrapExpression(input);
    if (!isAstNode(segment)) {
      return false;
    }
    const texts =
      segment.type === "Literal" && typeof segment.value === "string"
        ? [segment.value]
        : segment.type === "TemplateLiteral" &&
            Array.isArray(segment.expressions) &&
            segment.expressions.length === 0
          ? quasiTexts(segment.quasis)
          : null;
    return (
      texts !== null &&
      texts.every((text) => !/^[/\\]/u.test(text) && descends(text))
    );
  });

// Every value an expression may evaluate to: both branches of `a ? b : c`,
// both operands of `a ?? b` / `a || b` / `a && b`, the last item of `(a, b)`.
const alternatives = (node: AstNode): unknown[] => {
  if (node.type === "ConditionalExpression") {
    return [node.consequent, node.alternate];
  }
  if (node.type === "LogicalExpression") {
    return [node.left, node.right];
  }
  if (node.type === "SequenceExpression" && Array.isArray(node.expressions)) {
    return node.expressions.slice(-1);
  }
  return [];
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
      for (let index = parts.length - 1; index >= 0; index -= 1) {
        if (isCheckoutPath(parts[index], new Set(seen))) {
          return false;
        }
        if (isTemporaryRoot(parts[index], new Set(seen))) {
          return staysInside(parts.slice(index + 1));
        }
      }
      return false;
    }
    // path.join: the first segment is the base.
    return (
      operation === "join" &&
      parts.length > 0 &&
      isTemporaryRoot(parts[0], new Set(seen)) &&
      staysInside(parts.slice(1))
    );
  };

  // `a + "/x"` and `${a}/x`: the base keeps its exemption only when the
  // appended static text descends.
  const concatenationIsCheckoutPath = (
    node: AstNode,
    seen: Set<Variable>,
    exempt: boolean,
  ): boolean => {
    if (node.type === "BinaryExpression") {
      if (node.operator !== "+") {
        return false;
      }
      const right = unwrapExpression(node.right);
      const inside =
        exempt &&
        isAstNode(right) &&
        right.type === "Literal" &&
        typeof right.value === "string" &&
        descends(right.value);
      return (
        isCheckoutPath(node.left, new Set(seen), inside) ||
        isCheckoutPath(node.right, new Set(seen), exempt)
      );
    }
    if (!Array.isArray(node.expressions)) {
      return false;
    }
    // One interpolated base followed by static text that only descends.
    const texts = quasiTexts(node.quasis);
    const inside =
      exempt &&
      node.expressions.length === 1 &&
      texts !== null &&
      texts.every(descends);
    return node.expressions.some((expression) =>
      isCheckoutPath(expression, new Set(seen), inside),
    );
  };

  const callIsCheckoutPath = (
    node: AstNode,
    seen: Set<Variable>,
    exempt: boolean,
  ): boolean => {
    if (!Array.isArray(node.arguments)) {
      return false;
    }
    const operation = calleeName(node.callee);
    const parts: unknown[] = node.arguments;
    // path.resolve: the last absolute segment decides the destination.
    if (operation === "resolve") {
      for (let index = parts.length - 1; index >= 0; index -= 1) {
        const inside = exempt && staysInside(parts.slice(index + 1));
        if (inside && isTemporaryRoot(parts[index], new Set(seen))) {
          return false;
        }
        if (isCheckoutPath(parts[index], new Set(seen), inside)) {
          return true;
        }
      }
      return false;
    }
    // path.join: the first segment is the base the rest is joined under.
    if (operation === "join") {
      return (
        parts.length > 0 &&
        isCheckoutPath(
          parts[0],
          new Set(seen),
          exempt && staysInside(parts.slice(1)),
        )
      );
    }
    // Any other call (dirname, normalize, ...) may climb out of a temporary
    // directory, so its arguments are judged by where they were created.
    return parts.some((argument) =>
      isCheckoutPath(argument, new Set(seen), false),
    );
  };

  // `exempt: false` once a later segment may climb out of a temporary
  // directory: its location is then judged by where it was created.
  const isCheckoutPath = (
    input: unknown,
    seen = new Set<Variable>(),
    exempt = true,
  ): boolean => {
    const node = unwrapExpression(input);
    if (
      isImportMetaProperty(
        node,
        new Set(["dir", "dirname", "url", "path", "filename"]),
      )
    ) {
      return true;
    }
    // A mkdtemp directory is unique to its test, even inside the checkout.
    if (exempt && isTemporaryRoot(node, new Set(seen))) {
      return false;
    }
    if (isIdentifierReference(node)) {
      const variable = variableOf(node);
      if (variable === null || seen.has(variable)) {
        return false;
      }
      seen.add(variable);
      return isCheckoutPath(stableInitializer(variable), seen, exempt);
    }
    if (
      isAstNode(node) &&
      (node.type === "BinaryExpression" || node.type === "TemplateLiteral")
    ) {
      return concatenationIsCheckoutPath(node, seen, exempt);
    }
    if (isAstNode(node) && node.type === "CallExpression") {
      return callIsCheckoutPath(node, seen, exempt);
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
    if (isAstNode(node) && node.type === "MemberExpression") {
      return isCheckoutPath(node.object, seen, exempt);
    }
    if (isAstNode(node) && node.type === "AwaitExpression") {
      return isCheckoutPath(node.argument, seen, exempt);
    }
    if (isAstNode(node)) {
      return alternatives(node).some((candidate) =>
        isCheckoutPath(candidate, new Set(seen), exempt),
      );
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
            if (
              mutator !== null &&
              (mutator === "Bun.write" || MUTATORS.has(mutator))
            ) {
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
