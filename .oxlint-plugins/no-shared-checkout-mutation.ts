import { eslintCompatPlugin, type Variable } from "@oxlint/plugins";

import {
  type AstNode,
  isAstNode,
  isIdentifierReference,
  memberPropertyName,
  resolveImport,
  resolveVariable,
  type ScopeContext,
  stableInitializer,
  unwrapExpression,
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
  // Opens its destination with flag "w" by default, which truncates it.
  "createWriteStream",
]);
// CommonJS module locations, available as globals.
const CHECKOUT_GLOBALS = new Set(["__dirname", "__filename"]);

// Calls whose result names the same location as their first argument.
const LOCATION_PRESERVING = new Set([
  "pathToFileURL",
  "fileURLToPath",
  "String",
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
      texts?.every((text) => !/^[/\\]/u.test(text) && descends(text)) ?? false
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

// path.resolve discards every segment before a static absolute one, so only
// the segments after the last such literal can decide the destination.
const afterLastAbsolute = (parts: readonly unknown[]): unknown[] => {
  const last = parts.findLastIndex((input) => {
    const node = unwrapExpression(input);
    return (
      isAstNode(node) &&
      node.type === "Literal" &&
      typeof node.value === "string" &&
      node.value.startsWith("/")
    );
  });
  return parts.slice(last + 1);
};

// A static "" or root-only segment: joining an absolute path after it keeps
// that path's location.
const isRootOrEmptyLiteral = (input: unknown): boolean => {
  const node = unwrapExpression(input);
  return (
    isAstNode(node) &&
    node.type === "Literal" &&
    typeof node.value === "string" &&
    /^[/\\]*$/u.test(node.value)
  );
};

// A path operation by what it is, not how it is spelled: `join as joinPath`
// from node:path is still join.
const operationName = (
  context: ScopeContext,
  callee: unknown,
): string | null => {
  const binding = resolveImport(context, callee);
  return binding?.moduleId === "node:path" || binding?.moduleId === "path"
    ? binding.imported
    : calleeName(callee);
};

const createPathResolver = (context: ScopeContext) => {
  const variableOf = (node: unknown) =>
    isIdentifierReference(node) ? resolveVariable(context, node) : null;

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
    const operation = operationName(context, node.callee);
    // path.resolve: the last absolute segment decides, as for checkout paths.
    if (operation === "resolve") {
      const scan = afterLastAbsolute(parts);
      for (let index = scan.length - 1; index >= 0; index -= 1) {
        if (isCheckoutPath(scan[index], new Set(seen))) {
          return false;
        }
        if (isTemporaryRoot(scan[index], new Set(seen))) {
          return staysInside(scan.slice(index + 1));
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
      (texts?.every(descends) ?? false);
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
    const operation = operationName(context, node.callee);
    const parts: unknown[] = node.arguments;
    // path.resolve: the last absolute segment decides the destination.
    if (operation === "resolve") {
      const scan = afterLastAbsolute(parts);
      for (let index = scan.length - 1; index >= 0; index -= 1) {
        const inside = exempt && staysInside(scan.slice(index + 1));
        if (inside && isTemporaryRoot(scan[index], new Set(seen))) {
          return false;
        }
        if (isCheckoutPath(scan[index], new Set(seen), inside)) {
          return true;
        }
      }
      return false;
    }
    // path.join: the first segment is the base the rest is joined under.
    // Leading "" and "/" add nothing to an absolute base, so the first other
    // segment decides.
    if (operation === "join") {
      const base = parts.findIndex((part) => !isRootOrEmptyLiteral(part));
      return (
        base !== -1 &&
        isCheckoutPath(
          parts[base],
          new Set(seen),
          exempt && staysInside(parts.slice(base + 1)),
        )
      );
    }
    // Conversions between a path and a URL keep the location.
    if (operation !== null && LOCATION_PRESERVING.has(operation)) {
      return isCheckoutPath(parts[0], new Set(seen), exempt);
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
      // An undeclared __dirname or __filename is CommonJS's module location.
      if (variable === null || variable.defs.length === 0) {
        return CHECKOUT_GLOBALS.has(node.name);
      }
      if (seen.has(variable)) {
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
      if (!isIdentifierReference(node.callee) || node.callee.name !== "URL") {
        return false;
      }
      // new URL(relative, base): URL resolution (a base without a trailing
      // slash, encoded dots) can leave a temporary directory, so a base is
      // always judged by where it was created.
      const [relative, base] = node.arguments;
      return (
        isCheckoutPath(relative, new Set(seen), exempt) ||
        isCheckoutPath(base, new Set(seen), false)
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
            // A default `node:fs` import exposes the same functions as members.
            if (
              mutator === null &&
              isAstNode(node.callee) &&
              node.callee.type === "MemberExpression"
            ) {
              const receiver = resolveImport(context, node.callee.object);
              if (
                receiver?.imported === "default" &&
                NODE_FS_MODULES.has(receiver.moduleId)
              ) {
                mutator = memberPropertyName(node.callee);
              }
            }
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
