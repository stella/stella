// `Button variant="plain"` draws no box: it is a click target whose look is
// its content (a card, a thumbnail, a cell). Its `className` therefore places
// it and nothing else. A colour, background, border, ring, shadow, radius,
// padding or type size on a plain button rebuilds a variant at the call site,
// where the next screen copies it and the two drift.
//
// Flagged:
//   <Button variant="plain" className="hover:bg-muted rounded-md px-2" />
//   <Button variant="plain" className={cn("flex", active && "text-primary")} />
// Allowed:
//   <Button variant="plain" className="flex w-full min-w-0">
//     <span className="hover:bg-muted rounded-md px-2">...</span>
//   </Button>
//   <Button variant="plain" className="absolute inset-0 z-10" />
//
// The look goes on the content inside the button, or the button takes a
// variant that draws it (DESIGN.md, Button Variants). Every class string in
// the `className` expression is read: literals, `cn()` arguments, both
// branches of a ternary, object keys and template text. A class held in a
// variable is not, and `no-imported-class-constant` covers the imported ones.

import { eslintCompatPlugin } from "@oxlint/plugins";

import { classBaseName, classTokens, isAstNode, jsxName } from "./utils.ts";

const RULE_NAME = "plain-button-placement-only";

/**
 * Utilities that place or size the button, or decide whether and how it is
 * hit: position and inset, width and height, margin, how it sits in a flex or
 * grid parent and lays out its own content, display, overflow, stacking, and
 * pointer behaviour. Everything else (colour, background, border, ring,
 * shadow, radius, padding, typography, filters) is appearance.
 */
const PLACEMENT_ALTERNATIVES = [
  // position and inset
  "static|fixed|absolute|relative|sticky",
  "(?:inset|inset-x|inset-y|start|end|top|right|bottom|left)-.+",
  // size
  "(?:w|h|size|min-w|min-h|max-w|max-h|aspect)-.+",
  // margin
  "(?:m|mx|my|ms|me|mt|mr|mb|ml|space-x|space-y)-.+",
  // flex and grid placement, and the content's own layout
  "flex|inline-flex|grid|inline-grid",
  "flex-.+|grow(?:-.+)?|shrink(?:-.+)?|basis-.+|order-.+",
  "(?:col|row)-.+|grid-(?:cols|rows|flow)-.+|auto-(?:cols|rows)-.+",
  "(?:self|justify-self|place-self|items|justify|content|place)-.+",
  "(?:gap|gap-x|gap-y)-.+",
  "float-.+|clear-.+|align-.+",
  // display and visibility
  "block|inline-block|inline|contents|hidden|flow-root",
  "visible|invisible|collapse|isolate|isolation-auto|sr-only|not-sr-only",
  "box-border|box-content",
  // reveal-on-hover, as shadcn/no-restyle allows it
  "opacity-0|opacity-100|transition-opacity",
  // overflow and stacking
  "overflow-.+|overscroll-.+|z-.+",
  // movement that only offsets the box
  "translate-.+",
  // pointer and touch behaviour, scroll snapping
  "cursor-.+|pointer-events-.+|touch-.+|select-.+",
  "snap-.+|scroll-m.*",
  // group and peer markers, container queries
  "group(?:/.+)?|peer(?:/.+)?|@container(?:/.+)?",
];

const PLACEMENT_UTILITY = new RegExp(
  `^(?:${PLACEMENT_ALTERNATIVES.map((alternative) => `(?:${alternative})`).join("|")})$`,
  "u",
);

/** The utility a token applies, without variants, `!` or a negative sign. */
const utilityOf = (token: string): string =>
  classBaseName(token).replace(/^!|!$/gu, "").replace(/^-/u, "");

// The shared tokenizer splits on quotes, so `before:content-['']` arrives as
// `before:content-[` and `]`; a fragment with no letter or digit is no class.
export const appearanceTokens = (classes: string): string[] =>
  classTokens(classes).filter(
    (token) =>
      /[a-z0-9]/iu.test(token) && !PLACEMENT_UTILITY.test(utilityOf(token)),
  );

/** Every string a className expression can contribute, read statically. */
const classStrings = (node: unknown): string[] => {
  if (!isAstNode(node)) {
    return [];
  }
  switch (node.type) {
    case "Literal":
      return typeof node.value === "string" ? [node.value] : [];
    case "TemplateLiteral":
      return Array.isArray(node.quasis)
        ? node.quasis.flatMap((quasi: unknown) =>
            isAstNode(quasi) &&
            typeof quasi.value === "object" &&
            quasi.value !== null &&
            "raw" in quasi.value &&
            typeof quasi.value.raw === "string"
              ? [quasi.value.raw]
              : [],
          )
        : [];
    case "JSXExpressionContainer":
      return classStrings(node.expression);
    case "ConditionalExpression":
      return [
        ...classStrings(node.consequent),
        ...classStrings(node.alternate),
      ];
    case "LogicalExpression":
      return classStrings(node.right);
    case "CallExpression":
      return Array.isArray(node.arguments)
        ? node.arguments.flatMap(classStrings)
        : [];
    case "ArrayExpression":
      return Array.isArray(node.elements)
        ? node.elements.flatMap(classStrings)
        : [];
    case "ObjectExpression":
      return Array.isArray(node.properties)
        ? node.properties.flatMap((property: unknown) =>
            isAstNode(property) && property.type === "Property"
              ? classStrings(property.key)
              : [],
          )
        : [];
    default:
      return [];
  }
};

type Attribute = { readonly name: string; readonly node: unknown };

const attributesOf = (opening: unknown): Attribute[] =>
  isAstNode(opening) && Array.isArray(opening.attributes)
    ? opening.attributes.flatMap((attribute: unknown) => {
        if (!isAstNode(attribute) || attribute.type !== "JSXAttribute") {
          return [];
        }
        const name = jsxName(attribute.name);
        return name === null ? [] : [{ name, node: attribute }];
      })
    : [];

const attributeValue = (attribute: Attribute | undefined): unknown => {
  const node = attribute?.node;
  return isAstNode(node) ? node.value : undefined;
};

export default eslintCompatPlugin({
  meta: { name: RULE_NAME },
  rules: {
    [RULE_NAME]: {
      meta: {
        type: "problem",
        docs: {
          description:
            'Keeps `Button variant="plain"` className to placement utilities.',
        },
        messages: {
          appearance:
            '`Button variant="plain"` draws no box, so its className only ' +
            "places it (position, inset, size, margin, flex or grid " +
            "placement, display, overflow, z-index). {{tokens}} style it: " +
            "put the look on the content inside the button, or use the " +
            "variant that draws it (DESIGN.md, Button Variants).",
        },
        schema: [],
      },
      createOnce(context) {
        return {
          JSXOpeningElement(node) {
            if (jsxName(node.name) !== "Button") {
              return;
            }
            const attributes = attributesOf(node);
            const variant = attributes.find(({ name }) => name === "variant");
            if (!classStrings(attributeValue(variant)).includes("plain")) {
              return;
            }
            const className = attributes.find(
              ({ name }) => name === "className",
            );
            const tokens = [
              ...new Set(
                classStrings(attributeValue(className)).flatMap(
                  appearanceTokens,
                ),
              ),
            ];
            const target = className?.node;
            if (tokens.length > 0 && isAstNode(target)) {
              context.report({
                node: target,
                messageId: "appearance",
                data: {
                  tokens: tokens.map((token) => `\`${token}\``).join(", "),
                },
              });
            }
          },
        };
      },
    },
  },
});
