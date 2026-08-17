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
//     identifiers pointing at memoized/captured values.
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
              if (isFreshIdentity(property.value)) {
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
