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
//   sql`... (${json})::jsonb ...`         // parens change nothing
//   sql`... CAST(${json} AS jsonb) ...`   // ANSI spelling of the same cast
//   sql`... ${json}::pg_catalog.jsonb ...` // qualified/quoted spellings too
//
// Property access earns no exemption of its own: `${payload.astJson}` is a
// member expression and still a bound serialized string. Casting a real column
// (`${table.column}::jsonb`) is the one legitimate use, and those few sites are
// named explicitly in `allowedColumnExpressions` rather than inferred from
// shape, which any serialized value could imitate. The config scopes each
// entry to the file that owns the schema object (via an override), so the
// same spelling elsewhere earns no exemption. Keeping the list in the config
// also avoids inline suppressions inside schema files, where an edit would
// demand a migration it does not need.
//
// Allowed:
//   sql`... ${JSON.stringify(value)}::text::jsonb ...`
//   sql`... '[]'::jsonb ...`              // SQL literal, not a bind
//
// The positional form is covered too, matched in the SQL text rather than the
// interpolations, because the value is bound by index:
//   db.unsafe(`... SET doc = $1::jsonb ...`, [JSON.stringify(value)])
//   db.unsafe(`... SET doc = ($1)::jsonb ...`, [JSON.stringify(value)])
//   db.unsafe(`... SET doc = CAST($1 AS jsonb) ...`, [JSON.stringify(value)])

type AstNode = { type: string } & Record<string, unknown>;

const isAstNode = (node: unknown): node is AstNode =>
  typeof node === "object" &&
  node !== null &&
  typeof (node as { type?: unknown }).type === "string";

// Postgres treats comments as whitespace wherever they appear, so they are
// replaced with a space before any matching; otherwise a comment could hide
// part of the cast (`${json} ::jsonb` split across lines, `::/* cast */jsonb`).
const SQL_COMMENT = /--[^\n]*|\/\*[\S\s]*?\*\//gu;

const stripSqlComments = (raw: string): string => raw.replace(SQL_COMMENT, " ");

const stripLeadingSqlNoise = (raw: string): string =>
  stripSqlComments(raw).replace(/^\s+/u, "");

// Every spelling Postgres resolves to the jsonb type: unqualified,
// schema-qualified (`pg_catalog.jsonb`), quoted (`"jsonb"`), and their
// combinations. Case-insensitivity comes from the flags on the composed
// regexes; a quoted mixed-case spelling would not resolve to the type in
// Postgres, but flagging it anyway is harmless because it fails at runtime.
const JSONB_TYPE = String.raw`(?:"?pg_catalog"?\s*\.\s*)?"?jsonb\b"?`;

// `::jsonb` with optional whitespace after the operator, case-insensitive
// because SQL type names are. `::text::jsonb` does not match, which is the
// whole point.
const BARE_JSONB_CAST = new RegExp(String.raw`^::\s*${JSONB_TYPE}`, "iu");

// `(${json})::jsonb` types the parameter exactly like the unparenthesized
// form. The closing parens are matched here; whether they wrap the bare bind
// is decided against the text before the interpolation.
const PAREN_WRAPPED_CAST = new RegExp(
  String.raw`^([\s)]*\))\s*::\s*${JSONB_TYPE}`,
  "iu",
);

// `CAST(${json} AS jsonb)` resolves the parameter to jsonb exactly like the
// `::` shorthand. Requiring the `CAST(` context on the other side of the
// interpolation keeps a column alias that happens to be named `jsonb`
// (`SELECT ${x} AS jsonb`) out.
const ANSI_CAST_SUFFIX = new RegExp(
  String.raw`^[)\s]*as\s+${JSONB_TYPE}`,
  "iu",
);
const ANSI_CAST_PREFIX = /\bcast\s*\((\s|\()*$/iu;

// The interpolation is a bare paren wrap only when the text before it closes
// with a matching run of `(` that is not a call: `= (${json})::jsonb` is the
// hazard, while in `to_jsonb(${json})::jsonb` the parameter is typed by the
// function's signature and the cast applies to its result.
const bindIsParenWrapped = (prevRaw: string, closers: number): boolean => {
  const prev = stripSqlComments(prevRaw);
  let index = prev.length - 1;
  let openers = 0;
  while (index >= 0 && openers < closers) {
    const char = prev.charAt(index);
    if (char === "(") {
      openers += 1;
    } else if (!/\s/u.test(char)) {
      return false;
    }
    index -= 1;
  }
  if (openers < closers) {
    return false;
  }
  while (index >= 0 && /\s/u.test(prev.charAt(index))) {
    index -= 1;
  }
  return index < 0 || !/[\w$]/u.test(prev.charAt(index));
};

// Whether the quasi texts around an interpolation cast the bind parameter to
// jsonb without going through text, in any of the spellings Postgres accepts.
const bareCastSurrounds = (prevRaw: string, nextRaw: string): boolean => {
  const next = stripLeadingSqlNoise(nextRaw);
  if (BARE_JSONB_CAST.test(next)) {
    return true;
  }
  const wrapped = PAREN_WRAPPED_CAST.exec(next);
  if (wrapped) {
    const closers = (wrapped[1] ?? "").split(")").length - 1;
    return bindIsParenWrapped(prevRaw, closers);
  }
  return (
    ANSI_CAST_SUFFIX.test(next) &&
    ANSI_CAST_PREFIX.test(stripSqlComments(prevRaw))
  );
};

// The positional forms: `db.unsafe("... $1::jsonb ...", [json])` and its
// parenthesized and ANSI spellings. The parameter is bound by index rather
// than interpolated, so it never appears in `TemplateLiteral.expressions` and
// has to be matched in the SQL text itself. The lookbehind on the wrapped form
// keeps call results out (`to_jsonb($1)::jsonb` types the parameter by the
// function's signature, not by the cast).
const POSITIONAL_JSONB_CAST = new RegExp(
  String.raw`\$\d+\s*::\s*${JSONB_TYPE}`,
  "iu",
);
const POSITIONAL_WRAPPED_JSONB_CAST = new RegExp(
  String.raw`(?<![\w$])\((\s*\()*\s*\$\d+\s*(\)\s*)*\)\s*::\s*${JSONB_TYPE}`,
  "iu",
);
const POSITIONAL_ANSI_JSONB_CAST = new RegExp(
  String.raw`\bcast\s*\((\s|\()*\$\d+\s*(\)\s*)*as\s+${JSONB_TYPE}`,
  "iu",
);

const carriesPositionalBareCast = (text: string): boolean => {
  const sql = stripSqlComments(text);
  return (
    POSITIONAL_JSONB_CAST.test(sql) ||
    POSITIONAL_WRAPPED_JSONB_CAST.test(sql) ||
    POSITIONAL_ANSI_JSONB_CAST.test(sql)
  );
};

// A quasi's `value` is a plain `{ raw, cooked }` record, not an AST node, so
// it carries no `type` to narrow on.
const rawTextOf = (quasi: unknown): string => {
  const value = isAstNode(quasi) ? quasi.value : undefined;
  return typeof value === "object" &&
    value !== null &&
    typeof (value as { raw?: unknown }).raw === "string"
    ? (value as { raw: string }).raw
    : "";
};

// Any string the rule can read SQL out of: a plain literal, or a template
// literal's static chunks.
const sqlTextsOf = (node: AstNode): string[] => {
  if (node.type === "Literal") {
    return typeof node.value === "string" ? [node.value] : [];
  }
  if (node.type !== "TemplateLiteral" || !Array.isArray(node.quasis)) {
    return [];
  }
  return node.quasis.map((quasi) => rawTextOf(quasi));
};

// `a.b` for a simple property access, so a configured allowlist can name the
// handful of real column casts without matching anything more elaborate.
const dottedNameOf = (node: unknown): string | undefined => {
  if (
    !isAstNode(node) ||
    node.type !== "MemberExpression" ||
    node.computed === true
  ) {
    return undefined;
  }
  const { object, property } = node;
  if (
    !isAstNode(object) ||
    object.type !== "Identifier" ||
    !isAstNode(property) ||
    property.type !== "Identifier"
  ) {
    return undefined;
  }
  const objectName = object["name"];
  const propertyName = property["name"];
  return typeof objectName === "string" && typeof propertyName === "string"
    ? `${objectName}.${propertyName}`
    : undefined;
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
        schema: [
          {
            type: "object",
            properties: {
              allowedColumnExpressions: {
                type: "array",
                items: { type: "string" },
              },
            },
            additionalProperties: false,
          },
        ],
      },
      create(context) {
        const options = context.options?.[0] ?? {};
        const allowedColumnExpressions = new Set<string>(
          Array.isArray(options.allowedColumnExpressions)
            ? options.allowedColumnExpressions
            : [],
        );

        // A positional cast is reported wherever the SQL text carrying it
        // appears, so guard against reporting the same node twice.
        const reportedPositional = new WeakSet<object>();

        const reportPositionalCasts = (node: AstNode) => {
          if (reportedPositional.has(node)) {
            return;
          }
          const carriesPositionalCast = sqlTextsOf(node).some((text) =>
            carriesPositionalBareCast(text),
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
              // A named column cast: the cast applies to the column, not to a
              // bind parameter, so nothing is double-encoded.
              const dotted = dottedNameOf(expression);
              if (
                dotted !== undefined &&
                allowedColumnExpressions.has(dotted)
              ) {
                continue;
              }

              // The text directly after this interpolation carries the cast;
              // the paren-wrapped and ANSI forms also need the text before it.
              const prevRaw = rawTextOf(quasis[index]);
              const nextRaw = rawTextOf(quasis[index + 1]);
              if (!bareCastSurrounds(prevRaw, nextRaw)) {
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
