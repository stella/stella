// Passive regression fixture for `no-bare-jsonb-cast/no-bare-jsonb-cast`.
//
// Each `oxlint-disable-next-line` below intentionally suppresses a case the
// rule MUST flag. If the rule regresses (e.g. someone drops the quasi lookup
// or the JSON.stringify-binding detection), the matching disable becomes
// unused and `--report-unused-disable-directives-severity=error` fails CI.

import { sql } from "drizzle-orm";

const value = { a: 1 };
const formJsonSource = JSON.stringify([{ a: 1 }]);
const column = sql`some_column`;
// Columns are reached through the schema object in real code; that member form
// is what the rule treats as a column cast.
const table = { metadata: column };
const rowPayload = { astJson: formJsonSource };

// A serialized value bound directly and cast with a bare `::jsonb`.
// oxlint-disable-next-line no-bare-jsonb-cast/no-bare-jsonb-cast
const _direct = sql`${JSON.stringify(value)}::jsonb`;

// The same hazard reached through an identifier bound to JSON.stringify.
const formJson = JSON.stringify([value]);
// oxlint-disable-next-line no-bare-jsonb-cast/no-bare-jsonb-cast
const _viaIdentifier = sql`surface_forms @> ${formJson}::jsonb`;

// The cast is still bare when more SQL follows it in the same quasi.
// oxlint-disable-next-line no-bare-jsonb-cast/no-bare-jsonb-cast
const _trailingSql = sql`content || ${formJson}::jsonb, true)`;

// Postgres ignores whitespace between the parameter and its cast.
// oxlint-disable-next-line no-bare-jsonb-cast/no-bare-jsonb-cast
const _spaceBeforeCast = sql`${formJson} ::jsonb`;

// ...including a line break, which is how a formatted statement wraps. The
// interpolation stays on this statement's first line so the disable above
// covers the reported node; the cast it guards still sits on the next line.
// oxlint-disable-next-line no-bare-jsonb-cast/no-bare-jsonb-cast
const _newlineBeforeCast = sql`document_ast = ${formJson}
    ::jsonb`;

// ...and whitespace after the cast operator itself.
// oxlint-disable-next-line no-bare-jsonb-cast/no-bare-jsonb-cast
const _spaceAfterOperator = sql`${formJson}:: jsonb`;

// A SQL comment between the two is still the same cast.
// oxlint-disable-next-line no-bare-jsonb-cast/no-bare-jsonb-cast
const _commentBeforeCast = sql`${formJson} /* keep as jsonb */ ::jsonb`;

// ...and a comment between the operator and the type name.
// oxlint-disable-next-line no-bare-jsonb-cast/no-bare-jsonb-cast
const _commentAfterOperator = sql`${formJson}::/* cast */jsonb`;

// SQL type names are case-insensitive.
// oxlint-disable-next-line no-bare-jsonb-cast/no-bare-jsonb-cast
const _uppercaseCast = sql`${formJson}::JSONB`;

// Schema-qualifying the type name resolves to the same type.
// oxlint-disable-next-line no-bare-jsonb-cast/no-bare-jsonb-cast
const _qualifiedCast = sql`${formJson}::pg_catalog.jsonb`;

// ...as does quoting it.
// oxlint-disable-next-line no-bare-jsonb-cast/no-bare-jsonb-cast
const _quotedCast = sql`${formJson}::"jsonb"`;

// Parenthesizing the parameter does not change what the cast applies to.
// oxlint-disable-next-line no-bare-jsonb-cast/no-bare-jsonb-cast
const _parenWrapped = sql`doc = (${formJson})::jsonb`;

// ...nor does nesting the parens.
// oxlint-disable-next-line no-bare-jsonb-cast/no-bare-jsonb-cast
const _parenWrappedNested = sql`doc = ( ( ${formJson} ) )::jsonb`;

// The ANSI spelling resolves the parameter to jsonb exactly like `::`.
// oxlint-disable-next-line no-bare-jsonb-cast/no-bare-jsonb-cast
const _ansiCast = sql`doc = CAST(${formJson} AS jsonb)`;

// ...in any case, with parens and comments inside.
// oxlint-disable-next-line no-bare-jsonb-cast/no-bare-jsonb-cast
const _ansiCastWrapped = sql`doc = cast( ( ${formJson} ) /* ast */ as JSONB )`;

// A serialized value reaching the template through a helper parameter. Nothing
// in this file says `payload` is JSON, which is exactly why the guard cannot
// depend on recognising the producer.
// oxlint-disable-next-line no-bare-jsonb-cast/no-bare-jsonb-cast
const _viaParameter = (payload: string) => sql`doc = ${payload}::jsonb`;

// ...and through a plain alias of an alias.
const alias = formJson;
const aliasOfAlias = alias;
// oxlint-disable-next-line no-bare-jsonb-cast/no-bare-jsonb-cast
const _viaAlias = sql`doc = ${aliasOfAlias}::jsonb`;

// The positional form binds by index, so the cast lives in the SQL text and
// never appears among the template's expressions.
// oxlint-disable-next-line no-bare-jsonb-cast/no-bare-jsonb-cast
const _positionalTemplate = `UPDATE t SET doc = $1::jsonb WHERE id = $2`;

// ...and the same written as a plain string literal.
// oxlint-disable-next-line no-bare-jsonb-cast/no-bare-jsonb-cast
const _positionalLiteral = "UPDATE t SET doc = $1 :: JSONB WHERE id = $2";

// Postgres treats a comment as whitespace, so it cannot hide a positional cast.
// oxlint-disable-next-line no-bare-jsonb-cast/no-bare-jsonb-cast
const _positionalComment = "UPDATE t SET doc = $1 /* serialized */ ::jsonb";

// Parens around a positional bind leave the cast on the parameter.
// oxlint-disable-next-line no-bare-jsonb-cast/no-bare-jsonb-cast
const _positionalParenWrapped = "UPDATE t SET doc = ($1)::jsonb WHERE id = $2";

// The ANSI spelling of the positional cast.
// oxlint-disable-next-line no-bare-jsonb-cast/no-bare-jsonb-cast
const _positionalAnsiCast = "UPDATE t SET doc = CAST($1 AS jsonb)";

// ...with the type name schema-qualified.
// oxlint-disable-next-line no-bare-jsonb-cast/no-bare-jsonb-cast
const _positionalQualifiedAnsi = "SET doc = CAST($1 AS pg_catalog.jsonb)";

// Property access is not an exemption: this is still a bound serialized value.
// oxlint-disable-next-line no-bare-jsonb-cast/no-bare-jsonb-cast
const _viaPropertyAccess = sql`doc = ${rowPayload.astJson}::jsonb`;

// An allowlist spelling from another file's override earns no exemption here:
// `apikey.metadata` is only allowed in the file that owns the schema object.
const apikey = { metadata: formJsonSource };
// oxlint-disable-next-line no-bare-jsonb-cast/no-bare-jsonb-cast
const _allowlistSpellingElsewhere = sql`${apikey.metadata}::jsonb`;

// --- Cases the rule MUST NOT flag ---

// Positional casts routed through text are the correct form.
const _positionalThroughText = `UPDATE t SET doc = $1::text::jsonb WHERE id = $2`;

// The correct form: the parameter stays text and Postgres parses it.
const _throughText = sql`${JSON.stringify(value)}::text::jsonb`;
const _identifierThroughText = sql`surface_forms @> ${formJson}::text::jsonb`;

// A column cast named in `allowedColumnExpressions` (`table.metadata`): the
// cast applies to the column, not to a bind parameter. Property access alone
// is not enough — see `_viaPropertyAccess` above, which has the same shape and
// is flagged because it is not on that list.
const _columnCast = sql`${table.metadata}::jsonb ->> 'organizationId'`;

// A SQL literal is written by Postgres, not bound by the driver.
const _sqlLiteral = sql`coalesce(${column}, '[]'::jsonb)`;

// A call is not a paren wrap: the parameter is typed by the function's
// signature, and the trailing cast applies to the call's result.
const _callResultCast = sql`doc = to_jsonb(${formJson})::jsonb`;

// A column alias that happens to be named `jsonb` is not a cast.
const _aliasNamedJsonb = sql`SELECT ${formJson} AS jsonb`;

// The ANSI cast through text is the safe form, like `::text::jsonb`.
const _ansiThroughText = sql`doc = CAST(${formJson} AS text)::jsonb`;

// A serialized value with no jsonb cast at all is not this rule's concern.
const _noCast = sql`${JSON.stringify(value)}`;

// Whitespace must not turn the safe form into a false positive either.
const _throughTextSpaced = sql`${formJson} ::text::jsonb`;

// The qualified safe form stays a text parameter that Postgres parses.
const _qualifiedThroughText = sql`${formJson}::pg_catalog.text::jsonb`;

export const __noBareJsonbCastFixture = {
  _direct,
  _viaIdentifier,
  _trailingSql,
  _spaceBeforeCast,
  _newlineBeforeCast,
  _spaceAfterOperator,
  _commentBeforeCast,
  _commentAfterOperator,
  _uppercaseCast,
  _qualifiedCast,
  _quotedCast,
  _parenWrapped,
  _parenWrappedNested,
  _ansiCast,
  _ansiCastWrapped,
  _viaParameter,
  _viaAlias,
  _viaPropertyAccess,
  _allowlistSpellingElsewhere,
  _positionalTemplate,
  _positionalComment,
  _positionalLiteral,
  _positionalParenWrapped,
  _positionalAnsiCast,
  _positionalQualifiedAnsi,
  _positionalThroughText,
  _throughText,
  _identifierThroughText,
  _throughTextSpaced,
  _qualifiedThroughText,
  _columnCast,
  _sqlLiteral,
  _callResultCast,
  _aliasNamedJsonb,
  _ansiThroughText,
  _noCast,
};
