// Passive regression fixture for `no-bare-jsonb-cast/no-bare-jsonb-cast`.
//
// Each `oxlint-disable-next-line` below intentionally suppresses a case the
// rule MUST flag. If the rule regresses (e.g. someone drops the quasi lookup
// or the JSON.stringify-binding detection), the matching disable becomes
// unused and `--report-unused-disable-directives-severity=error` fails CI.

import { sql } from "drizzle-orm";

const value = { a: 1 };
const column = sql`some_column`;

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

// --- Cases the rule MUST NOT flag ---

// The correct form: the parameter stays text and Postgres parses it.
const _throughText = sql`${JSON.stringify(value)}::text::jsonb`;
const _identifierThroughText = sql`surface_forms @> ${formJson}::text::jsonb`;

// Casting a column reference is unrelated: there is no bind parameter whose
// type the cast could pin, so nothing is double-encoded.
const _columnCast = sql`${column}::jsonb ->> 'organizationId'`;

// A SQL literal is written by Postgres, not bound by the driver.
const _sqlLiteral = sql`coalesce(${column}, '[]'::jsonb)`;

// A serialized value with no jsonb cast at all is not this rule's concern.
const _noCast = sql`${JSON.stringify(value)}`;

export const __noBareJsonbCastFixture = {
  _direct,
  _viaIdentifier,
  _trailingSql,
  _throughText,
  _identifierThroughText,
  _columnCast,
  _sqlLiteral,
  _noCast,
};
