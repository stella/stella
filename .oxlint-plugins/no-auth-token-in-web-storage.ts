// Prevent browser-readable persistence of authentication credentials.
//
// Any script that runs in the page can read localStorage and sessionStorage,
// so an XSS turns a persisted bearer credential into an account takeover.
// Authentication tokens belong in server-set HttpOnly, Secure, SameSite
// cookies instead.
//
// The rule intentionally requires both a proven browser storage global and a
// credential-like static key. Dynamic keys, benign token vocabulary (CSRF,
// push, design tokens), and locally shadowed globals stay unreported.

import { eslintCompatPlugin } from "@oxlint/plugins";

import {
  getPropertyName,
  isAstNode,
  isIdentifier,
  isStringLiteral,
  unwrapExpression,
} from "./utils.ts";

const RULE_NAME = "no-auth-token-in-web-storage";
const STORAGE_NAMES = new Set(["localStorage", "sessionStorage"]);
const GLOBAL_HOST_NAMES = new Set(["globalThis", "self", "window"]);

// Keep this list high-signal. Broad words such as `auth`, `session`, and bare
// `key` routinely name harmless UI state.
const CREDENTIAL_KEY_PATTERN =
  /token|jwt|secret|password|passwd|credential|api[-_]?key|bearer|private[-_]?key/iu;
const NON_CREDENTIAL_TOKEN_PATTERN =
  /csrf|xsrf|device|fcm|apns|push|design|tokeniz|syntax|css|theme|color/iu;
const STRONG_CREDENTIAL_KEY_PATTERN =
  /jwt|secret|password|passwd|credential|private[-_]?key|api[-_]?key|bearer|access[-_]?token|refresh[-_]?token|auth[-_]?token|id[-_]?token|session/iu;

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
};

const staticTemplateValue = (node: unknown): string | null => {
  if (
    !isAstNode(node) ||
    node.type !== "TemplateLiteral" ||
    !Array.isArray(node.expressions) ||
    node.expressions.length !== 0 ||
    !Array.isArray(node.quasis) ||
    node.quasis.length !== 1
  ) {
    return null;
  }
  const quasi = node.quasis.at(0);
  if (
    !isAstNode(quasi) ||
    quasi.type !== "TemplateElement" ||
    typeof quasi.value !== "object" ||
    quasi.value === null ||
    !("cooked" in quasi.value)
  ) {
    return null;
  }
  return typeof quasi.value.cooked === "string" ? quasi.value.cooked : null;
};

const isCredentialKey = (key: string): boolean => {
  if (!CREDENTIAL_KEY_PATTERN.test(key)) {
    return false;
  }
  return (
    !NON_CREDENTIAL_TOKEN_PATTERN.test(key) ||
    STRONG_CREDENTIAL_KEY_PATTERN.test(key)
  );
};

export default eslintCompatPlugin({
  meta: { name: RULE_NAME },
  rules: {
    [RULE_NAME]: {
      meta: {
        type: "problem",
        messages: {
          noAuthTokenInWebStorage:
            "Do not store authentication credentials in localStorage or " +
            "sessionStorage; any script running in the page can read and " +
            "exfiltrate them. Use a server-set HttpOnly, Secure, SameSite " +
            "cookie instead.",
        },
      },
      createOnce(context) {
        const resolveVariable = (identifier): ScopeVariable | null => {
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

        const isGlobalReference = (node: unknown, name: string): boolean => {
          if (!isIdentifier(node, name)) {
            return false;
          }
          const variable = resolveVariable(node);
          return variable === null || variable.defs.length === 0;
        };

        const resolveStaticString = (
          node: unknown,
          visited = new Set<ScopeVariable>(),
        ): string | null => {
          const expression = unwrapExpression(node);
          if (expression === null) {
            return null;
          }
          if (isStringLiteral(expression)) {
            return expression.value;
          }
          const templateValue = staticTemplateValue(expression);
          if (templateValue !== null) {
            return templateValue;
          }
          if (
            expression.type === "BinaryExpression" &&
            expression.operator === "+"
          ) {
            const left = resolveStaticString(expression.left, new Set(visited));
            const right = resolveStaticString(
              expression.right,
              new Set(visited),
            );
            return left === null || right === null ? null : left + right;
          }
          if (!isIdentifier(expression)) {
            return null;
          }
          const variable = resolveVariable(expression);
          if (variable === null || visited.has(variable)) {
            return null;
          }
          visited.add(variable);
          for (const definition of variable.defs) {
            if (
              definition.type !== "Variable" ||
              !isAstNode(definition.node) ||
              definition.node.type !== "VariableDeclarator" ||
              !isAstNode(definition.parent) ||
              definition.parent.type !== "VariableDeclaration" ||
              definition.parent.kind !== "const"
            ) {
              continue;
            }
            return resolveStaticString(definition.node.init, visited);
          }
          return null;
        };

        const resolveMemberName = (node: unknown): string | null => {
          const member = unwrapExpression(node);
          if (member === null || member.type !== "MemberExpression") {
            return null;
          }
          return member.computed === true
            ? resolveStaticString(member.property)
            : getPropertyName(member.property);
        };

        const isBrowserGlobalHost = (
          node: unknown,
          visited = new Set<ScopeVariable>(),
        ): boolean => {
          const expression = unwrapExpression(node);
          if (expression === null) {
            return false;
          }
          if (
            isIdentifier(expression) &&
            GLOBAL_HOST_NAMES.has(expression.name)
          ) {
            return isGlobalReference(expression, expression.name);
          }
          if (expression.type === "MemberExpression") {
            const memberName = resolveMemberName(expression);
            return (
              memberName !== null &&
              GLOBAL_HOST_NAMES.has(memberName) &&
              isBrowserGlobalHost(expression.object, visited)
            );
          }
          if (!isIdentifier(expression)) {
            return false;
          }
          const variable = resolveVariable(expression);
          if (variable === null || visited.has(variable)) {
            return false;
          }
          visited.add(variable);
          for (const definition of variable.defs) {
            if (
              definition.type !== "Variable" ||
              !isAstNode(definition.node) ||
              definition.node.type !== "VariableDeclarator" ||
              !isAstNode(definition.parent) ||
              definition.parent.type !== "VariableDeclaration" ||
              definition.parent.kind !== "const"
            ) {
              continue;
            }
            return isBrowserGlobalHost(definition.node.init, visited);
          }
          return false;
        };

        const isWebStorage = (
          node: unknown,
          visited = new Set<ScopeVariable>(),
        ): boolean => {
          const expression = unwrapExpression(node);
          if (expression === null) {
            return false;
          }
          if (isIdentifier(expression) && STORAGE_NAMES.has(expression.name)) {
            return isGlobalReference(expression, expression.name);
          }
          if (isIdentifier(expression)) {
            const variable = resolveVariable(expression);
            if (variable === null || visited.has(variable)) {
              return false;
            }
            visited.add(variable);
            for (const definition of variable.defs) {
              if (
                definition.type !== "Variable" ||
                !isAstNode(definition.node) ||
                definition.node.type !== "VariableDeclarator" ||
                !isAstNode(definition.parent) ||
                definition.parent.type !== "VariableDeclaration" ||
                definition.parent.kind !== "const"
              ) {
                continue;
              }
              return isWebStorage(definition.node.init, visited);
            }
            return false;
          }
          if (expression.type !== "MemberExpression") {
            return false;
          }
          const storageName = resolveMemberName(expression);
          if (storageName === null || !STORAGE_NAMES.has(storageName)) {
            return false;
          }
          return isBrowserGlobalHost(expression.object);
        };

        const reportCredentialKeyValue = (
          node,
          keyValue: string | null,
        ): void => {
          if (keyValue === null || !isCredentialKey(keyValue)) {
            return;
          }
          context.report({ node, messageId: "noAuthTokenInWebStorage" });
        };

        const reportCredentialKey = (node, key: unknown): void => {
          reportCredentialKeyValue(node, resolveStaticString(key));
        };

        return {
          CallExpression(node) {
            const callee = unwrapExpression(node.callee);
            if (
              callee === null ||
              callee.type !== "MemberExpression" ||
              resolveMemberName(callee) !== "setItem" ||
              !isWebStorage(callee.object) ||
              !Array.isArray(node.arguments) ||
              node.arguments.length < 2
            ) {
              return;
            }
            reportCredentialKey(node, node.arguments.at(0));
          },
          AssignmentExpression(node) {
            const target = unwrapExpression(node.left);
            if (
              target === null ||
              target.type !== "MemberExpression" ||
              !isWebStorage(target.object)
            ) {
              return;
            }
            reportCredentialKeyValue(node, resolveMemberName(target));
          },
        };
      },
    },
  },
});
