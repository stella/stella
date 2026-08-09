import { eslintCompatPlugin } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";
// Reject filesystem containment checks that compare a resolved or normalized
// candidate with a bare string prefix. `startsWith(root)` also accepts sibling
// paths such as `/safe/root-backup`, so it is not an authorization boundary.
//
// The rule is deliberately provenance-based: only helpers imported from
// `node:path` or `path` make an expression path-derived. Ordinary string and
// URL prefix checks, same-named local helpers, and shadowed imports stay clean.
//
// Flagged:
//   path.resolve(root, input).startsWith(root)
//   path.normalize(candidate).startsWith(path.normalize(root))
//
// Allowed:
//   candidate.startsWith(`${root}${path.sep}`)
//   const relative = path.relative(root, candidate)
//   !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)

import {
  getImportedName,
  getPropertyName,
  isAstNode,
  isIdentifier,
  isStringLiteral,
} from "./utils.ts";
import type { AstNode } from "./utils.ts";

const PATH_MODULES = new Set(["node:path", "path"]);
const PATH_VALUE_APIS = new Set(["dirname", "join", "normalize", "resolve"]);
const ROOTED_PATH_VALUE_APIS = new Set(["join", "resolve"]);
const PATH_PLATFORMS = new Set(["posix", "win32"]);
const PATH_SEPARATORS = new Set(["/", "\\"]);

type Scope = {
  set: Map<string, ScopeVariable>;
  upper: Scope | null;
};

type ScopeVariable = {
  defs: {
    node: unknown;
    parent: unknown;
    type: string;
  }[];
  references: {
    init?: boolean;
    isWrite?: () => boolean;
  }[];
};

type IdentifierNode = ESTree.IdentifierReference;

const WRAPPER_TYPES = new Set([
  "ChainExpression",
  "ParenthesizedExpression",
  "TSAsExpression",
  "TSNonNullExpression",
  "TSSatisfiesExpression",
  "TSTypeAssertion",
]);

const unwrapExpression = (node: unknown): AstNode | null => {
  let current = isAstNode(node) ? node : null;
  while (current !== null && WRAPPER_TYPES.has(current.type)) {
    current = isAstNode(current.expression) ? current.expression : null;
  }
  return current;
};

const isEstreeIdentifier = (node: unknown): node is IdentifierNode =>
  isIdentifier(node) && Array.isArray(node.range);

const importedPathBinding = (
  variable: ScopeVariable | null,
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

const stableInitializer = (variable: ScopeVariable): AstNode | null => {
  for (const definition of variable.defs) {
    if (
      definition.type !== "Variable" ||
      !isAstNode(definition.node) ||
      definition.node.type !== "VariableDeclarator" ||
      !isAstNode(definition.parent) ||
      definition.parent.type !== "VariableDeclaration"
    ) {
      continue;
    }
    if (
      definition.parent.kind !== "const" &&
      variable.references.some(
        (reference) =>
          reference.init !== true && reference.isWrite?.() === true,
      )
    ) {
      return null;
    }
    return unwrapExpression(definition.node.init);
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
        const resolveVariable = (
          identifier: IdentifierNode,
        ): ScopeVariable | null => {
          let scope: Scope | null = context.sourceCode.getScope(identifier);
          while (scope !== null) {
            const variable = scope.set.get(identifier.name);
            if (variable !== undefined) {
              return variable;
            }
            scope = scope.upper;
          }
          return null;
        };

        const resolveStableExpression = (
          node: unknown,
          visited = new Set<ScopeVariable>(),
        ): AstNode | null => {
          const expression = unwrapExpression(node);
          if (!isEstreeIdentifier(expression)) {
            return expression;
          }
          const variable = resolveVariable(expression);
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
          if (member === null || !isEstreeIdentifier(member.root)) {
            return null;
          }
          const imported = importedPathBinding(resolveVariable(member.root));
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
            isEstreeIdentifier(stableLeft) &&
            isEstreeIdentifier(stableRight)
          ) {
            const leftVariable = resolveVariable(stableLeft);
            return (
              leftVariable !== null &&
              leftVariable === resolveVariable(stableRight)
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

        return {
          CallExpression(node) {
            if (
              !isAstNode(node.callee) ||
              node.callee.type !== "MemberExpression" ||
              getPropertyName(node.callee.property) !== "startsWith" ||
              !Array.isArray(node.arguments)
            ) {
              return;
            }
            const hasEquivalentStartPosition =
              node.arguments.length === 1 ||
              (node.arguments.length === 2 &&
                isZeroStartPosition(node.arguments.at(1)));
            if (!hasEquivalentStartPosition) {
              return;
            }
            const prefix = node.arguments.at(0);
            if (hasPathSeparatorSuffix(prefix)) {
              return;
            }
            const candidateCall = getPathValueCall(node.callee.object);
            if (candidateCall === null) {
              return;
            }

            // `resolve(root, child).startsWith(root)` is unsafe even when the
            // root itself is a raw parameter. Otherwise require both sides to
            // have explicit Node path provenance to avoid generic string hits.
            const candidateApi = nodePathApiParts(candidateCall.callee)?.at(-1);
            const firstCandidateArgument = Array.isArray(
              candidateCall.arguments,
            )
              ? candidateCall.arguments.at(0)
              : undefined;
            const resolvesFromPrefix =
              candidateApi !== undefined &&
              ROOTED_PATH_VALUE_APIS.has(candidateApi) &&
              Array.isArray(candidateCall.arguments) &&
              candidateCall.arguments.length >= 2 &&
              sameStableExpression(firstCandidateArgument, prefix);
            if (!resolvesFromPrefix && getPathValueCall(prefix) === null) {
              return;
            }

            context.report({ node, messageId: "noPathPrefixContainment" });
          },
        };
      },
    },
  },
});
