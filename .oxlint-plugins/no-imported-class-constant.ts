// `shadcn/no-restyle` decides whether a `className` on a design-system
// component is placement (margin, width, position) or appearance (padding,
// colour, typography, shape), and it decides it by reading the class string.
// A string written inline, or hoisted into a constant in the same file, is
// readable. An identifier imported from another module is opaque: the rule
// sees a name, reports nothing, and the restyle it exists to catch ships.
//
// Invariant: a `@stll/ui` component's `className` is readable where it is
// written, so the design-system rule can judge it.
//
// Rejected, on a component imported from `@stll/ui/*`:
//   <Button className={CARD_SURFACE} />            (CARD_SURFACE imported)
//   <Badge className={cn("mt-2", CARD_SURFACE)} /> (also clsx)
//
// Accepted:
//   a constant declared in the same file, which the design-system rule reads;
//   a parameter or local that shadows an imported name, which resolves to its
//   own binding rather than the import;
//   `className` on `div`, `span`, and other intrinsic elements;
//   `className` on a component from anywhere but `@stll/ui` and its subpaths,
//   which a neighbouring package such as `@stll/ui-kit` is not;
//   `className={className}` forwarded from props, which is a parameter, not
//   an import;
//   `packages/ui/src/**`, where the design system composes its own constants.
//   The last one is scope, set in oxlint.config.ts.
//
// Both the component and the class value are resolved through real scope
// analysis (`sourceCode.getScope` plus the enclosing scope chain), not a
// file-wide name set, so a binding that merely reuses an imported spelling is
// never reported.
//
// Analysis boundary: resolution is single-file and syntactic beyond that
// binding lookup. Only a direct `cn(...)`/`clsx(...)` argument is inspected,
// not one nested in a further call or object; a namespace member
// (`styles.card`) carries no import binding of its own and is not reported;
// and nothing here proves the imported string actually restyles, only that no
// rule can tell.

import { eslintCompatPlugin } from "@oxlint/plugins";

import type { AstNode } from "./utils.ts";
import { isAstNode, isIdentifier, isStringLiteral, jsxName } from "./utils.ts";

const UI_MODULE = "@stll/ui";

/**
 * The design-system package itself or one of its subpaths. A bare prefix test
 * would also claim a neighbouring package whose name starts with the same
 * characters, such as `@stll/ui-kit/button`.
 */
const isUiModule = (source: string): boolean =>
  source === UI_MODULE || source.startsWith(`${UI_MODULE}/`);
const CLASS_NAME_ATTRIBUTE = "className";
const CLASS_COMPOSERS = new Set(["cn", "clsx"]);

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

/** The binding a JSX name resolves to: `Dialog.Panel` is held by `Dialog`. */
const jsxRootName = (node: unknown): string | null => {
  if (!isAstNode(node)) {
    return null;
  }
  if (node.type === "JSXMemberExpression") {
    return jsxRootName(node.object);
  }
  return jsxName(node);
};

/**
 * The module a binding is imported from, or null when it is declared locally.
 * A type-only import binds no runtime value, so it can be neither the
 * component being rendered nor the class string handed to it.
 */
const importSource = (variable: ScopeVariable | null): string | null => {
  if (variable === null) {
    return null;
  }
  for (const definition of variable.defs) {
    if (
      definition.type !== "ImportBinding" ||
      !isAstNode(definition.node) ||
      definition.node.importKind === "type" ||
      !isAstNode(definition.parent) ||
      definition.parent.type !== "ImportDeclaration" ||
      definition.parent.importKind === "type" ||
      !isStringLiteral(definition.parent.source)
    ) {
      continue;
    }
    return definition.parent.source.value;
  }
  return null;
};

/** Identifiers a `className` value contributes, directly or through `cn()`. */
const classNameIdentifiers = (value: unknown): AstNode[] => {
  if (!isAstNode(value)) {
    return [];
  }
  if (value.type === "JSXExpressionContainer") {
    return classNameIdentifiers(value.expression);
  }
  if (isIdentifier(value)) {
    return [value];
  }
  if (
    value.type === "CallExpression" &&
    isIdentifier(value.callee) &&
    CLASS_COMPOSERS.has(value.callee.name) &&
    Array.isArray(value.arguments)
  ) {
    return value.arguments.filter((argument): argument is AstNode =>
      isIdentifier(argument),
    );
  }
  return [];
};

export default eslintCompatPlugin({
  meta: { name: "no-imported-class-constant" },
  rules: {
    "no-imported-class-constant": {
      meta: {
        type: "problem",
        messages: {
          importedClassConstant:
            "This className comes from another module, so shadcn/no-restyle " +
            "cannot read the classes and cannot tell placement from a " +
            "restyle. Give the component a variant or size in packages/ui, or " +
            "inline the classes here so the design-system rule reads them.",
        },
      },
      createOnce(context) {
        // Resolve a name from the scope chain enclosing `node`. The element
        // name and the class value sit at the same position, so the value's
        // node resolves the component's binding too.
        const lookup = (node, name: string): ScopeVariable | null => {
          let scope: Scope | null = context.sourceCode.getScope(node);
          while (scope !== null) {
            const variable = scope.set.get(name);
            if (variable !== undefined) {
              return variable;
            }
            scope = scope.upper;
          }
          return null;
        };

        return {
          JSXAttribute(node) {
            if (jsxName(node.name) !== CLASS_NAME_ATTRIBUTE) {
              return;
            }
            const element = node.parent;
            if (!isAstNode(element) || element.type !== "JSXOpeningElement") {
              return;
            }
            const component = jsxRootName(element.name);
            if (component === null) {
              return;
            }
            const identifiers = classNameIdentifiers(node.value);
            const first = identifiers.at(0);
            if (first === undefined) {
              return;
            }

            const rendered = importSource(lookup(first, component));
            if (rendered === null || !isUiModule(rendered)) {
              return;
            }
            for (const identifier of identifiers) {
              if (
                isIdentifier(identifier) &&
                importSource(lookup(identifier, identifier.name)) !== null
              ) {
                context.report({
                  node: identifier,
                  messageId: "importedClassConstant",
                });
              }
            }
          },
        };
      },
    },
  },
});
