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
//   const { versionValidTo: to } = row; to > date      // destructured alias
//   const from = older.versionValidFrom; lt(from, d)   // const alias
//
// Allowed: selecting, ordering and paging by the columns
// (`.select({ versionValidFrom })`, `versionSortKey(...)`, keyset cursors), a
// column named as an output alias (`::text AS version_valid_from`), and null
// checks in plain code, which display the window rather than decide it.
//
// Detection boundary: syntax only. A comparison is recognised by the operator
// written directly beside the column in the same SQL text, or by the Drizzle
// comparison helper it is passed to, and a column is followed through a
// static computed key, a never-reassigned const and a destructured binding. A
// column wrapped in a function before being compared
// (`coalesce(version_valid_from, ...) > x`), or reached through a dynamic key,
// is out of scope; the applicability matrix tests are the net behind this
// floor.
//
// `legislation-window-hint-display-only` keeps the publisher's successor-start
// hint (`window_hint_next_start` / `windowHintNextStart`) out of every file
// but its owners the config exempts: the schema, the ingestion writer that
// persists and hashes it, and the display projections that label a version
// with it. The hint is labelled non-authoritative: it may be
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
  isIdentifier,
  isIdentifierReference,
  isSingleAssignment,
  isStringLiteral,
  memberPropertyName,
  resolveVariable,
  unwrapExpression,
} from "./utils.ts";
import type { ScopeContext } from "./utils.ts";

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

// The key a destructured binding reads: `{ versionValidFrom }`,
// `{ versionValidFrom: from }` or `{ validTo = null }`, in a declaration or a
// parameter. Null for any other binding.
const destructuredKeyOf = (binding: unknown): string | null => {
  if (!isAstNode(binding)) {
    return null;
  }
  const parent = isAstNode(binding.parent) ? binding.parent : null;
  const property =
    parent?.type === "AssignmentPattern" && isAstNode(parent.parent)
      ? parent.parent
      : parent;
  if (
    property?.type !== "Property" ||
    !isAstNode(property.parent) ||
    property.parent.type !== "ObjectPattern" ||
    (property.computed === true && !isStringLiteral(property.key))
  ) {
    return null;
  }
  return getPropertyName(property.key);
};

const isUnrelatedTableCallback = (callback: unknown): boolean => {
  if (!isAstNode(callback)) {
    return false;
  }
  const call = isAstNode(callback.parent) ? callback.parent : null;
  const name =
    call?.type === "CallExpression" ? getCalleeName(call.callee) : null;
  const args = call && Array.isArray(call.arguments) ? call.arguments : [];
  const tableName = args.at(0);
  return (
    name?.split(".").at(-1) === "pgTable" &&
    args.at(2) === callback &&
    isStringLiteral(tableName) &&
    !tableName.value.startsWith("legislation")
  );
};

// Generic validity fields also belong to unrelated schema tables. Keep
// ambiguous helper references guarded; exempt only a proven table origin.
const isUnrelatedSchemaTable = (
  context: ScopeContext,
  node: unknown,
  seen = new Set<unknown>(),
): boolean => {
  const expression = unwrapExpression(node);
  if (!isIdentifierReference(expression) || seen.has(expression)) {
    return false;
  }
  seen.add(expression);
  const variable = resolveVariable(context, expression);
  const definition = variable?.defs.at(0);
  if (
    variable === null ||
    definition === undefined ||
    variable.defs.length !== 1
  ) {
    return false;
  }
  if (
    definition.type === "ImportBinding" &&
    isAstNode(definition.node) &&
    definition.node.type === "ImportSpecifier" &&
    isAstNode(definition.parent) &&
    definition.parent.type === "ImportDeclaration" &&
    isStringLiteral(definition.parent.source)
  ) {
    const source = definition.parent.source.value;
    return (
      source === "@/api/db/schema/billing" ||
      (source === "@/api/db/schema" &&
        getPropertyName(definition.node.imported) === "vatRates")
    );
  }
  if (definition.type === "Parameter" && isAstNode(definition.node)) {
    return (
      Array.isArray(definition.node.params) &&
      definition.node.params.at(0) === definition.name &&
      isUnrelatedTableCallback(definition.node)
    );
  }
  const declarator = definition.node;
  return (
    definition.type === "Variable" &&
    isSingleAssignment(variable) &&
    isAstNode(declarator) &&
    declarator.type === "VariableDeclarator" &&
    isIdentifier(declarator.id) &&
    isUnrelatedSchemaTable(context, declarator.init, seen)
  );
};

// Whether an expression reads one of the given window properties, through
// the spellings a reader can use: `x.versionValidFrom`, `x?.validTo`,
// `x["validFrom"]`, `(x.validFrom as SQL)`, a const bound to one
// (`const from = t.versionValidFrom`), and a destructured binding
// (`const { versionValidFrom: from } = t`, `({ versionValidTo }) => ...`).
const readsWindowProperty = (
  context: ScopeContext,
  node: unknown,
  names: ReadonlySet<string>,
  seen = new Set<unknown>(),
): boolean => {
  const expression = unwrapExpression(node);
  if (expression === null || seen.has(expression)) {
    return false;
  }
  seen.add(expression);
  if (expression.type === "MemberExpression") {
    const name = memberPropertyName(expression);
    return (
      name !== null &&
      names.has(name) &&
      (COLUMN_PROPERTIES.has(name) ||
        !isUnrelatedSchemaTable(context, expression.object))
    );
  }
  if (!isIdentifierReference(expression)) {
    return false;
  }
  const variable = resolveVariable(context, expression);
  const definition = variable?.defs.at(0);
  if (
    variable === null ||
    definition === undefined ||
    variable.defs.length !== 1 ||
    !isSingleAssignment(variable)
  ) {
    return false;
  }
  const key = destructuredKeyOf(definition.name);
  if (key !== null) {
    const declaration = definition.node;
    return (
      names.has(key) &&
      (COLUMN_PROPERTIES.has(key) ||
        !isAstNode(declaration) ||
        declaration.type !== "VariableDeclarator" ||
        !isUnrelatedSchemaTable(context, declaration.init))
    );
  }
  const declarator: unknown = definition.node;
  return (
    definition.type === "Variable" &&
    isAstNode(declarator) &&
    declarator.type === "VariableDeclarator" &&
    isIdentifier(declarator.id) &&
    readsWindowProperty(context, declarator.init, names, seen)
  );
};

const isSqlTemplateTag = (tag: unknown): boolean => {
  const name = getCalleeName(unwrapExpression(tag));
  return name !== null && SQL_TAGS.has(name);
};

// Whether an SQL template compares a window column by hand, either in its
// own text or around one of its interpolations.
const sqlTemplateComparesWindow = (
  context: ScopeContext,
  template: unknown,
): boolean => {
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
      readsWindowProperty(context, expression, WINDOW_PROPERTIES) &&
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
            if (sqlTemplateComparesWindow(context, node.quasi)) {
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
              args.some((arg) =>
                readsWindowProperty(context, arg, WINDOW_PROPERTIES),
              )
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
              readsWindowProperty(context, node.left, COLUMN_PROPERTIES) ||
              readsWindowProperty(context, node.right, COLUMN_PROPERTIES)
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
            "The successor-start hint of an inconsistent legislation window is display-only and non-authoritative. Name it only in its owners (the schema, the ingestion writer that persists and hashes it, and the display projections); applicability reads, the citator, provision linking and the search projection must never see it.",
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
