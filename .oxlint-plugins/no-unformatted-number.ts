// Numbers rendered without the locale formatter show Latin digits even when
// the user has Eastern-Arabic (or other) numerals enabled — e.g. a matter
// overview card shows "4" instead of "٤".
//
// `String(x)`, `` `${x}` ``, and bare `{x}` call `Number.prototype.toString`,
// which is locale-independent (always Latin). The fix is to route the value
// through the central formatter: `getFormatter().number(x)` (non-React) or
// `useFormatter().number(x)` (React).
//
// This rule can't see types, so it keys off numeric-sounding names (a camelCase
// segment like `count`, `total`, `amount`, `hours`, …). It flags, inside JSX:
//   - `String(<numericName>)`
//   - a template literal containing `${<numericName>}`
//   - a bare `{<numericName>}` rendered as an element's sole child
// `getFormatter().number(x)` / `useFormatter().number(x)` are CallExpressions
// on `.number`, so formatted values are never flagged.

const NUMERIC_WORDS = new Set([
  "count",
  "total",
  "subtotal",
  "amount",
  "sum",
  "quantity",
  "qty",
  "hour",
  "hours",
  "minute",
  "minutes",
  "second",
  "seconds",
  "price",
  "balance",
  "score",
]);

// Attributes whose value is not user-visible text (so a number there is fine).
const NON_DISPLAY_ATTRS = new Set([
  "key",
  "id",
  "htmlFor",
  "className",
  "style",
  "type",
  "role",
  "name",
  "slot",
  "form",
  "dir",
]);

const segments = (name) =>
  name
    .replace(/(?<=[a-z0-9])(?=[A-Z])/g, " ")
    .replace(/_/g, " ")
    .toLowerCase()
    .split(/\s+/);

const isNumericName = (name) =>
  segments(name).some((s) => NUMERIC_WORDS.has(s));

const isNumericExpr = (node) => {
  if (!node) {
    return false;
  }
  if (node.type === "Identifier") {
    return isNumericName(node.name);
  }
  if (
    (node.type === "MemberExpression" ||
      node.type === "OptionalMemberExpression") &&
    node.property.type === "Identifier"
  ) {
    // `.length` is the most common count source (arrays/strings).
    return node.property.name === "length" || isNumericName(node.property.name);
  }
  return false;
};

const isStringCall = (node) =>
  node.type === "CallExpression" &&
  node.callee.type === "Identifier" &&
  node.callee.name === "String" &&
  isNumericExpr(node.arguments[0]);

const isNumericTemplate = (node) =>
  node.type === "TemplateLiteral" && node.expressions.some(isNumericExpr);

const inNonDisplayAttr = (node) =>
  node.parent?.type === "JSXAttribute" &&
  node.parent.name?.type === "JSXIdentifier" &&
  NON_DISPLAY_ATTRS.has(node.parent.name.name);

export default {
  meta: { name: "no-unformatted-number" },
  rules: {
    "no-unformatted-number": {
      meta: {
        type: "problem",
        messages: {
          unformatted:
            'Number rendered without the locale formatter shows Latin digits ("4" not ' +
            '"٤") under Eastern-numeral locales. Format it: getFormatter().number(x) ' +
            "(non-React) or useFormatter().number(x) (React).",
        },
      },
      create(context) {
        return {
          JSXExpressionContainer(node) {
            const expr = node.expression;
            if (
              (isStringCall(expr) || isNumericTemplate(expr)) &&
              !inNonDisplayAttr(node)
            ) {
              context.report({ node, messageId: "unformatted" });
            }
          },
          JSXElement(node) {
            const kids = node.children.filter(
              (child) =>
                !(child.type === "JSXText" && child.value.trim().length === 0),
            );
            if (kids.length !== 1) {
              return;
            }
            const child = kids[0];
            if (
              child.type === "JSXExpressionContainer" &&
              isNumericExpr(child.expression)
            ) {
              context.report({ node: child, messageId: "unformatted" });
            }
          },
        };
      },
    },
  },
};
