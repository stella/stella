// Require `::text::jsonb` when binding a serialized value in a SQL template.
//
// An explicit `::jsonb` cast resolves the bind parameter's type to jsonb, so
// the bun-sql driver JSON-encodes the string it is handed and Postgres stores
// (or compares against) a jsonb *string* rather than the parsed object. The
// failure is silent: `IS NOT DISTINCT FROM` never matches, `@>` misses, and
// `->>'key'` reads NULL. Casting through text keeps the parameter a text value
// that Postgres parses.
//
// This is the hand-written-SQL counterpart to require-custom-jsonb-column,
// which covers the same hazard for Drizzle schema columns.
//
// Any interpolated value is flagged, not just a recognisable
// `JSON.stringify(...)`: whether a value is already serialized cannot be known
// from one file, since it can arrive through a helper parameter, an alias, or a
// later assignment. Requiring the safe form unconditionally is what makes the
// guard sound; inferring the producer would only catch the obvious cases.
//
// Flagged:
//   sql`... ${JSON.stringify(value)}::jsonb ...`
//   sql`... ${json}::jsonb ...`           // any value, however it got here
//
// Allowed:
//   sql`... ${JSON.stringify(value)}::text::jsonb ...`
//   sql`... ${table.column}::jsonb ...`   // casting a column, not a bind
//   sql`... '[]'::jsonb ...`              // SQL literal, not a bind
//
// The positional form is covered too, matched in the SQL text rather than the
// interpolations, because the value is bound by index:
//   db.unsafe(`... SET doc = $1::jsonb ...`, [JSON.stringify(value)])

type AstNode = { type: string } & Record<string, unknown>;

const isAstNode = (node: unknown): node is AstNode =>
  typeof node === "object" &&
  node !== null &&
  typeof (node as { type?: unknown }).type === "string";

// Postgres ignores whitespace and comments between the parameter and its cast,
// so the guard has to as well; otherwise `${json} ::jsonb` or a cast on the
// next line reads as safe.
const stripLeadingSqlNoise = (raw: string): string => {
  let rest = raw;
  for (;;) {
    const next = rest
      .replace(/^\s+/u, "")
      .replace(/^--[^\n]*/u, "")
      .replace(/^\/\*[\S\s]*?\*\//u, "");
    if (next === rest) {
      return next;
    }
    rest = next;
  }
};

// `::jsonb` with optional whitespace after the operator, case-insensitive
// because SQL type names are. `::text::jsonb` does not match, which is the
// whole point.
const BARE_JSONB_CAST = /^::\s*jsonb\b/iu;

// The positional form: `db.unsafe("... $1::jsonb ...", [json])`. The parameter
// is bound by index rather than interpolated, so it never appears in
// `TemplateLiteral.expressions` and has to be matched in the SQL text itself.
const POSITIONAL_JSONB_CAST = /\$\d+\s*::\s*jsonb\b/iu;

// Any string the rule can read SQL out of: a plain literal, or a template
// literal's static chunks.
const sqlTextsOf = (node: AstNode): string[] => {
  if (node.type === "Literal") {
    return typeof node.value === "string" ? [node.value] : [];
  }
  if (node.type !== "TemplateLiteral" || !Array.isArray(node.quasis)) {
    return [];
  }
  return node.quasis.flatMap((quasi) => {
    const value = isAstNode(quasi) ? quasi.value : undefined;
    return typeof value === "object" &&
      value !== null &&
      typeof (value as { raw?: unknown }).raw === "string"
      ? [(value as { raw: string }).raw]
      : [];
  });
};

export default {
  meta: { name: "no-bare-jsonb-cast" },
  rules: {
    "no-bare-jsonb-cast": {
      meta: {
        type: "problem",
        messages: {
          bareJsonbCast:
            "Cast a serialized bind parameter with `::text::jsonb`, not a bare " +
            "`::jsonb`. The bare cast types the parameter as jsonb, so the driver " +
            "JSON-encodes the string again and Postgres sees a jsonb string " +
            "instead of the object.",
        },
      },
      create(context) {
        // A positional cast is reported wherever the SQL text carrying it
        // appears, so guard against reporting the same node twice.
        const reportedPositional = new WeakSet<object>();

        const reportPositionalCasts = (node: AstNode) => {
          if (reportedPositional.has(node)) {
            return;
          }
          const carriesPositionalCast = sqlTextsOf(node).some((text) =>
            POSITIONAL_JSONB_CAST.test(text),
          );
          if (!carriesPositionalCast) {
            return;
          }
          reportedPositional.add(node);
          context.report({ node, messageId: "bareJsonbCast" });
        };

        return {
          Literal(node: AstNode) {
            reportPositionalCasts(node);
          },

          TemplateLiteral(node: AstNode) {
            reportPositionalCasts(node);
            const expressions = Array.isArray(node.expressions)
              ? node.expressions
              : [];
            const quasis = Array.isArray(node.quasis) ? node.quasis : [];

            for (const [index, expression] of expressions.entries()) {
              // Allow only a column reference (`${table.column}::jsonb`), which
              // casts a column rather than pinning a bind parameter's type.
              // Everything else is treated as a value: whether it is serialized
              // cannot be known from this file — it may arrive through a helper
              // parameter, an alias, or a later assignment — so the safe form is
              // required unconditionally rather than inferred.
              if (
                isAstNode(expression) &&
                expression.type === "MemberExpression"
              ) {
                continue;
              }

              // The text directly after this interpolation carries the cast.
              // A quasi's `value` is a plain `{ raw, cooked }` record, not an
              // AST node, so it carries no `type` to narrow on.
              const following = quasis[index + 1];
              const value = isAstNode(following) ? following.value : undefined;
              const raw =
                typeof value === "object" &&
                value !== null &&
                typeof (value as { raw?: unknown }).raw === "string"
                  ? (value as { raw: string }).raw
                  : "";
              if (!BARE_JSONB_CAST.test(stripLeadingSqlNoise(raw))) {
                continue;
              }

              context.report({
                node: expression,
                messageId: "bareJsonbCast",
              });
            }
          },
        };
      },
    },
  },
};
