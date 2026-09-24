// Prevent browser-readable persistence of authentication credentials.
//
// Any script that runs in the page can read localStorage and sessionStorage,
// so an XSS turns a persisted bearer credential into an account takeover.
// Authentication tokens belong in server-set HttpOnly, Secure, SameSite
// cookies instead.
//
// The rule requires a proven browser storage global and either a
// credential-like static key or a stored value that serializes credential-like
// fields (`JSON.stringify({ accessToken })`). A key is static when it is a
// literal, a `const`, or an export of a repository module whose declaration is
// a string literal; an imported key that cannot be read counts by its export
// name. A local helper that forwards its parameters to `setItem` is checked at
// each of its call sites. Dynamic keys, benign token vocabulary (CSRF, push,
// design tokens), and locally shadowed globals stay unreported.

import { eslintCompatPlugin } from "@oxlint/plugins";
import type { Variable } from "@oxlint/plugins";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import type { AstNode } from "./utils.ts";
import {
  everyNode,
  getPropertyName,
  invokedCallee,
  isAstNode,
  isIdentifier,
  isIdentifierReference,
  isMemberAccess,
  isStringLiteral,
  resolveImport,
  resolveVariable,
  unwrapExpression,
} from "./utils.ts";

const RULE_NAME = "no-auth-token-in-web-storage";
const STORAGE_NAMES = new Set(["localStorage", "sessionStorage"]);
const GLOBAL_HOST_NAMES = new Set(["globalThis", "self", "window"]);
const MODULE_EXTENSIONS = [".ts", ".tsx", "/index.ts", "/index.tsx"];

// Keep this list high-signal. Broad words such as `auth`, `session`, and bare
// `key` routinely name harmless UI state.
const CREDENTIAL_KEY_PATTERN =
  /token|jwt|secret|password|passwd|credential|api[-_]?key|bearer|private[-_]?key/iu;
const NON_CREDENTIAL_TOKEN_PATTERN =
  /csrf|xsrf|device|fcm|apns|push|design|tokeniz|syntax|css|theme|color/iu;
const STRONG_CREDENTIAL_KEY_PATTERN =
  /jwt|secret|password|passwd|credential|private[-_]?key|api[-_]?key|bearer|access[-_]?token|refresh[-_]?token|auth[-_]?token|id[-_]?token|session/iu;

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

// An export name is an identifier; `$` is its only regex metacharacter.
const escapeIdentifier = (name: string): string =>
  name.replaceAll("$", () => String.raw`\$`);

// Module sources read once per lint process; `null` when the module is not a
// repository file.
const moduleSources = new Map<string, string | null>();

const readModuleSource = (moduleId: string): string | null => {
  const cached = moduleSources.get(moduleId);
  if (cached !== undefined) {
    return cached;
  }
  const file = MODULE_EXTENSIONS.map((extension) =>
    path.join(process.cwd(), `${moduleId}${extension}`),
  ).find((candidate) => existsSync(candidate));
  const source = file === undefined ? null : readFileSync(file, "utf-8");
  moduleSources.set(moduleId, source);
  return source;
};

// The string literal a repository module exports under `name`
// (`export const NAME = "value"`, with an optional type or `as const`).
const exportedStringConstant = (
  moduleId: string,
  name: string,
): string | null => {
  const source = readModuleSource(moduleId);
  if (source === null) {
    return null;
  }
  const declaration = new RegExp(
    `export\\s+const\\s+${escapeIdentifier(name)}\\s*(?::[^=]+)?=\\s*(["'\\x60])([^"'\\x60$\\\\]*)\\1`,
    "u",
  ).exec(source);
  return declaration?.[2] ?? null;
};

// `JSON.stringify(x)` stores what `x` holds, so a helper that serializes its
// parameter still forwards it.
const unwrapSerialization = (node: unknown): AstNode | null => {
  const expression = unwrapExpression(node);
  if (
    expression?.type === "CallExpression" &&
    isMemberAccess(expression.callee, "JSON", "stringify") &&
    Array.isArray(expression.arguments)
  ) {
    return unwrapExpression(expression.arguments.at(0));
  }
  return expression;
};

const constDeclarator = (variable: Variable): AstNode | null => {
  for (const definition of variable.defs) {
    if (
      definition.type === "Variable" &&
      isAstNode(definition.node) &&
      definition.node.type === "VariableDeclarator" &&
      isAstNode(definition.parent) &&
      definition.parent.type === "VariableDeclaration" &&
      definition.parent.kind === "const"
    ) {
      return definition.node;
    }
  }
  return null;
};

// Where a forwarding helper passes its parameters: the positions of the
// parameters that reach the storage key and value, or null for either one the
// helper computes itself.
type ForwardedSlots = { key: number | null; value: number | null };

type StorageWrite = { key: unknown; value: unknown };

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
        const variableFor = (node: unknown): Variable | null =>
          isIdentifierReference(node) ? resolveVariable(context, node) : null;

        const isGlobalReference = (node: unknown, name: string): boolean => {
          if (!isIdentifier(node, name)) {
            return false;
          }
          const variable = variableFor(node);
          return variable === null || variable.defs.length === 0;
        };

        // The initializer of a `const` binding the identifier resolves to.
        const constInitializer = (
          node: unknown,
          visited: Set<Variable>,
        ): unknown => {
          const variable = variableFor(node);
          if (variable === null || visited.has(variable)) {
            return null;
          }
          visited.add(variable);
          return constDeclarator(variable)?.init ?? null;
        };

        // An imported key: the exported literal when the module is a
        // repository file, else the export name itself when it reads like a
        // credential key (`ACCESS_TOKEN_KEY`).
        const importedKeyValue = (node: AstNode): string | null => {
          const resolved = resolveImport(context, node);
          if (resolved === null) {
            return null;
          }
          const value = exportedStringConstant(
            resolved.moduleId,
            resolved.imported,
          );
          if (value !== null) {
            return value;
          }
          return isCredentialKey(resolved.imported) ? resolved.imported : null;
        };

        const resolveStaticString = (
          node: unknown,
          visited = new Set<Variable>(),
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
          if (expression.type === "MemberExpression") {
            return importedKeyValue(expression);
          }
          if (!isIdentifier(expression)) {
            return null;
          }
          const imported = importedKeyValue(expression);
          if (imported !== null) {
            return imported;
          }
          const initializer = constInitializer(expression, visited);
          return initializer === null
            ? null
            : resolveStaticString(initializer, visited);
        };

        const resolveMemberName = (node: unknown): string | null => {
          const member = unwrapExpression(node);
          if (member?.type !== "MemberExpression") {
            return null;
          }
          return member.computed === true
            ? resolveStaticString(member.property)
            : getPropertyName(member.property);
        };

        const isBrowserGlobalHost = (
          node: unknown,
          visited = new Set<Variable>(),
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
          const initializer = constInitializer(expression, visited);
          return (
            initializer !== null && isBrowserGlobalHost(initializer, visited)
          );
        };

        const isWebStorage = (
          node: unknown,
          visited = new Set<Variable>(),
        ): boolean => {
          const expression = unwrapExpression(node);
          if (expression === null) {
            return false;
          }
          if (isIdentifier(expression) && STORAGE_NAMES.has(expression.name)) {
            return isGlobalReference(expression, expression.name);
          }
          if (isIdentifier(expression)) {
            const initializer = constInitializer(expression, visited);
            return initializer !== null && isWebStorage(initializer, visited);
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

        // Whether a stored value serializes a credential-like field:
        // `JSON.stringify({ accessToken })`, or a const object literal with
        // such a key passed through `JSON.stringify`.
        const serializesCredential = (
          node: unknown,
          visited = new Set<Variable>(),
        ): boolean => {
          const expression = unwrapExpression(node);
          if (expression === null) {
            return false;
          }
          if (expression.type === "CallExpression") {
            const serialized = unwrapSerialization(expression);
            return (
              serialized !== expression &&
              serializesCredential(serialized, visited)
            );
          }
          if (expression.type === "ObjectExpression") {
            const properties = Array.isArray(expression.properties)
              ? expression.properties
              : [];
            return properties.some((property) => {
              if (!isAstNode(property)) {
                return false;
              }
              if (property.type === "SpreadElement") {
                return serializesCredential(property.argument, visited);
              }
              const key =
                property.computed === true
                  ? resolveStaticString(property.key)
                  : getPropertyName(property.key);
              return key !== null && isCredentialKey(key);
            });
          }
          if (!isIdentifier(expression)) {
            return false;
          }
          const initializer = constInitializer(expression, visited);
          return (
            initializer !== null && serializesCredential(initializer, visited)
          );
        };

        // --- Forwarding helpers -----------------------------------------

        const forwardedSlotsCache = new Map<AstNode, ForwardedSlots | null>();

        // The parameter position an argument of a write inside `fn` comes
        // from, or null when it is not one of `fn`'s own parameters.
        const parameterIndex = (fn: AstNode, node: unknown): number | null => {
          const variable = variableFor(unwrapSerialization(node));
          const definition = variable?.defs.at(0);
          const owner: unknown = definition?.node;
          const params: unknown = fn.params;
          if (
            definition?.type !== "Parameter" ||
            owner !== fn ||
            !Array.isArray(params)
          ) {
            return null;
          }
          const binding: unknown = definition.name;
          const index = params.findIndex(
            (param: unknown) =>
              param === binding ||
              (isAstNode(param) &&
                param.type === "AssignmentPattern" &&
                param.left === binding),
          );
          return index === -1 ? null : index;
        };

        // The function a callee identifier is bound to: a function
        // declaration, or a `const` arrow / function expression.
        const localFunction = (callee: unknown): AstNode | null => {
          const variable = variableFor(unwrapExpression(callee));
          const definition = variable?.defs.at(0);
          if (variable === null || definition === undefined) {
            return null;
          }
          if (
            definition.type === "FunctionName" &&
            isAstNode(definition.node)
          ) {
            return definition.node;
          }
          const init = unwrapExpression(constDeclarator(variable)?.init);
          return init?.type === "ArrowFunctionExpression" ||
            init?.type === "FunctionExpression"
            ? init
            : null;
        };

        const forwardedSlots = (fn: AstNode): ForwardedSlots | null => {
          if (forwardedSlotsCache.has(fn)) {
            return forwardedSlotsCache.get(fn) ?? null;
          }
          // Recursive helpers settle on "not forwarding" for the cycle.
          forwardedSlotsCache.set(fn, null);
          let slots: ForwardedSlots | null = null;
          for (const inner of everyNode(fn)) {
            if (inner.type !== "CallExpression") {
              continue;
            }
            const write = storageWrite(inner);
            if (write === null) {
              continue;
            }
            const key = parameterIndex(fn, write.key);
            const value = parameterIndex(fn, write.value);
            if (key !== null || value !== null) {
              slots = { key, value };
              break;
            }
          }
          forwardedSlotsCache.set(fn, slots);
          return slots;
        };

        // The key and value a call writes to web storage: a direct
        // `setItem`, or a call to a local helper that forwards its
        // parameters to one.
        const storageWrite = (call: AstNode): StorageWrite | null => {
          const callee = invokedCallee(call);
          const args = Array.isArray(call.arguments) ? call.arguments : [];
          if (
            callee?.type === "MemberExpression" &&
            resolveMemberName(callee) === "setItem" &&
            isWebStorage(callee.object)
          ) {
            return args.length < 2
              ? null
              : { key: args.at(0), value: args.at(1) };
          }
          const fn = localFunction(call.callee);
          const slots = fn === null ? null : forwardedSlots(fn);
          if (slots === null) {
            return null;
          }
          return {
            key: slots.key === null ? null : args.at(slots.key),
            value: slots.value === null ? null : args.at(slots.value),
          };
        };

        const isCredentialWrite = (key: string | null, value: unknown) =>
          (key !== null && isCredentialKey(key)) || serializesCredential(value);

        return {
          CallExpression(node) {
            const call: unknown = node;
            if (!isAstNode(call)) {
              return;
            }
            const write = storageWrite(call);
            if (
              write === null ||
              !isCredentialWrite(resolveStaticString(write.key), write.value)
            ) {
              return;
            }
            context.report({ node, messageId: "noAuthTokenInWebStorage" });
          },
          AssignmentExpression(node) {
            const target = unwrapExpression(node.left);
            if (
              target?.type !== "MemberExpression" ||
              !isWebStorage(target.object) ||
              !isCredentialWrite(resolveMemberName(target), node.right)
            ) {
              return;
            }
            context.report({ node, messageId: "noAuthTokenInWebStorage" });
          },
        };
      },
    },
  },
});
