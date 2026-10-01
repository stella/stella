// Require a case-law adapter to read the deciding court off the record.
//
// A publisher is not a court. Every decision portal this codebase reads
// carries decisions of courts other than its own, so an adapter that writes
// the publisher's name into `court` states, of every row it did not decide,
// a court that did not decide it — and the court name is what authority
// weighting is read off, so the misattribution ranks too. A constant also
// satisfies a source-field inventory by coincidence: the disposition map
// names a target, not where the value came from.
//
// The rule proves one local property, and only it: the value written at a
// `court` property is not a literal attribution. An empty value on an explicitly
// quarantined listing identity states absence. Whether the resolver was
// given the right field, and whether the record's own court field was
// preferred over the publisher's, stay review and test responsibilities.
//
// Deliberately direct-property-only: a literal bound to a name first
// (`const court = "…"`, then `{ court }`) is not reported. Reading through
// the binding is a mechanical extension, but it is not free — it flags the
// adapters that still hold a constant, and each of those needs its own
// jurisdiction's resolver and its own evidence of what the source states,
// which is a change per source rather than a change to this rule. Until then
// the rule is a floor, not a proof, and this comment is what keeps the two
// from being confused.
//
// Flags:
//   return { caseNumber, court: "Nejvyšší soud", country: "CZE" };
//   metadata: { court: `${COURT_PREFIX} soud` },
//
// Allows:
//   const court = czDecisionCourt({ adapterKey, ecli, publisherCourt, … });
//   return { caseNumber, court, country: "CZE" };
//   return { caseNumber, court: item.sud?.nazov, country: "SVK" };
//   return { court: "", isListingOnly: true, caseNumberIsPlaceholder: true };

import { eslintCompatPlugin } from "@oxlint/plugins";

import { getPropertyName, isAstNode, unwrapExpression } from "./utils.ts";

// `court` is the only court-valued key of `IngestionResult`
// (apps/api/src/lib/legal-search/ingestion-types.ts); the row's court and the
// metadata mirror of it are both written under this name.
const COURT_KEY = "court";

const isLiteralCourtValue = (value: unknown): boolean => {
  const expression = unwrapExpression(value);
  if (!isAstNode(expression)) {
    return false;
  }
  return (
    (expression.type === "Literal" && typeof expression.value === "string") ||
    expression.type === "TemplateLiteral"
  );
};

/** A quarantined identity deliberately makes no claim about its deciding court. */
const isAbsentQuarantineCourt = (node: unknown): boolean => {
  if (!isAstNode(node)) {
    return false;
  }
  const value = unwrapExpression(node.value);
  const parent = node.parent;
  if (
    !isAstNode(value) ||
    value.type !== "Literal" ||
    value.value !== "" ||
    !isAstNode(parent) ||
    parent.type !== "ObjectExpression" ||
    !Array.isArray(parent.properties)
  ) {
    return false;
  }
  const remaining = new Set(["isListingOnly", "caseNumberIsPlaceholder"]);
  for (const property of parent.properties) {
    if (
      !isAstNode(property) ||
      property.type !== "Property" ||
      property.computed === true
    ) {
      return false;
    }
    const key = getPropertyName(property.key);
    if (key !== "isListingOnly" && key !== "caseNumberIsPlaceholder") {
      continue;
    }
    const flag = unwrapExpression(property.value);
    if (
      !remaining.has(key) ||
      !isAstNode(flag) ||
      flag.type !== "Literal" ||
      flag.value !== true
    ) {
      return false;
    }
    remaining.delete(key);
  }
  return remaining.size === 0;
};

export default eslintCompatPlugin({
  meta: { name: "no-literal-decision-court" },
  rules: {
    "no-literal-decision-court": {
      meta: {
        type: "problem",
        messages: {
          literalCourt:
            "The deciding court comes from the record, not from the adapter: resolve it through the shared court resolver (apps/api/src/lib/case-law/cz-ecli-courts.ts) from the decision's ECLI and the source's own court field. A portal believed to serve one court's decisions still publishes others'.",
        },
        schema: [],
      },
      createOnce(context) {
        return {
          Property(node) {
            if (getPropertyName(node.key) !== COURT_KEY) {
              return;
            }
            if (!isLiteralCourtValue(node.value)) {
              return;
            }
            if (isAbsentQuarantineCourt(node)) {
              return;
            }
            context.report({ node, messageId: "literalCourt" });
          },
        };
      },
    },
  },
});
