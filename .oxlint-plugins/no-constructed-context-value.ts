// A context provider's `value` must keep its identity across renders.
//
// Every consumer of a context re-renders when the provider's `value` is a
// different object from the last render's. An object, array, function or
// element written in the provider's render is a new one every time, so each
// render of the provider re-renders every consumer, memoized or not. The React
// Compiler caches such a value where it compiles; this rule covers the code it
// does not reach. The production config enables it on sources that render
// uncompiled somewhere they ship, and on each function
// `scripts/react-compiler-bailouts.json` records, through the `functions`
// option (see below).
//
// The built-in `react/jsx-no-constructed-context-values` recognises the React
// 19 provider form (`<ThemeContext value={...}>`) only when the context is
// created in the same file, and most providers here render an imported one.
// This rule treats `<X.Provider>`, an element named `...Context`, and any
// element bound to a local `createContext(...)` as a provider.
//
// Option `functions`: report only inside these functions, named as
// `scripts/rc-bailouts.ts` names them (declaration or binding name, method
// key). The compiler skips a bailing function's whole outermost component or
// hook, so the rule covers that outermost function. `<module-transform>`
// covers the whole file. Without the option, the whole file is covered.
//
// Flagged:
//   <ThemeContext value={{ theme, setTheme }}>      an object built in render
//   <Ctx.Provider value={[state, dispatch]}>        an array
//   const value = { theme }; <ThemeContext value={value}>
//   <ThemeContext value={ready ? { theme } : null}> a branch builds one
//
// Allowed:
//   const value = useMemo(() => ({ theme }), [theme]); <ThemeContext value={value}>
//   <ThemeContext value={MODULE_CONSTANT}>         built once, at module scope
//   <ThemeContext value={theme}>                     a value from props or state
import type { Context, ESTree } from "@oxlint/plugins";
import { eslintCompatPlugin } from "@oxlint/plugins";

import {
  type AstNode,
  isAstNode,
  isIdentifierReference,
  jsxName,
  resolveVariable,
  stableInitializer,
  unwrapExpression,
} from "./utils.ts";

const CONTEXT_SUFFIX = "Context";
const MODULE_TRANSFORM = "<module-transform>";
const FUNCTION_TYPES: ReadonlySet<string> = new Set([
  "ArrowFunctionExpression",
  "FunctionDeclaration",
  "FunctionExpression",
]);
const CREATE_CONTEXT = "createContext";
// How many `const a = b` hops an identifier value is followed through.
const MAX_ALIAS_DEPTH = 4;

const MESSAGE =
  "This context value is a new {{kind}} on every render, so every consumer re-renders whenever the provider does, and the React Compiler does not memoize it here: it does not compile this code, or bails out of this function. Hoist the value to module scope if it does not depend on render values, or build it with useMemo (useCallback for a function).";

const KIND_BY_TYPE: Readonly<Record<string, string>> = {
  ArrayExpression: "array",
  ArrowFunctionExpression: "function",
  ClassExpression: "class",
  FunctionExpression: "function",
  JSXElement: "JSX element",
  JSXFragment: "JSX element",
  NewExpression: "instance",
  ObjectExpression: "object",
};

/** Whether `call` is `createContext(...)` or `React.createContext(...)`. */
const isCreateContextCall = (call: AstNode | null): boolean => {
  if (call?.type !== "CallExpression") {
    return false;
  }
  const callee = unwrapExpression(call.callee);
  if (callee?.type === "Identifier") {
    return callee.name === CREATE_CONTEXT;
  }
  return (
    callee?.type === "MemberExpression" &&
    isAstNode(callee.property) &&
    callee.property.type === "Identifier" &&
    callee.property.name === CREATE_CONTEXT
  );
};

const isJsxIdentifier = (node: unknown): node is ESTree.JSXIdentifier =>
  isAstNode(node) &&
  node.type === "JSXIdentifier" &&
  typeof node.name === "string" &&
  Array.isArray(node.range);

/** Whether the element `name` renders a context provider. */
const isProviderName = (context: Context, name: unknown): boolean => {
  if (!isAstNode(name)) {
    return false;
  }
  if (name.type === "JSXMemberExpression") {
    const property = jsxName(name.property);
    return (
      property === "Provider" || (property?.endsWith(CONTEXT_SUFFIX) ?? false)
    );
  }
  if (!isJsxIdentifier(name)) {
    return false;
  }
  if (name.name.endsWith(CONTEXT_SUFFIX)) {
    return true;
  }
  const variable = resolveVariable(context, name);
  return variable !== null && isCreateContextCall(stableInitializer(variable));
};

/**
 * What a render-scope variable holds when its declaration builds a fresh
 * value, or null. Module-scope bindings, parameters, imports and call results
 * (hooks included) keep their identity as far as this rule can tell.
 */
const variableKind = (
  context: Context,
  node: AstNode,
  depth: number,
): string | null => {
  if (!isIdentifierReference(node) || depth > MAX_ALIAS_DEPTH) {
    return null;
  }
  const variable = resolveVariable(context, node);
  const definition = variable?.defs.at(0);
  if (
    variable === null ||
    definition === undefined ||
    variable.scope.variableScope.type === "module" ||
    variable.scope.variableScope.type === "global"
  ) {
    return null;
  }
  if (definition.type === "FunctionName") {
    return "function";
  }
  if (definition.type === "ClassName") {
    return "class";
  }
  const initializer = stableInitializer(variable);
  return initializer === null
    ? null
    : constructedKind(context, initializer, depth + 1);
};

/** What `value` builds on every evaluation, or null when it keeps identity. */
const constructedKind = (
  context: Context,
  value: unknown,
  depth: number,
): string | null => {
  const node = unwrapExpression(value);
  if (node === null) {
    return null;
  }
  const kind = KIND_BY_TYPE[node.type];
  if (kind !== undefined) {
    return kind;
  }
  switch (node.type) {
    case "Literal":
      return typeof node.regex === "object" && node.regex !== null
        ? "regular expression"
        : null;
    case "ConditionalExpression":
      return (
        constructedKind(context, node.consequent, depth) ??
        constructedKind(context, node.alternate, depth)
      );
    case "LogicalExpression":
      return (
        constructedKind(context, node.left, depth) ??
        constructedKind(context, node.right, depth)
      );
    case "AssignmentExpression":
      return constructedKind(context, node.right, depth);
    case "SequenceExpression":
      return Array.isArray(node.expressions)
        ? constructedKind(context, node.expressions.at(-1), depth)
        : null;
    case "Identifier":
      return variableKind(context, node, depth);
    default:
      return null;
  }
};

const parentOf = (node: AstNode): AstNode | null =>
  isAstNode(node.parent) ? node.parent : null;

/**
 * The name `scripts/rc-bailouts.ts` gives a function: its own id, a method's
 * key, or else the nearest enclosing variable declaration's name.
 */
const functionName = (node: AstNode): string | null => {
  if (isAstNode(node.id) && node.id.type === "Identifier") {
    return typeof node.id.name === "string" ? node.id.name : null;
  }
  const parent = parentOf(node);
  if (
    (parent?.type === "MethodDefinition" ||
      (parent?.type === "Property" &&
        (parent.method === true || parent.kind !== "init"))) &&
    isAstNode(parent.key) &&
    parent.key.type === "Identifier"
  ) {
    return typeof parent.key.name === "string" ? parent.key.name : null;
  }
  for (let current = parent; current !== null; current = parentOf(current)) {
    if (
      current.type === "VariableDeclarator" &&
      isAstNode(current.id) &&
      current.id.type === "Identifier"
    ) {
      return typeof current.id.name === "string" ? current.id.name : null;
    }
  }
  return null;
};

/** The outermost function that holds `node`, or `node` when none does. */
const outermostFunction = (node: AstNode): AstNode => {
  let outermost = node;
  for (
    let current = parentOf(node);
    current !== null;
    current = parentOf(current)
  ) {
    if (FUNCTION_TYPES.has(current.type)) {
      outermost = current;
    }
  }
  return outermost;
};

/** The configured function names, or null when the whole file is covered. */
const coveredFunctions = (options: unknown): ReadonlySet<string> | null => {
  const functions: unknown =
    typeof options === "object" && options !== null
      ? Reflect.get(options, "functions")
      : undefined;
  if (!Array.isArray(functions)) {
    return null;
  }
  const names = functions.filter((name) => typeof name === "string");
  return names.includes(MODULE_TRANSFORM) ? null : new Set(names);
};

type Finding = { node: ESTree.JSXAttribute; kind: string; start: number };

export default eslintCompatPlugin({
  meta: { name: "no-constructed-context-value" },
  rules: {
    "no-constructed-context-value": {
      meta: {
        type: "problem",
        messages: { constructed: MESSAGE },
        schema: [
          {
            type: "object",
            properties: {
              functions: { type: "array", items: { type: "string" } },
            },
            additionalProperties: false,
          },
        ],
      },
      createOnce(context) {
        let covered: ReadonlySet<string> | null = null;
        let coveredRanges: (readonly [number, number])[] = [];
        let findings: Finding[] = [];
        const coverFunction = (node: unknown) => {
          if (!isAstNode(node)) {
            return;
          }
          const name = functionName(node);
          if (covered !== null && name !== null && covered.has(name)) {
            const outermost = outermostFunction(node);
            coveredRanges.push(outermost.range);
          }
        };
        return {
          before() {
            covered = coveredFunctions(context.options.at(0));
            coveredRanges = [];
            findings = [];
          },
          ArrowFunctionExpression: coverFunction,
          FunctionDeclaration: coverFunction,
          FunctionExpression: coverFunction,
          JSXOpeningElement(node) {
            if (!isProviderName(context, node.name)) {
              return;
            }
            for (const attribute of node.attributes) {
              if (
                attribute.type !== "JSXAttribute" ||
                jsxName(attribute.name) !== "value" ||
                attribute.value?.type !== "JSXExpressionContainer"
              ) {
                continue;
              }
              const kind = constructedKind(
                context,
                attribute.value.expression,
                0,
              );
              if (kind !== null) {
                findings.push({
                  node: attribute,
                  kind,
                  start: attribute.range[0],
                });
              }
            }
          },
          "Program:exit"() {
            for (const { node, kind, start } of findings) {
              if (
                covered === null ||
                coveredRanges.some(([from, to]) => start >= from && start < to)
              ) {
                context.report({
                  node,
                  messageId: "constructed",
                  data: { kind },
                });
              }
            }
          },
        };
      },
    },
  },
});
