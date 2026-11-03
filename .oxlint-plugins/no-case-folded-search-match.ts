// "Does this text match what the user typed" has one client-side answer:
// createSearchQueryMatcher and filterBySearchQuery from @stll/text-normalize/search-query-matcher,
// which fold case, accents, ß/ł/ø and ligatures the same way in every UI
// locale. A hand-written `toLowerCase()` compare folds case only, so a Czech
// user typing "dvorak" misses "Dvořák" in that one list.
//
// Syntax only. Reported:
// - `.includes()`, `.startsWith()` or `.indexOf()` called on a case-folded
//   string (`x.toLowerCase()`, `x.trim().toLocaleLowerCase(locale)`, or a
//   never-reassigned binding initialized with one) with a non-constant
//   argument;
// - `containsSearchMatchKey()` or `findSearchMatchKeyRanges()` given a
//   case-folded argument, since those literal key helpers then become the
//   same hand-written compare.
// - a `<Combobox>` or `<Command>` given `items` but no `filter`, which falls
//   back to Base UI's `Intl.Collator` filter: it compares equal-length
//   windows (`strasse` never finds `Straße`) and answers per runtime locale.
//   `mode="none"` (no filtering) and a spread (props from elsewhere) pass.
// - a call to one of the fold's own building blocks (`stripDiacritics`,
//   `foldToAscii`, `applyArabicFolds`, ...): a search key assembled from them
//   is a second fold that drifts from `foldSearchMatchText` (the reader's find
//   once missed `Straße` for `strasse` that way). Marks mapped back to the
//   original text come from `foldSearchMatchTextWithOffsets`.
// Accepted: a constant argument (a string literal or a SCREAMING_CASE name),
// which compares against a fixed token such as a file extension or a URL
// prefix rather than a query; and keys built any other way.

import {
  eslintCompatPlugin,
  type ESTree,
  type Variable,
} from "@oxlint/plugins";

import {
  type AstNode,
  getPropertyName,
  isIdentifierReference,
  jsxName,
  memberPropertyName,
  resolveVariable,
  type ScopeContext,
  stableInitializer,
  staticStringValue,
  unwrapExpression,
} from "./utils.ts";

const LOWERCASE_METHODS = new Set(["toLowerCase", "toLocaleLowerCase"]);
// Methods that return a transformed copy of their receiver, so a case fold
// anywhere in the chain survives into the result.
const STRING_PRESERVING_METHODS = new Set([
  "normalize",
  "replace",
  "replaceAll",
  "slice",
  "substring",
  "toWellFormed",
  "trim",
  "trimEnd",
  "trimStart",
]);
const SUBSTRING_METHODS = new Set(["includes", "indexOf", "startsWith"]);
const LITERAL_KEY_HELPERS = new Set([
  "containsSearchMatchKey",
  "findSearchMatchKeyRanges",
]);
const CONSTANT_NAME = /^[A-Z][A-Z0-9_]*$/u;
// Partial folds @stll/text-normalize exports for its SQL-parity and slug
// contracts; a search key built from them is a second `foldSearchMatchText`.
const FOLD_PRIMITIVES = new Set([
  "applyArabicFolds",
  "applyArabicFoldsWithOffsets",
  "arabicNormalize",
  "foldToAscii",
  "stripDiacritics",
]);

const calledMethod = (call: AstNode): string | null => {
  const callee = unwrapExpression(call.callee);
  return callee?.type === "MemberExpression"
    ? memberPropertyName(callee)
    : null;
};

const calledReceiver = (call: AstNode): AstNode | null => {
  const callee = unwrapExpression(call.callee);
  return callee?.type === "MemberExpression"
    ? unwrapExpression(callee.object)
    : null;
};

type FoldCheckOptions = {
  context: ScopeContext;
  node: unknown;
  seen?: Set<Variable>;
};

const isCaseFolded = ({
  context,
  node,
  seen = new Set<Variable>(),
}: FoldCheckOptions): boolean => {
  const expression = unwrapExpression(node);
  if (expression?.type === "CallExpression") {
    const method = calledMethod(expression);
    if (method !== null && LOWERCASE_METHODS.has(method)) {
      return true;
    }
    return (
      method !== null &&
      STRING_PRESERVING_METHODS.has(method) &&
      isCaseFolded({ context, node: calledReceiver(expression), seen })
    );
  }
  if (!isIdentifierReference(expression)) {
    return false;
  }
  const variable = resolveVariable(context, expression);
  if (variable === null || seen.has(variable)) {
    return false;
  }
  seen.add(variable);
  return isCaseFolded({ context, node: stableInitializer(variable), seen });
};

const isConstantToken = (node: unknown): boolean => {
  const expression = unwrapExpression(node);
  if (expression === null || staticStringValue(expression) !== null) {
    return true;
  }
  if (expression.type === "TemplateLiteral") {
    return (
      Array.isArray(expression.expressions) &&
      expression.expressions.every(isConstantToken)
    );
  }
  if (expression.type === "Identifier") {
    return CONSTANT_NAME.test(getPropertyName(expression) ?? "");
  }
  return (
    expression.type === "MemberExpression" &&
    CONSTANT_NAME.test(memberPropertyName(expression) ?? "")
  );
};

const calleeName = (call: AstNode): string | null => {
  const callee = unwrapExpression(call.callee);
  return callee?.type === "Identifier" ? getPropertyName(callee) : null;
};

const callArguments = (call: AstNode): unknown[] =>
  Array.isArray(call.arguments) ? call.arguments : [];

const SELF_FILTERING_ELEMENTS = new Set(["Combobox", "Command"]);

const attributeValue = (attribute: AstNode): string | null =>
  staticStringValue(unwrapExpression(attribute.value));

/** Whether an opening element filters `items` with Base UI's collator. */
const usesCollatorFilter = (element: AstNode): boolean => {
  const name = unwrapExpression(element.name);
  if (
    name?.type !== "JSXIdentifier" ||
    !SELF_FILTERING_ELEMENTS.has(jsxName(name) ?? "")
  ) {
    return false;
  }
  const attributes = Array.isArray(element.attributes)
    ? element.attributes.flatMap((attribute) => {
        const node = unwrapExpression(attribute);
        return node === null ? [] : [node];
      })
    : [];
  if (attributes.some((attribute) => attribute.type === "JSXSpreadAttribute")) {
    return false;
  }
  const named = new Map(
    attributes.map((attribute) => [jsxName(attribute.name), attribute]),
  );
  const mode = named.get("mode");
  return (
    named.has("items") &&
    !named.has("filter") &&
    (mode === undefined || attributeValue(mode) !== "none")
  );
};

export default eslintCompatPlugin({
  meta: { name: "no-case-folded-search-match" },
  rules: {
    "no-case-folded-search-match": {
      meta: {
        type: "problem",
        messages: {
          fold: 'Match user-typed text with createSearchQueryMatcher or filterBySearchQuery from @stll/text-normalize/search-query-matcher. A lowercase compare folds case only, so "dvorak" misses "Dvořák" and "strasse" misses "Straße".',
          localFold:
            "Fold search text with foldSearchMatchText, or foldSearchMatchTextWithOffsets for marks mapped back to the original, from @stll/text-normalize. A fold assembled from its building blocks drifts from the key every list filter and the reader match on.",
          collator:
            'Pass filter={matchesComboboxItem} from @/components/combobox-filter.logic (or filter={null} when the caller filters). Base UI\'s default collator filter never finds "strasse" in "Straße" and depends on the runtime locale.',
        },
      },
      createOnce(context) {
        return {
          JSXOpeningElement(node: ESTree.JSXOpeningElement) {
            const element = unwrapExpression(node);
            if (element !== null && usesCollatorFilter(element)) {
              context.report({ node, messageId: "collator" });
            }
          },
          CallExpression(node: ESTree.CallExpression) {
            const call = unwrapExpression(node);
            if (call === null) {
              return;
            }
            const helper = calleeName(call);
            if (helper !== null && FOLD_PRIMITIVES.has(helper)) {
              context.report({ node, messageId: "localFold" });
              return;
            }
            if (helper !== null && LITERAL_KEY_HELPERS.has(helper)) {
              if (
                callArguments(call).some((argument) =>
                  isCaseFolded({ context, node: argument }),
                )
              ) {
                context.report({ node, messageId: "fold" });
              }
              return;
            }
            const method = calledMethod(call);
            if (method === null || !SUBSTRING_METHODS.has(method)) {
              return;
            }
            const [needle] = callArguments(call);
            if (
              !isConstantToken(needle) &&
              isCaseFolded({ context, node: calledReceiver(call) })
            ) {
              context.report({ node, messageId: "fold" });
            }
          },
        };
      },
    },
  },
});
