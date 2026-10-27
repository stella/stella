// A lazy chunk mounts beside the content it adds to, never around it.
//
// React mounts a Suspense boundary's content in place of its fallback, and an
// element of one component type in place of an element of another: nothing
// the replaced subtree rendered survives. When the content a lazy component
// adds to (a reader, a viewer, a document) is already on screen under another
// parent, the lazy chunk's arrival replaces it, and its DOM node, scroll
// position, focus and selection go with it.
//
// Two shapes produce that, and both are reported for a component this file
// declares with `lazy()`:
//
//   - A Suspense fallback hands a component a value the lazy content is also
//     handed (an attribute value or a child expression, compared by source
//     text), so the fallback draws what the chunk then draws again:
//
//       <Suspense fallback={<Reader decision={decision} gated />}>
//         <LazyMemberReader decision={decision} />      // reported
//       </Suspense>
//
//   - The lazy component wraps content that the same component also renders
//     under another parent, in a fallback, another branch or a bare return:
//
//       if (!signedIn) return <Viewer>{children}</Viewer>;
//       return <LazyMemberChat>{children}</LazyMemberChat>; // reported
//
// Allowed: the content renders once, outside the boundary, and the lazy part
// mounts beside it and hands the content what it adds (a callback ref, a
// store), so the chunk's arrival changes the content's props rather than its
// place in the tree:
//
//   <Reader decision={decision} aiGate={gate} />
//   <Suspense fallback={null}>
//     <LazyMemberTools ref={setGate} />
//   </Suspense>
//
// A placeholder that only shares presentation with the content is not the
// content: literals, functions, calls (a translated label), `undefined` and
// spreads are not compared, so a skeleton or a disabled button standing in for
// the lazy one stays allowed. A boundary whose content suspends on data rather
// than on a lazy chunk is out of scope: its fallback is a lookalike shell, not
// the content. A boundary is checked only when it is the nearest boundary of
// a lazy element; its fallback is then compared with everything it replaces,
// synchronous siblings of the chunk included, up to any nested boundary, whose
// content swaps that boundary's fallback instead.
//
// Analysis boundary: only `lazy` and `Suspense` imported from `react` (named,
// default or namespace) count, and only a lazy component bound to a `const` in
// this file (a conditional of `lazy()` calls included). A lazy type held in
// state or imported from another module is out of scope, as is content shared
// through a value computed separately for each parent (`fallback ?? children`).

import { eslintCompatPlugin } from "@oxlint/plugins";
import type { SourceCode } from "@oxlint/plugins";

import type { AstNode } from "./utils.ts";
import {
  everyNode,
  getImportedName,
  isAstNode,
  isIdentifier,
  unwrapExpression,
} from "./utils.ts";

const REACT_MODULE = "react";

const FUNCTION_TYPES = new Set([
  "ArrowFunctionExpression",
  "FunctionDeclaration",
  "FunctionExpression",
]);

type ReactBindings = {
  lazy: Set<string>;
  namespaces: Set<string>;
  suspense: Set<string>;
};

const isLazyCall = (node: unknown, react: ReactBindings): boolean => {
  const call = unwrapExpression(node);
  if (call?.type !== "CallExpression") {
    return false;
  }
  const callee = unwrapExpression(call.callee);
  if (isIdentifier(callee)) {
    return react.lazy.has(callee.name);
  }
  return (
    callee?.type === "MemberExpression" &&
    callee.computed !== true &&
    isIdentifier(callee.object) &&
    react.namespaces.has(callee.object.name) &&
    isIdentifier(callee.property, "lazy")
  );
};

// `lazy(...)`, or a conditional that picks between such a call and anything
// else: either branch may be the type React renders.
const initializesLazy = (node: unknown, react: ReactBindings): boolean => {
  const init = unwrapExpression(node);
  if (init === null) {
    return false;
  }
  if (init.type === "ConditionalExpression") {
    return (
      initializesLazy(init.consequent, react) ||
      initializesLazy(init.alternate, react)
    );
  }
  return isLazyCall(init, react);
};

const isSuspenseName = (name: unknown, react: ReactBindings): boolean => {
  if (!isAstNode(name)) {
    return false;
  }
  if (name.type === "JSXIdentifier") {
    return typeof name.name === "string" && react.suspense.has(name.name);
  }
  return (
    name.type === "JSXMemberExpression" &&
    isAstNode(name.object) &&
    name.object.type === "JSXIdentifier" &&
    typeof name.object.name === "string" &&
    react.namespaces.has(name.object.name) &&
    isAstNode(name.property) &&
    name.property.name === "Suspense"
  );
};

const openingNameOf = (element: AstNode): string | null => {
  const opening = element.openingElement;
  if (!isAstNode(opening) || !isAstNode(opening.name)) {
    return null;
  }
  return opening.name.type === "JSXIdentifier" &&
    typeof opening.name.name === "string"
    ? opening.name.name
    : null;
};

const childrenOf = (node: AstNode): AstNode[] =>
  Array.isArray(node.children) ? node.children.filter(isAstNode) : [];

// A value that names data the content is drawn from: a binding or a member
// path, possibly optional. Literals, functions, calls and `undefined` are how
// a placeholder dresses up, not what it shows.
const isDataReference = (node: AstNode): boolean => {
  if (node.type === "Identifier") {
    return node.name !== "undefined";
  }
  if (node.type === "ChainExpression") {
    const inner = unwrapExpression(node.expression);
    return inner !== null && isDataReference(inner);
  }
  if (node.type === "MemberExpression") {
    const object = unwrapExpression(node.object);
    return object !== null && isDataReference(object);
  }
  return false;
};

type Collected = {
  /** Data handed to anything the markup renders, as attribute or child. */
  values: Set<string>;
  /** Data rendered in place, as a child or a returned value. */
  rendered: Set<string>;
  /** Markup whose content is left out, attributes and children included. */
  skip: (node: AstNode) => boolean;
};

const emptyCollected = (
  skip: (node: AstNode) => boolean = () => false,
): Collected => ({
  rendered: new Set(),
  skip,
  values: new Set(),
});

const collectValue = (
  node: unknown,
  sourceCode: SourceCode,
  out: Collected,
  asChild: boolean,
): void => {
  const expression = unwrapExpression(node);
  if (expression === null) {
    return;
  }
  if (expression.type === "JSXElement" || expression.type === "JSXFragment") {
    collectMarkup(expression, sourceCode, out);
    return;
  }
  if (expression.type === "ConditionalExpression") {
    collectValue(expression.consequent, sourceCode, out, asChild);
    collectValue(expression.alternate, sourceCode, out, asChild);
    return;
  }
  if (expression.type === "LogicalExpression" && expression.operator === "&&") {
    collectValue(expression.right, sourceCode, out, asChild);
    return;
  }
  if (isDataReference(expression)) {
    const text = sourceCode.getText(expression);
    out.values.add(text);
    if (asChild) {
      out.rendered.add(text);
    }
  }
};

const collectChildren = (
  node: AstNode,
  sourceCode: SourceCode,
  out: Collected,
): void => {
  for (const child of childrenOf(node)) {
    if (child.type === "JSXElement" || child.type === "JSXFragment") {
      collectMarkup(child, sourceCode, out);
    } else if (child.type === "JSXExpressionContainer") {
      collectValue(child.expression, sourceCode, out, true);
    }
  }
};

// The data values a stretch of markup hands to what it renders.
const collectMarkup = (
  node: AstNode,
  sourceCode: SourceCode,
  out: Collected,
): void => {
  if (out.skip(node)) {
    return;
  }
  if (node.type === "JSXElement" && isAstNode(node.openingElement)) {
    const attributes = node.openingElement.attributes;
    for (const attribute of Array.isArray(attributes) ? attributes : []) {
      if (
        isAstNode(attribute) &&
        attribute.type === "JSXAttribute" &&
        isAstNode(attribute.value) &&
        attribute.value.type === "JSXExpressionContainer"
      ) {
        collectValue(attribute.value.expression, sourceCode, out, false);
      }
    }
  }
  collectChildren(node, sourceCode, out);
};

const attributeOf = (element: AstNode, name: string): AstNode | null => {
  const opening = element.openingElement;
  if (!isAstNode(opening) || !Array.isArray(opening.attributes)) {
    return null;
  }
  return (
    opening.attributes.find(
      (attribute): attribute is AstNode =>
        isAstNode(attribute) &&
        attribute.type === "JSXAttribute" &&
        isAstNode(attribute.name) &&
        attribute.name.name === name,
    ) ?? null
  );
};

const contains = (outer: AstNode, inner: AstNode): boolean =>
  outer.range[0] <= inner.range[0] && inner.range[1] <= outer.range[1];

// The boundary that shows its fallback while `node` suspends: the nearest
// enclosing Suspense element, passing over one whose fallback holds `node`
// (a fallback suspends to the boundary above its own).
const catchingBoundary = (
  node: AstNode,
  react: ReactBindings,
): AstNode | null => {
  let current = isAstNode(node.parent) ? node.parent : null;
  while (current !== null) {
    if (
      current.type === "JSXElement" &&
      isAstNode(current.openingElement) &&
      isSuspenseName(current.openingElement.name, react) &&
      !contains(current.openingElement, node)
    ) {
      return current;
    }
    current = isAstNode(current.parent) ? current.parent : null;
  }
  return null;
};

const enclosingFunction = (node: AstNode): AstNode | null => {
  let current = isAstNode(node.parent) ? node.parent : null;
  while (current !== null && !FUNCTION_TYPES.has(current.type)) {
    current = isAstNode(current.parent) ? current.parent : null;
  }
  return current;
};

// What a component renders in place outside `excluded`: the children of its
// other markup and the values it returns.
const renderedElsewhere = (
  owner: AstNode,
  excluded: AstNode,
  sourceCode: SourceCode,
): Set<string> => {
  const out = emptyCollected();
  for (const node of everyNode(owner.body)) {
    if (contains(excluded, node) || contains(node, excluded)) {
      continue;
    }
    if (node.type === "JSXExpressionContainer" && isAstNode(node.parent)) {
      const parent = node.parent;
      if (parent.type === "JSXElement" || parent.type === "JSXFragment") {
        collectValue(node.expression, sourceCode, out, true);
      }
    } else if (node.type === "ReturnStatement") {
      collectValue(node.argument, sourceCode, out, true);
    }
  }
  // An arrow with an expression body returns it without a statement.
  if (
    owner.type === "ArrowFunctionExpression" &&
    owner.expression === true &&
    isAstNode(owner.body) &&
    !contains(owner.body, excluded)
  ) {
    collectValue(owner.body, sourceCode, out, true);
  }
  return out.rendered;
};

export default eslintCompatPlugin({
  meta: { name: "no-lazy-wrapped-content" },
  rules: {
    "no-lazy-wrapped-content": {
      meta: {
        type: "problem",
        messages: {
          fallbackRepeatsContent:
            "This Suspense fallback renders data its lazy content renders again: when the chunk arrives, React mounts the content in place of the fallback, and the fallback's DOM, scroll position and focus are lost. Render the shared part once, outside the boundary, and mount the lazy part beside it.",
          lazyWrapsContent:
            "A lazy component must not wrap content this component also renders under another parent: when the chunk arrives or the branch flips, React replaces that content, DOM, scroll position and focus included. Render the content once and mount the lazy component beside it, handing the content what it adds through a callback ref or a store.",
        },
      },
      createOnce(context) {
        const react: ReactBindings = {
          lazy: new Set(),
          namespaces: new Set(),
          suspense: new Set(),
        };
        const declarators: AstNode[] = [];
        const elements: AstNode[] = [];

        return {
          before() {
            react.lazy.clear();
            react.namespaces.clear();
            react.suspense.clear();
            declarators.length = 0;
            elements.length = 0;
          },
          ImportDeclaration(node) {
            if (node.source.value !== REACT_MODULE) {
              return;
            }
            for (const specifier of node.specifiers) {
              if (
                specifier.type === "ImportNamespaceSpecifier" ||
                specifier.type === "ImportDefaultSpecifier"
              ) {
                react.namespaces.add(specifier.local.name);
                continue;
              }
              const imported = getImportedName(specifier);
              if (imported === "lazy") {
                react.lazy.add(specifier.local.name);
              } else if (imported === "Suspense") {
                react.suspense.add(specifier.local.name);
              }
            }
          },
          // Read at `Program:exit`, once every import and declaration is known:
          // a component may render a lazy type declared below it.
          VariableDeclarator(node: unknown) {
            if (isAstNode(node)) {
              declarators.push(node);
            }
          },
          JSXElement(node: unknown) {
            if (isAstNode(node)) {
              elements.push(node);
            }
          },
          "Program:exit"() {
            const lazyComponents = new Set(
              declarators.flatMap((node) =>
                isIdentifier(node.id) && initializesLazy(node.init, react)
                  ? [node.id.name]
                  : [],
              ),
            );
            if (lazyComponents.size === 0) {
              return;
            }
            const isLazyElement = (element: AstNode) => {
              const name = openingNameOf(element);
              return name !== null && lazyComponents.has(name);
            };
            const { sourceCode } = context;

            for (const element of elements) {
              if (isLazyElement(element)) {
                const wrapped = emptyCollected();
                collectChildren(element, sourceCode, wrapped);
                const owner = enclosingFunction(element);
                if (owner !== null && wrapped.rendered.size > 0) {
                  const elsewhere = renderedElsewhere(
                    owner,
                    element,
                    sourceCode,
                  );
                  if ([...wrapped.rendered].some((v) => elsewhere.has(v))) {
                    context.report({
                      node: isAstNode(element.openingElement)
                        ? element.openingElement
                        : element,
                      messageId: "lazyWrapsContent",
                    });
                  }
                }
                continue;
              }
              const opening = element.openingElement;
              if (!isAstNode(opening) || !isSuspenseName(opening.name, react)) {
                continue;
              }
              const fallback = attributeOf(element, "fallback");
              // A boundary swaps its fallback for a chunk only when it is that
              // lazy element's nearest boundary.
              if (
                fallback === null ||
                !isAstNode(fallback.value) ||
                fallback.value.type !== "JSXExpressionContainer" ||
                !elements.some(
                  (inner) =>
                    isLazyElement(inner) &&
                    catchingBoundary(inner, react) === element,
                )
              ) {
                continue;
              }
              const shown = emptyCollected();
              collectValue(fallback.value.expression, sourceCode, shown, true);
              // Everything the boundary mounts in the fallback's place, its
              // synchronous children included; a nested boundary's content
              // replaces that boundary's own fallback, so it is left out.
              const content = emptyCollected(
                (node) =>
                  node.type === "JSXElement" &&
                  isAstNode(node.openingElement) &&
                  isSuspenseName(node.openingElement.name, react),
              );
              collectChildren(element, sourceCode, content);
              if ([...shown.values].some((v) => content.values.has(v))) {
                context.report({
                  node: fallback,
                  messageId: "fallbackRepeatsContent",
                });
              }
            }
          },
        };
      },
    },
  },
});
