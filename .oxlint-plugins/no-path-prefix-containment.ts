// Reject filesystem containment checks that compare a resolved or normalized
// candidate with a bare string prefix. `startsWith(root)` also accepts sibling
// paths such as `/safe/root-backup`, so it is not an authorization boundary.
//
// The rule is deliberately provenance-based: only helpers imported from
// `node:path` or `path` (or their `/posix` and `/win32` entry points) make an
// expression path-derived. Ordinary string and
// URL prefix checks, same-named local helpers, and shadowed imports stay clean.
//
// Flagged:
//   path.resolve(root, input).startsWith(root)
//   path.normalize(candidate).startsWith(path.normalize(root))
//   path.resolve(root, input).indexOf(root) === 0
//
// Allowed:
//   candidate.startsWith(`${root}${path.sep}`)
//   const relative = path.relative(root, candidate)
//   !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)

import { eslintCompatPlugin } from "@oxlint/plugins";
import type { Variable } from "@oxlint/plugins";

import {
  getImportedName,
  getPropertyName,
  isAstNode,
  isIdentifierReference,
  isStringLiteral,
  resolveVariable,
  stableInitializer,
  unwrapExpression,
} from "./utils.ts";
import type { AstNode } from "./utils.ts";

// The platform entry points export the same API as the default module.
const PATH_MODULES = new Set([
  "node:path",
  "node:path/posix",
  "node:path/win32",
  "path",
  "path/posix",
  "path/win32",
]);
const PATH_VALUE_APIS = new Set(["dirname", "join", "normalize", "resolve"]);
const PATH_PLATFORMS = new Set(["posix", "win32"]);
const PATH_SEPARATORS = new Set(["/", "\\"]);
const EQUALITY_OPERATORS: ReadonlySet<string> = new Set([
  "!=",
  "!==",
  "==",
  "===",
]);

const importedPathBinding = (
  variable: Variable | null,
): { importedName: string | null; type: string } | null => {
  if (variable === null) {
    return null;
  }
  for (const definition of variable.defs) {
    if (
      definition.type !== "ImportBinding" ||
      !isAstNode(definition.node) ||
      !isAstNode(definition.parent) ||
      definition.parent.type !== "ImportDeclaration" ||
      !isStringLiteral(definition.parent.source) ||
      !PATH_MODULES.has(definition.parent.source.value)
    ) {
      continue;
    }
    return {
      importedName: getImportedName(definition.node),
      type: definition.node.type,
    };
  }
  return null;
};

const staticMemberParts = (
  node: unknown,
): { parts: string[]; root: AstNode } | null => {
  const expression = unwrapExpression(node);
  if (expression === null) {
    return null;
  }
  if (expression.type !== "MemberExpression") {
    return { parts: [], root: expression };
  }
  const property = getPropertyName(expression.property);
  if (property === null) {
    return null;
  }
  const parent = staticMemberParts(expression.object);
  if (parent === null) {
    return null;
  }
  parent.parts.push(property);
  return parent;
};

export default eslintCompatPlugin({
  meta: { name: "no-path-prefix-containment" },
  rules: {
    "no-path-prefix-containment": {
      meta: {
        type: "problem",
        messages: {
          noPathPrefixContainment:
            "A bare path prefix also accepts sibling paths such as " +
            "'<root>-backup'. Use path.relative() with '..' and absolute-path " +
            "checks, or an approved boundary-aware containment helper.",
        },
      },
      createOnce(context) {
        const variableFor = (node: unknown): Variable | null =>
          isIdentifierReference(node) ? resolveVariable(context, node) : null;

        const resolveStableExpression = (
          node: unknown,
          visited = new Set<Variable>(),
        ): AstNode | null => {
          const expression = unwrapExpression(node);
          if (!isIdentifierReference(expression)) {
            return expression;
          }
          const variable = variableFor(expression);
          if (variable === null || visited.has(variable)) {
            return expression;
          }
          const initializer = stableInitializer(variable);
          if (initializer === null) {
            return expression;
          }
          visited.add(variable);
          return resolveStableExpression(initializer, visited);
        };

        // Resolve a reference to a Node path API through either a named import
        // (`resolvePath`) or a namespace/default import (`path.win32.resolve`).
        // Binding lookup is essential: spelling alone would let shadowed or
        // unrelated helpers impersonate the trusted path module.
        const nodePathApiParts = (node: unknown): string[] | null => {
          const member = staticMemberParts(node);
          if (member === null) {
            return null;
          }
          const imported = importedPathBinding(variableFor(member.root));
          if (imported === null) {
            return null;
          }
          if (
            imported.type === "ImportDefaultSpecifier" ||
            imported.type === "ImportNamespaceSpecifier"
          ) {
            return member.parts;
          }
          if (imported.importedName === null) {
            return null;
          }
          return [imported.importedName, ...member.parts];
        };

        const isNodePathApi = (node: unknown, api: string): boolean => {
          const parts = nodePathApiParts(node);
          if (parts === null || parts.at(-1) !== api) {
            return false;
          }
          return (
            parts.length === 1 ||
            (parts.length === 2 && PATH_PLATFORMS.has(parts[0] ?? ""))
          );
        };

        const getPathValueCall = (node: unknown): AstNode | null => {
          const expression = resolveStableExpression(node);
          if (
            expression?.type !== "CallExpression" ||
            !isAstNode(expression.callee)
          ) {
            return null;
          }
          const parts = nodePathApiParts(expression.callee);
          const api = parts?.at(-1);
          if (
            api === undefined ||
            !PATH_VALUE_APIS.has(api) ||
            !isNodePathApi(expression.callee, api)
          ) {
            return null;
          }
          return expression;
        };

        const sameStableExpression = (
          left: unknown,
          right: unknown,
        ): boolean => {
          const stableLeft = resolveStableExpression(left);
          const stableRight = resolveStableExpression(right);
          if (stableLeft === null || stableRight === null) {
            return false;
          }
          if (stableLeft === stableRight) {
            return true;
          }
          if (
            isIdentifierReference(stableLeft) &&
            isIdentifierReference(stableRight)
          ) {
            const leftVariable = variableFor(stableLeft);
            return (
              leftVariable !== null && leftVariable === variableFor(stableRight)
            );
          }
          return (
            isStringLiteral(stableLeft) &&
            isStringLiteral(stableRight) &&
            stableLeft.value === stableRight.value
          );
        };

        const isZeroStartPosition = (node: unknown): boolean => {
          const expression = resolveStableExpression(node);
          if (expression?.type === "Literal") {
            return expression.value === 0;
          }
          if (
            expression?.type !== "UnaryExpression" ||
            (expression.operator !== "+" && expression.operator !== "-")
          ) {
            return false;
          }
          const argument = unwrapExpression(expression.argument);
          return argument?.type === "Literal" && argument.value === 0;
        };

        const isPathSeparator = (node: unknown): boolean => {
          const expression = resolveStableExpression(node);
          return (
            (isStringLiteral(expression) &&
              PATH_SEPARATORS.has(expression.value)) ||
            isNodePathApi(expression, "sep")
          );
        };

        const hasPathSeparatorSuffix = (node: unknown): boolean => {
          const expression = resolveStableExpression(node);
          if (isStringLiteral(expression)) {
            return [...PATH_SEPARATORS].some((separator) =>
              expression.value.endsWith(separator),
            );
          }
          if (expression?.type === "ConditionalExpression") {
            if (
              hasPathSeparatorSuffix(expression.consequent) &&
              hasPathSeparatorSuffix(expression.alternate)
            ) {
              return true;
            }
            const test = unwrapExpression(expression.test);
            if (
              test?.type !== "CallExpression" ||
              !isAstNode(test.callee) ||
              test.callee.type !== "MemberExpression" ||
              getPropertyName(test.callee.property) !== "endsWith" ||
              !Array.isArray(test.arguments) ||
              test.arguments.length !== 1 ||
              !isPathSeparator(test.arguments.at(0)) ||
              !sameStableExpression(test.callee.object, expression.consequent)
            ) {
              return false;
            }
            return hasPathSeparatorSuffix(expression.alternate);
          }
          if (
            expression?.type === "BinaryExpression" &&
            expression.operator === "+"
          ) {
            return isPathSeparator(expression.right);
          }
          if (expression?.type !== "TemplateLiteral") {
            return false;
          }
          const quasis = Array.isArray(expression.quasis)
            ? expression.quasis
            : [];
          const trailingQuasi = quasis.at(-1);
          if (!isAstNode(trailingQuasi)) {
            return false;
          }
          const value =
            typeof trailingQuasi.value === "object" &&
            trailingQuasi.value !== null
              ? trailingQuasi.value
              : null;
          const trailingText =
            value !== null &&
            "cooked" in value &&
            typeof value.cooked === "string"
              ? value.cooked
              : value !== null &&
                  "raw" in value &&
                  typeof value.raw === "string"
                ? value.raw
                : "";
          if (
            [...PATH_SEPARATORS].some((separator) =>
              trailingText.endsWith(separator),
            )
          ) {
            return true;
          }
          const expressions = Array.isArray(expression.expressions)
            ? expression.expressions
            : [];
          return trailingText === "" && isPathSeparator(expressions.at(-1));
        };

        // Whether `call` is `<path value>.<method>(prefix[, 0])` with a
        // prefix that does not end at a path separator.
        const isBarePrefixCall = (call: unknown, method: string): boolean => {
          const expression = unwrapExpression(call);
          if (
            expression?.type !== "CallExpression" ||
            !isAstNode(expression.callee) ||
            expression.callee.type !== "MemberExpression" ||
            getPropertyName(expression.callee.property) !== method ||
            !Array.isArray(expression.arguments)
          ) {
            return false;
          }
          const args = expression.arguments;
          const hasEquivalentStartPosition =
            args.length === 1 ||
            (args.length === 2 && isZeroStartPosition(args.at(1)));
          return (
            hasEquivalentStartPosition &&
            !hasPathSeparatorSuffix(args.at(0)) &&
            getPathValueCall(expression.callee.object) !== null
          );
        };

        return {
          CallExpression(node) {
            if (isBarePrefixCall(node, "startsWith")) {
              context.report({ node, messageId: "noPathPrefixContainment" });
            }
          },
          // `candidate.indexOf(root) === 0` and its negated / mirrored forms.
          BinaryExpression(node) {
            if (!EQUALITY_OPERATORS.has(node.operator)) {
              return;
            }
            const comparesIndexToZero =
              (isZeroStartPosition(node.right) &&
                isBarePrefixCall(node.left, "indexOf")) ||
              (isZeroStartPosition(node.left) &&
                isBarePrefixCall(node.right, "indexOf"));
            if (comparesIndexToZero) {
              context.report({ node, messageId: "noPathPrefixContainment" });
            }
          },
        };
      },
    },
  },
});
