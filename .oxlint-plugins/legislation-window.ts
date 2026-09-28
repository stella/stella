// Keep every legislation applicability decision behind one eligibility rule.
//
// A stored legislation version carries a window (`version_valid_from`,
// `version_valid_to`) and, next to it, whether that window can answer a
// point-in-time read at all (`window_disposition`, `expression_kind`). A
// never-in-force version, one whose publisher dates are inconsistent, a
// withdrawn tombstone and a promulgated text all still have dates, so any
// read that compares those dates directly answers with a version that never
// applied. `apps/api/src/lib/legal-search/legislation-validity-window.ts`
// owns the comparisons (`inForceOn`, `openedBy`, `opensAfter`, ...) and joins
// eligibility into each; readers call those instead.
//
// `legislation-window-through-helper` flags, outside the owning files the
// config exempts:
//   sql`... newer.version_valid_from <= ${asOf}`      // raw column compared
//   sql`${legislationDocuments.versionValidTo} > ${d}` // column interpolated
//                                                      // beside a comparison
//   sql`(${ref.validFrom} IS NULL OR ...)`             // a helper ref's window
//                                                      // compared by hand
//   sql.raw(`version_valid_to IS NULL`)
//   lt(legislationDocuments.versionValidFrom, date)    // Drizzle comparison
//   version.versionValidFrom <= date                   // client-side compare
//
// Allowed: selecting, ordering and paging by the columns
// (`.select({ versionValidFrom })`, `versionSortKey(...)`, keyset cursors), a
// column named as an output alias (`::text AS version_valid_from`), and null
// checks in plain code, which display the window rather than decide it.
//
// Detection boundary: syntax only. A comparison is recognised by the operator
// written directly beside the column in the same SQL text, or by the Drizzle
// comparison helper it is passed to. A column wrapped in a function before
// being compared (`coalesce(version_valid_from, ...) > x`), or reached
// through a computed key, is out of scope; the applicability matrix tests are
// the net behind this floor.
//
// `legislation-window-hint-display-only` keeps the publisher's successor-start
// hint (`window_hint_next_start` / `windowHintNextStart`) out of every file
// but its display owners. The hint is labelled non-authoritative: it may be
// shown next to an inconsistent window, and must never feed an applicability
// read, the citator, provision linking, or the search projection. Every
// spelling is flagged, so an alias (`{ windowHintNextStart: next }`), a
// computed key (`row["windowHintNextStart"]`), an import rename and raw SQL
// text all count: naming the field at all is the capability being confined.

import { eslintCompatPlugin } from "@oxlint/plugins";
import type { Node } from "@oxlint/plugins";

import {
  getCalleeName,
  getPropertyName,
  isAstNode,
  unwrapExpression,
} from "./utils.ts";

const SQL_COMMENT = /--[^\n]*|\/\*[\S\s]*?\*\//gu;

// A comparison operator or predicate keyword written directly beside a raw
// window column, on either side.
const COMPARISON_AFTER = String.raw`\s*(?:<=|>=|<>|!=|<|>|=|\bis\b|\bbetween\b|\bnot\s+between\b|\bin\b|\bnot\s+in\b|\boverlaps\b)`;
const COMPARISON_BEFORE = String.raw`(?:<=|>=|<>|!=|<|>|=|\bbetween\b)\s*`;
const RAW_WINDOW_COLUMN = String.raw`(?:"?[a-z_][a-z0-9_]*"?\s*\.\s*)?"?version_valid_(?:from|to)\b"?`;
const RAW_COLUMN_COMPARISON = new RegExp(
  `${RAW_WINDOW_COLUMN}${COMPARISON_AFTER}|${COMPARISON_BEFORE}${RAW_WINDOW_COLUMN}`,
  "iu",
);

// The same operators, read at the edge of the SQL text around an
// interpolated column.
const TRAILING_COMPARISON = /(?:<=|>=|<>|!=|<|>|=|\bbetween)\s*$/iu;
const LEADING_COMPARISON =
  /^\s*(?:<=|>=|<>|!=|<|>|=|is\b|between\b|not\s+between\b|in\b|not\s+in\b|overlaps\b)/iu;

// Property names that hold a version window: the Drizzle columns and the
// fields of the helper's own reference type.
const WINDOW_PROPERTIES = new Set([
  "versionValidFrom",
  "versionValidTo",
  "validFrom",
  "validTo",
]);
// Only the columns' own names are specific enough to flag in plain code.
const COLUMN_PROPERTIES = new Set(["versionValidFrom", "versionValidTo"]);

const DRIZZLE_COMPARISONS = new Set([
  "eq",
  "ne",
  "lt",
  "lte",
  "gt",
  "gte",
  "isNull",
  "isNotNull",
  "between",
  "notBetween",
  "inArray",
  "notInArray",
]);

const RELATIONAL_OPERATORS = new Set(["<", "<=", ">", ">="]);

const SQL_TAGS = new Set(["sql", "sql.raw"]);

const HINT_SPELLING = /window_?hint_?next_?start/iu;

const stripSqlComments = (raw: string): string => raw.replace(SQL_COMMENT, " ");

const rawTextOf = (quasi: unknown): string => {
  const value = isAstNode(quasi) ? quasi.value : undefined;
  return typeof value === "object" &&
    value !== null &&
    "raw" in value &&
    typeof value.raw === "string"
    ? value.raw
    : "";
};

const quasisOf = (template: unknown): unknown[] =>
  isAstNode(template) && Array.isArray(template.quasis) ? template.quasis : [];

const expressionsOf = (template: unknown): unknown[] =>
  isAstNode(template) && Array.isArray(template.expressions)
    ? template.expressions
    : [];

// `x.versionValidFrom`, `x?.validTo`, `(x.validFrom as SQL)`: the property a
// member access reads, when it is one of the given names.
const memberPropertyIn = (
  node: unknown,
  names: ReadonlySet<string>,
): boolean => {
  const expression = unwrapExpression(node);
  if (
    expression === null ||
    expression.type !== "MemberExpression" ||
    expression.computed === true
  ) {
    return false;
  }
  const name = getPropertyName(expression.property);
  return name !== null && names.has(name);
};

const isSqlTemplateTag = (tag: unknown): boolean => {
  const name = getCalleeName(unwrapExpression(tag));
  return name !== null && SQL_TAGS.has(name);
};

// Whether an SQL template compares a window column by hand, either in its
// own text or around one of its interpolations.
const sqlTemplateComparesWindow = (template: unknown): boolean => {
  const quasis = quasisOf(template);
  if (
    quasis.some((quasi) =>
      RAW_COLUMN_COMPARISON.test(stripSqlComments(rawTextOf(quasi))),
    )
  ) {
    return true;
  }
  return expressionsOf(template).some(
    (expression, index) =>
      memberPropertyIn(expression, WINDOW_PROPERTIES) &&
      (TRAILING_COMPARISON.test(stripSqlComments(rawTextOf(quasis[index]))) ||
        LEADING_COMPARISON.test(
          stripSqlComments(rawTextOf(quasis[index + 1])),
        )),
  );
};

const sqlTextOf = (node: unknown): string | null => {
  const expression = unwrapExpression(node);
  if (expression === null) {
    return null;
  }
  if (expression.type === "Literal") {
    return typeof expression.value === "string" ? expression.value : null;
  }
  if (expression.type === "TemplateLiteral") {
    return quasisOf(expression).map(rawTextOf).join(" ");
  }
  return null;
};

export default eslintCompatPlugin({
  meta: { name: "legislation-window" },
  rules: {
    "legislation-window-through-helper": {
      meta: {
        type: "problem",
        messages: {
          rawWindowComparison:
            "Compare a legislation version window only through the validity helper (`inForceOn`, `openedBy`, `opensAfter`, ... in `apps/api/src/lib/legal-search/legislation-validity-window.ts`), which joins window disposition and expression kind into every comparison. A raw comparison of the dates answers with versions that never applied.",
        },
        schema: [],
      },
      createOnce(context) {
        return {
          TaggedTemplateExpression(node) {
            if (!isSqlTemplateTag(node.tag)) {
              return;
            }
            if (sqlTemplateComparesWindow(node.quasi)) {
              context.report({ node, messageId: "rawWindowComparison" });
            }
          },
          CallExpression(node) {
            const callee = getCalleeName(node.callee);
            if (callee === null) {
              return;
            }
            const args = Array.isArray(node.arguments) ? node.arguments : [];
            if (callee === "sql.raw") {
              const text = sqlTextOf(args.at(0));
              if (
                text !== null &&
                RAW_COLUMN_COMPARISON.test(stripSqlComments(text))
              ) {
                context.report({ node, messageId: "rawWindowComparison" });
              }
              return;
            }
            const bareName = callee.split(".").at(-1) ?? callee;
            if (
              DRIZZLE_COMPARISONS.has(bareName) &&
              args.some((arg) => memberPropertyIn(arg, WINDOW_PROPERTIES))
            ) {
              context.report({ node, messageId: "rawWindowComparison" });
            }
          },
          BinaryExpression(node) {
            if (
              typeof node.operator !== "string" ||
              !RELATIONAL_OPERATORS.has(node.operator)
            ) {
              return;
            }
            if (
              memberPropertyIn(node.left, COLUMN_PROPERTIES) ||
              memberPropertyIn(node.right, COLUMN_PROPERTIES)
            ) {
              context.report({ node, messageId: "rawWindowComparison" });
            }
          },
        };
      },
    },
    "legislation-window-hint-display-only": {
      meta: {
        type: "problem",
        messages: {
          hintOutsideDisplay:
            "The successor-start hint of an inconsistent legislation window is display-only and non-authoritative. Read it only in its display owners (the expression label projection and the web label); applicability reads, the citator, provision linking and the search projection must never see it.",
        },
        schema: [],
      },
      createOnce(context) {
        const report = (node: Node) =>
          context.report({ node, messageId: "hintOutsideDisplay" });
        return {
          Identifier(node) {
            if (HINT_SPELLING.test(node.name)) {
              report(node);
            }
          },
          JSXIdentifier(node) {
            if (HINT_SPELLING.test(node.name)) {
              report(node);
            }
          },
          Literal(node) {
            if (
              typeof node.value === "string" &&
              HINT_SPELLING.test(node.value)
            ) {
              report(node);
            }
          },
          TemplateElement(node) {
            if (HINT_SPELLING.test(rawTextOf(node))) {
              report(node);
            }
          },
        };
      },
    },
  },
});
