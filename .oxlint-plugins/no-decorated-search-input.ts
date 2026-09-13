// The `@stll/ui` Input owns the search affordance. For `type="search"` it
// renders its own `SearchIcon` absolutely positioned at the inline start and
// reserves the matching `ps-8` on the control
// (packages/ui/src/components/input.tsx). A caller that draws a second
// `SearchIcon` beside it, or adds its own leading padding, gets a doubled
// glyph and a placeholder shifted away from the icon.
//
// Flagged:
//   <Input className="ps-9" type="search" />
//   <><SearchIcon /><Input type="search" /></>
//   <InputGroup>
//     <InputGroupAddon><SearchIcon /></InputGroupAddon>
//     <InputGroupInput type="search" />
//   </InputGroup>
// Allowed:
//   <Input type="search" />
//   an addon holding a different glyph, or an icon beside a non-search input.
//
// `Input` / `InputGroupInput` / `InputGroupAddon` resolve through their
// `@stll/ui` import, and `SearchIcon` through `lucide-react`, so a local
// component that happens to share a name is out of scope.

import { eslintCompatPlugin } from "@oxlint/plugins";

import {
  getImportLocalName,
  getImportedName,
  isAstNode,
  type AstNode,
} from "./utils.ts";

const UI_MODULE_PREFIX = "@stll/ui";
const LUCIDE_MODULE = "lucide-react";

const SEARCH_INPUT_IMPORTS = new Set(["Input", "InputGroupInput"]);
const ADDON_IMPORTS = new Set(["InputGroupAddon"]);
// lucide exports both the plain and `Icon`-suffixed alias of the glyph.
const SEARCH_ICON_IMPORTS = new Set(["Search", "SearchIcon"]);

// Leading-padding utilities, logical and physical, with any Tailwind variant
// prefix (sm:, rtl:, group-hover:) stripped.
const LEADING_PADDING = /^(?:[^:\s]+:)*p[sl]-/u;

const jsxName = (node: unknown): string | null => {
  if (!isAstNode(node)) {
    return null;
  }
  if (node.type === "JSXIdentifier" && typeof node.name === "string") {
    return node.name;
  }
  if (node.type === "JSXMemberExpression") {
    return jsxName(node.property);
  }
  if (node.type === "JSXNamespacedName") {
    return jsxName(node.name);
  }
  return null;
};

const openingElementOf = (element: unknown): AstNode | null => {
  if (!isAstNode(element) || element.type !== "JSXElement") {
    return null;
  }
  return isAstNode(element.openingElement) ? element.openingElement : null;
};

const elementName = (element: unknown): string | null =>
  jsxName(openingElementOf(element)?.name);

const attributeNamed = (element: unknown, name: string): AstNode | null => {
  const attributes = openingElementOf(element)?.attributes;
  if (!Array.isArray(attributes)) {
    return null;
  }
  return (
    attributes.find(
      (attribute): attribute is AstNode =>
        isAstNode(attribute) &&
        attribute.type === "JSXAttribute" &&
        jsxName(attribute.name) === name,
    ) ?? null
  );
};

const staticStringValue = (value: unknown): string | null => {
  if (!isAstNode(value)) {
    return null;
  }
  if (value.type === "Literal") {
    return typeof value.value === "string" ? value.value : null;
  }
  if (value.type === "JSXExpressionContainer") {
    return staticStringValue(value.expression);
  }
  return null;
};

const childElements = (node: unknown): AstNode[] => {
  if (!isAstNode(node) || !Array.isArray(node.children)) {
    return [];
  }
  return node.children.filter(
    (child): child is AstNode =>
      isAstNode(child) && child.type === "JSXElement",
  );
};

export default eslintCompatPlugin({
  meta: { name: "no-decorated-search-input" },
  rules: {
    "no-decorated-search-input": {
      meta: {
        type: "problem",
        messages: {
          decoratedPadding:
            'The @stll/ui Input already reserves the leading space for the icon it draws on type="search". Remove the ps-/pl- utility from className.',
          decoratedIcon:
            'The @stll/ui Input draws its own search icon on type="search". Remove this SearchIcon (and the addon, if it holds nothing else) so the primitive stays the only owner.',
        },
      },
      createOnce(context) {
        const searchInputLocals = new Set<string>();
        const addonLocals = new Set<string>();
        const searchIconLocals = new Set<string>();

        const collectImports = (program: unknown) => {
          searchInputLocals.clear();
          addonLocals.clear();
          searchIconLocals.clear();
          if (!isAstNode(program) || !Array.isArray(program.body)) {
            return;
          }
          for (const statement of program.body) {
            if (
              !isAstNode(statement) ||
              statement.type !== "ImportDeclaration" ||
              !isAstNode(statement.source) ||
              typeof statement.source.value !== "string" ||
              !Array.isArray(statement.specifiers)
            ) {
              continue;
            }
            const source = statement.source.value;
            const fromUi = source.startsWith(UI_MODULE_PREFIX);
            const fromLucide = source === LUCIDE_MODULE;
            if (!fromUi && !fromLucide) {
              continue;
            }
            for (const specifier of statement.specifiers) {
              const imported = getImportedName(specifier);
              const local = getImportLocalName(specifier);
              if (imported === null || local === null) {
                continue;
              }
              if (fromUi && SEARCH_INPUT_IMPORTS.has(imported)) {
                searchInputLocals.add(local);
              }
              if (fromUi && ADDON_IMPORTS.has(imported)) {
                addonLocals.add(local);
              }
              if (fromLucide && SEARCH_ICON_IMPORTS.has(imported)) {
                searchIconLocals.add(local);
              }
            }
          }
        };

        const isSearchIcon = (element: unknown): boolean => {
          const name = elementName(element);
          return name !== null && searchIconLocals.has(name);
        };

        // Search icons anywhere under an addon: the addon's own children, or a
        // wrapper the caller put inside it.
        const searchIconsWithin = (element: unknown): AstNode[] =>
          childElements(element).flatMap((child) =>
            isSearchIcon(child) ? [child] : searchIconsWithin(child),
          );

        // The icons this input duplicates. A bare icon counts only where it
        // renders ahead of the field, the position the primitive already
        // occupies; an addon counts on either side, because its `align` prop,
        // not source order, decides which edge it paints.
        const duplicatedIcons = (input: unknown): AstNode[] => {
          if (!isAstNode(input)) {
            return [];
          }
          const parent = input.parent;
          const siblings = childElements(parent);
          const index = siblings.indexOf(input);
          if (index === -1) {
            return [];
          }
          return siblings.flatMap((sibling, position) => {
            if (sibling === input) {
              return [];
            }
            const name = elementName(sibling);
            if (name !== null && addonLocals.has(name)) {
              return searchIconsWithin(sibling);
            }
            return position < index && isSearchIcon(sibling) ? [sibling] : [];
          });
        };

        return {
          Program: collectImports,
          JSXElement(node) {
            const name = elementName(node);
            if (name === null || !searchInputLocals.has(name)) {
              return;
            }
            if (
              staticStringValue(attributeNamed(node, "type")?.value) !==
              "search"
            ) {
              return;
            }

            const className = attributeNamed(node, "className");
            if (className !== null) {
              const classes = staticStringValue(className.value);
              if (
                classes !== null &&
                classes
                  .split(/\s+/u)
                  .some((token) => LEADING_PADDING.test(token))
              ) {
                context.report({
                  node: className,
                  messageId: "decoratedPadding",
                });
              }
            }

            for (const icon of duplicatedIcons(node)) {
              context.report({ node: icon, messageId: "decoratedIcon" });
            }
          },
        };
      },
    },
  },
});
