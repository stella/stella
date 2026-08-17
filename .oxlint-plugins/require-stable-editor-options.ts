// Require identity-stable option values in `useEditor({...})` calls.
//
// `@tiptap/react`'s `useEditor` shallow-compares the options object against
// the live editor's options on every render and re-applies them
// (`editor.setOptions` -> `view.setProps` + `view.updateState`) whenever any
// compared value has a new identity. An option rebuilt inline on each render
// (an object/array literal, an inline function, a call result) therefore
// re-applies editor view props on *every* render. When the surface also
// re-renders per keystroke (a draft store, a controlled `onChange`), that
// per-render view churn interleaves with ProseMirror's DOMObserver while
// input mutations are pending: the observer flush re-parses the redrawn DOM
// as a fresh doc-changing transaction, which re-renders again — a loop that
// drops in-flight keystrokes and ends in React's "Maximum update depth
// exceeded" crash.
//
// Event-handler options (`onUpdate`, `onCreate`, ...) are exempt: the react
// binding excludes them from the comparison and always invokes the latest
// render's callback, so inline closures there are safe and idiomatic.
//
// Safe patterns (not flagged):
//   - `useEditor({ extensions, editorProps, content: initialContent })` —
//     identifiers bound to hook-captured values (`useMemo`, `useState`,
//     `useRef`, custom `useX` results) or declared outside the component
//     (module constants).
//   - `useEditor({ autofocus: false, immediatelyRender: false })` —
//     primitives compare by value.
//   - `useEditor({ onUpdate: (props) => ... })` — handlers are excluded from
//     the identity comparison.
//
// Flagged patterns:
//   - `useEditor({ extensions: [...] })` — fresh array every render.
//   - `useEditor({ editorProps: { ... } })` — fresh object every render.
//   - `useEditor({ content: toDoc(value) })` — fresh call result every
//     render; capture it once (`useState(() => toDoc(value))`) instead.
//   - `const editorProps = { ... }; useEditor({ editorProps })` — the
//     identifier resolves to a fresh literal declared in the same function
//     body (one level of local-binding resolution; aliased chains and
//     values built in nested statements stay out of scope by design).

import { eslintCompatPlugin } from "@oxlint/plugins";

import {
  getImportedName,
  isAstNode,
  isIdentifier,
  unwrapExpression,
} from "./utils.ts";

const TIPTAP_REACT_MODULE = "@tiptap/react";

// Mirrors the handler exclusions in `@tiptap/react`'s
// `EditorInstanceManager.compareOptions`.
const HANDLER_OPTION_KEYS = new Set([
  "onBeforeCreate",
  "onBlur",
  "onContentError",
  "onCreate",
  "onDestroy",
  "onDrop",
  "onFocus",
  "onPaste",
  "onSelectionUpdate",
  "onTransaction",
  "onUpdate",
]);

const isFreshIdentity = (node) => {
  const unwrapped = unwrapExpression(node);
  switch (unwrapped?.type) {
    case "ObjectExpression":
    case "ArrayExpression":
    case "ArrowFunctionExpression":
    case "FunctionExpression":
    case "CallExpression":
    case "NewExpression":
      return true;
    case "ConditionalExpression":
      return (
        isFreshIdentity(unwrapped.consequent) ||
        isFreshIdentity(unwrapped.alternate)
      );
    case "LogicalExpression":
      return (
        isFreshIdentity(unwrapped.left) || isFreshIdentity(unwrapped.right)
      );
    default:
      return false;
  }
};

const HOOK_NAME = /^use[A-Z0-9]/u;

const isHookCall = (node) => {
  if (!isAstNode(node) || node.type !== "CallExpression") {
    return false;
  }
  const callee = node["callee"];
  if (isIdentifier(callee)) {
    return HOOK_NAME.test(callee.name);
  }
  return false;
};

const findContainingFunction = (node) => {
  let current = isAstNode(node) ? node["parent"] : null;
  while (isAstNode(current)) {
    if (
      current.type === "FunctionDeclaration" ||
      current.type === "FunctionExpression" ||
      current.type === "ArrowFunctionExpression"
    ) {
      return current;
    }
    current = current["parent"];
  }
  return null;
};

// Resolve `name` against the top-level statements of the function bodies
// enclosing `fromNode` (innermost first). Returns the declarator's `init`
// for a plain `const name = ...` declaration, or null when the binding is
// not found in any enclosing function body — module-level constants and
// imports deliberately resolve to null (stable by definition here).
const resolveLocalBindingInit = (name, fromNode) => {
  let scope = findContainingFunction(fromNode);
  while (scope !== null) {
    const body = scope["body"];
    const statements =
      isAstNode(body) && body.type === "BlockStatement" ? body["body"] : null;
    if (Array.isArray(statements)) {
      for (const statement of statements) {
        if (!isAstNode(statement) || statement.type !== "VariableDeclaration") {
          continue;
        }
        const declarations = statement["declarations"];
        if (!Array.isArray(declarations)) {
          continue;
        }
        for (const declarator of declarations) {
          if (
            !isAstNode(declarator) ||
            declarator.type !== "VariableDeclarator"
          ) {
            continue;
          }
          if (isIdentifier(declarator["id"], name)) {
            return declarator["init"] ?? null;
          }
        }
      }
    }
    scope = findContainingFunction(scope);
  }
  return null;
};

// A value is unstable when it is a fresh literal/call inline, or an
// identifier whose same-function `const` binding initializes to one. A
// binding initialized from a hook call (`useMemo`, `useState`, `useRef`,
// custom `useX`) counts as captured/stable; destructured hook results
// (`const [x] = useState(...)`) never match a plain-identifier declarator
// and so resolve to null (not flagged).
const isUnstableOptionValue = (node, fromNode) => {
  if (isFreshIdentity(node)) {
    return true;
  }
  const unwrapped = unwrapExpression(node);
  if (!isIdentifier(unwrapped)) {
    return false;
  }
  const init = resolveLocalBindingInit(unwrapped.name, fromNode);
  // Unwrap before classifying so `useMemo(...) as T` / `satisfies T`
  // initializers still count as hook-captured rather than fresh calls.
  if (init === null || isHookCall(unwrapExpression(init))) {
    return false;
  }
  return isFreshIdentity(init);
};

const propertyKeyName = (property) => {
  if (property.computed) {
    return null;
  }
  if (isIdentifier(property.key)) {
    return property.key.name;
  }
  if (property.key?.type === "Literal") {
    return String(property.key.value);
  }
  return null;
};

export default eslintCompatPlugin({
  meta: { name: "require-stable-editor-options" },
  rules: {
    "require-stable-editor-options": {
      meta: {
        type: "problem",
        messages: {
          unstableOption:
            "`useEditor` option `{{name}}` is rebuilt on every render, so the react binding re-applies editor options each render (setOptions -> view.setProps/updateState). On surfaces that re-render per keystroke this view churn can interleave with ProseMirror's DOMObserver and loop until React throws 'Maximum update depth exceeded'. Hoist the value to a stable identity (useMemo, a once-captured useState initializer, or a module constant); inline event handlers (onUpdate, ...) stay allowed.",
        },
        schema: [],
      },
      createOnce(context) {
        const useEditorAliases = new Set();

        return {
          before() {
            useEditorAliases.clear();
          },
          ImportDeclaration(node) {
            if (node.source?.value !== TIPTAP_REACT_MODULE) {
              return;
            }
            for (const specifier of node.specifiers) {
              if (
                specifier.type === "ImportSpecifier" &&
                getImportedName(specifier) === "useEditor"
              ) {
                useEditorAliases.add(specifier.local.name);
              }
            }
          },

          CallExpression(node) {
            const callee = node.callee;
            if (!isIdentifier(callee) || !useEditorAliases.has(callee.name)) {
              return;
            }

            const options = unwrapExpression(node.arguments[0]);
            if (options?.type !== "ObjectExpression") {
              return;
            }

            const properties = options["properties"];
            if (!Array.isArray(properties)) {
              return;
            }
            for (const property of properties) {
              if (!isAstNode(property) || property.type !== "Property") {
                continue;
              }
              const name = propertyKeyName(property);
              if (name === null || HANDLER_OPTION_KEYS.has(name)) {
                continue;
              }
              if (isUnstableOptionValue(property["value"], node)) {
                context.report({
                  node: property,
                  messageId: "unstableOption",
                  data: { name },
                });
              }
            }
          },
        };
      },
    },
  },
});
