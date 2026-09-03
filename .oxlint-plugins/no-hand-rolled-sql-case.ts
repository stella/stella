// Build a `CASE` over a generated branch list through `sqlCaseExpression` or
// `sqlCaseFragment`, never by interpolating the list into a template.
//
// A `CASE` needs at least one `WHEN`: `CASE ELSE 1 END` and `CASE id ELSE col
// END` are both syntax errors, so a template that splices its branches in
// renders an invalid statement the moment the list it iterates is empty. That
// list is a query result, a registry table, or a batch — all of which can be
// empty in an environment nobody tested — and the failure is a syntax error at
// execution rather than a type error at the call site. Each site that spells
// the `CASE` itself has to decide the empty case again, and the decision is
// invisible in review, which is how a seeded-registry assumption reached the
// ranking paths.
//
// `apps/api/src/lib/sql-case-expression.ts` owns both renderers and returns
// the fallback alone for an empty list, so the decision exists once.
//
// Flagged (anywhere in apps/api but the owning module):
//   sql`CASE ${branches.join(" ")} ELSE 1 END`
//   sql`CASE ${sql.join(rows.map((r) => sql`WHEN ...`), sql.raw(" "))} END`
//   sql`CASE ${table.id} ${sql.join(branches, sql.raw(" "))} ELSE ${col} END`
//   `CASE ${entries.map(toBranch).join("\n")} ELSE ${fallback} END`
//   sql.raw(`CASE ${[...branches].join(" ")} ELSE 1 END`)
//
// Allowed:
//   sql`CASE WHEN ${cond} THEN 1 ELSE 0 END`   // branches written out
//   sql`CASE ${col} WHEN 'a' THEN 1 ELSE 0 END`
//   sql`SELECT 'CASE', ${cols.join(", ")} WHERE m = 'END'`  // keywords in data
//   sqlCaseFragment({ branches: rows.map(...), fallback: sql`${col}` })
//
// Detection boundary: the branch list must be built in the interpolation
// itself (`.map(...)`, `.join(...)`, `sql.join(...)`, or an array literal
// spread). A list hoisted into a variable first is not matched — syntax
// analysis cannot tell that variable from a column reference, and the
// interpolation position alone would flag every simple `CASE ${col} WHEN`.
// The rule is a guard against the shape, not a proof that no other spelling
// exists.

import { eslintCompatPlugin } from "@oxlint/plugins";

import { filenameForContext, getPropertyName, isAstNode } from "./utils.ts";

const RULE_NAME = "no-hand-rolled-sql-case";

const OWNING_MODULE = "apps/api/src/lib/sql-case-expression.ts";
const FIXTURE = `.oxlint-plugins/__fixtures__/${RULE_NAME}.fixture.ts`;

/** A placeholder for an earlier interpolation, so keyword scanning is positional. */
const INTERPOLATION = " ? ";

/** The delimiter of a dollar-quoted string, `$$` or `$tag$`. */
const DOLLAR_QUOTE = /^\$[A-Za-z_\d]*\$/u;

/**
 * Blank everything Postgres does not read as SQL: comments, single-quoted
 * strings (`''` escapes a quote rather than ending the string), double-quoted
 * identifiers, and dollar-quoted bodies. Scanning the raw text instead would
 * read `SELECT 'CASE', ...` as an open CASE and `ELSE 'END'` as a closed one,
 * so a query that only mentions the keywords in its data would be reported.
 *
 * Blanks keep the length of what they replace, so positions stay comparable
 * with the unmasked text.
 */
const maskSqlNoise = (raw: string): string => {
  const blank = (length: number): string => " ".repeat(length);
  let masked = "";
  let index = 0;

  while (index < raw.length) {
    const rest = raw.slice(index);
    const comment = /^(?:--[^\n]*|\/\*[\S\s]*?(?:\*\/|$))/u.exec(rest);
    if (comment) {
      masked += blank(comment[0].length);
      index += comment[0].length;
      continue;
    }
    const dollarQuote = DOLLAR_QUOTE.exec(rest);
    if (dollarQuote) {
      const tag = dollarQuote[0];
      const closing = raw.indexOf(tag, index + tag.length);
      const end = closing === -1 ? raw.length : closing + tag.length;
      masked += blank(end - index);
      index = end;
      continue;
    }
    const quote = raw.charAt(index);
    if (quote !== "'" && quote !== '"') {
      masked += quote;
      index += 1;
      continue;
    }
    // A doubled quote escapes one, so the string continues past it.
    let cursor = index + 1;
    while (cursor < raw.length) {
      if (raw.charAt(cursor) !== quote) {
        cursor += 1;
        continue;
      }
      if (raw.charAt(cursor + 1) === quote) {
        cursor += 2;
        continue;
      }
      break;
    }
    const end = Math.min(cursor + 1, raw.length);
    masked += blank(end - index);
    index = end;
  }

  return masked;
};

/**
 * Whether the text before an interpolation leaves it in the position where a
 * `CASE`'s first `WHEN` branch has to appear: a `CASE` is open, and no `WHEN`
 * or `END` has closed the gap between the keyword and this interpolation.
 */
const opensCaseBranches = (prefix: string): boolean => {
  const text = maskSqlNoise(prefix);
  const lastCase = text.toUpperCase().lastIndexOf("CASE");
  if (lastCase === -1) {
    return false;
  }
  // A hyphen counts as a word character here so prose in a help string
  // ("case-law reconciliation") is not read as the SQL keyword.
  const before = text.charAt(lastCase - 1);
  const after = text.charAt(lastCase + 4);
  if (/[\w$-]/u.test(before) || /[\w$-]/u.test(after)) {
    return false;
  }
  return !/\b(?:WHEN|END)\b/iu.test(text.slice(lastCase + 4));
};

/** Whether the text after an interpolation closes the CASE it would open. */
const closesCase = (suffix: string): boolean =>
  /\bEND\b/iu.test(maskSqlNoise(suffix));

const isArraySpread = (node: unknown): boolean =>
  isAstNode(node) &&
  node.type === "ArrayExpression" &&
  Array.isArray(node.elements) &&
  node.elements.some(
    (element) => isAstNode(element) && element.type === "SpreadElement",
  );

/**
 * A branch list built in place: `xs.map(...)`, `xs.join(...)`, `sql.join(...)`,
 * or an array literal that spreads one.
 */
const isGeneratedBranchList = (node: unknown): boolean => {
  if (isArraySpread(node)) {
    return true;
  }
  if (!isAstNode(node) || node.type !== "CallExpression") {
    return false;
  }
  const { callee } = node;
  if (!isAstNode(callee) || callee.type !== "MemberExpression") {
    return false;
  }
  const method = getPropertyName(callee.property);
  return method === "map" || method === "join";
};

// A quasi's `value` is a plain `{ raw, cooked }` record rather than an AST
// node, so it carries no `type` to narrow on and needs a guard of its own.
const holdsRawText = (value: unknown): value is { raw: string } =>
  typeof value === "object" &&
  value !== null &&
  "raw" in value &&
  typeof value.raw === "string";

/** The static text of a template quasi. */
const rawTextOf = (quasi: unknown): string => {
  const value = isAstNode(quasi) ? quasi.value : undefined;
  return holdsRawText(value) ? value.raw : "";
};

export default eslintCompatPlugin({
  meta: { name: RULE_NAME },
  rules: {
    [RULE_NAME]: {
      meta: {
        type: "problem",
        messages: {
          handRolledCase:
            "Render a CASE over a generated branch list with " +
            "`sqlCaseExpression` or `sqlCaseFragment` from " +
            "`@/api/lib/sql-case-expression`. A branchless CASE is a syntax " +
            "error, so an empty list breaks the statement at runtime; the " +
            "helper returns the fallback instead.",
        },
      },
      createOnce(context) {
        return {
          before() {
            const filename = filenameForContext(context);
            return (
              (filename.includes("apps/api/src/") ||
                filename.endsWith(FIXTURE)) &&
              !filename.endsWith(OWNING_MODULE)
            );
          },
          TemplateLiteral(node) {
            const expressions = Array.isArray(node.expressions)
              ? node.expressions
              : [];
            const quasis = Array.isArray(node.quasis) ? node.quasis : [];

            const texts = quasis.map((quasi) => rawTextOf(quasi));
            let prefix = "";
            for (const [index, expression] of expressions.entries()) {
              prefix += texts[index] ?? "";
              // Both halves are required: the keyword alone appears in prose,
              // and the CASE has to be closed for the branches to be a CASE's.
              if (
                opensCaseBranches(prefix) &&
                closesCase(texts.slice(index + 1).join(INTERPOLATION)) &&
                isGeneratedBranchList(expression)
              ) {
                context.report({
                  node: expression,
                  messageId: "handRolledCase",
                });
              }
              prefix += INTERPOLATION;
            }
          },
        };
      },
    },
  },
});
