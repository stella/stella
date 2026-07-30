// Forbid naive `::timestamp` casts in SQL text.
//
// Every timestamp column is `timestamptz` (see require-timestamptz-column), so
// a `::timestamp` cast in query text strips the UTC anchoring and silently
// reintroduces session-time-zone dependence on the comparison or assignment.
// Cast to `::timestamptz` instead.
//
// Flagged (in template literals and string literals):
//   sql`${col} > ${cursor}::timestamp`
//   sql`indexed_at = ${value}:: timestamp`
//
// Allowed:
//   sql`${cursor}::timestamptz`                       // tz-aware cast
//   sql`(d.decision_date::timestamp AT TIME ZONE 'UTC')`
//     // the explicit re-anchor idiom: converting a date/naive value to an
//     // instant with a stated zone is deliberate time-zone handling, which
//     // is exactly what this rule exists to force.

import { isStringLiteral } from "./utils.ts";

type AstNode = { type: string } & Record<string, unknown>;

type RuleContext = {
  report: (diagnostic: { node: unknown; messageId: string }) => void;
};

// A naive timestamp cast in either PostgreSQL shorthand (`::timestamp`) or
// ANSI form (`CAST(x AS timestamp)`), with optional precision and the
// spelled-out suffix. `\b` after "timestamp" keeps "timestamptz" from
// matching. The `AT TIME ZONE` exemption is checked in code on the text
// FOLLOWING the full match: a trailing negative lookahead inside the regex
// would let the optional groups backtrack (e.g. `::timestamp(6) AT TIME
// ZONE` matching with the precision group empty) and flag deliberately
// re-anchored casts. The ANSI pattern keys on `AS timestamp`, which also
// forbids aliasing a column literally as `timestamp` — rename such an alias
// rather than disabling the rule.
// The suffix group also consumes the AWARE spelling (`with time zone`) so
// the match covers the whole type name; hasNaiveCast then skips aware
// matches (`timestamp with time zone` ≡ timestamptz) instead of leaving the
// suffix to trip the anchor check.
const NAIVE_CASTS = [
  /::\s*timestamp\b(\s*\(\s*\d+\s*\))?(?<zone>\s+with(?:out)?\s+time\s+zone)?/giu,
  /\bas\s+timestamp\b(\s*\(\s*\d+\s*\))?(?<zone>\s+with(?:out)?\s+time\s+zone)?/giu,
];
const AWARE_ZONE_SUFFIX = /^\s+with\s+time\s+zone$/iu;
// For the ANSI form the anchor follows CAST's closing parenthesis, and
// composed fragments may add further grouping (`((x::timestamp)) AT TIME
// ZONE '...'`), so allow any run of closing parentheses before the anchor;
// a parenthesized shorthand cast is equally deliberate.
const RE_ANCHOR = /^(?:\s*\))*\s*at\s+time\s+zone\b/iu;

const isAstNode = (node: unknown): node is AstNode =>
  typeof node === "object" &&
  node !== null &&
  "type" in node &&
  typeof node.type === "string";

const hasNaiveCast = (text: string): boolean => {
  for (const pattern of NAIVE_CASTS) {
    pattern.lastIndex = 0;
    for (
      let match = pattern.exec(text);
      match !== null;
      match = pattern.exec(text)
    ) {
      const zone = match.groups?.["zone"];
      if (zone !== undefined && AWARE_ZONE_SUFFIX.test(zone)) {
        continue;
      }
      if (!RE_ANCHOR.test(text.slice(match.index + match[0].length))) {
        return true;
      }
    }
  }
  return false;
};

export default {
  meta: { name: "no-naive-timestamp-cast" },
  rules: {
    "no-naive-timestamp-cast": {
      meta: {
        type: "problem",
        messages: {
          naiveCast:
            "Do not cast to a naive `timestamp` type in SQL; every timestamp " +
            "column is timestamptz. Cast to `::timestamptz`, or re-anchor " +
            "explicitly with `::timestamp AT TIME ZONE '...'` when " +
            "converting a zoneless value to an instant.",
        },
      },
      create(context: RuleContext) {
        return {
          TemplateLiteral(node: AstNode) {
            const quasis = node.quasis;
            if (!Array.isArray(quasis)) {
              return;
            }
            for (const quasi of quasis) {
              if (!isAstNode(quasi)) {
                continue;
              }
              const value = quasi.value;
              if (typeof value !== "object" || value === null) {
                continue;
              }
              // Prefer the cooked text: an escape like `\n` reaches the SQL
              // tag as a real newline, which `\s` matches, while the raw
              // segment still holds the two-character escape sequence.
              // cooked is null for invalid escapes; fall back to raw there.
              const { cooked, raw } = value as {
                cooked?: unknown;
                raw?: unknown;
              };
              const segment = typeof cooked === "string" ? cooked : raw;
              if (typeof segment === "string" && hasNaiveCast(segment)) {
                context.report({ node, messageId: "naiveCast" });
                return;
              }
            }
          },
          Literal(node: AstNode) {
            if (isStringLiteral(node) && hasNaiveCast(node.value)) {
              context.report({ node, messageId: "naiveCast" });
            }
          },
        };
      },
    },
  },
};
