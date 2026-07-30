// Passive regression fixture for
// `require-timestamptz-column/require-timestamptz-column`.
//
// Each `oxlint-disable-next-line` below intentionally suppresses a case the
// rule MUST flag. If the rule regresses (e.g. someone drops the manual
// `withTimezone: true` case or the hand-rolled customType detector), the
// matching disable becomes unused and
// `--report-unused-disable-directives-severity=error` fails CI.

import * as p from "drizzle-orm/pg-core";
import { customType, timestamp } from "drizzle-orm/pg-core";

// Stock named `timestamp()` from pg-core: defaults to a naive timestamp.
// oxlint-disable-next-line require-timestamptz-column/require-timestamptz-column
const _stock = timestamp("created_at");

// Namespace member call `p.timestamp(...)`.
// oxlint-disable-next-line require-timestamptz-column/require-timestamptz-column
const _namespaced = p.timestamp("created_at");

// Computed member with a static key reaches the same export. dot-notation
// and import/namespace also reject this form repo-wide; the rule still
// detects it so its guarantee does not depend on those rules' configuration.
// oxlint-disable-next-line require-timestamptz-column/require-timestamptz-column, typescript/dot-notation, import/namespace
const _computed = p["timestamp"]("created_at");

// Even a manually correct option object must go through the helper, so there
// is exactly one way to declare a timestamp column.
// oxlint-disable-next-line require-timestamptz-column/require-timestamptz-column
const _manualTz = timestamp("created_at", { withTimezone: true });

// Hand-rolled naive timestamp customType, arrow-expression body.
// oxlint-disable-next-line require-timestamptz-column/require-timestamptz-column
const _arrow = customType<{ data: Date }>({ dataType: () => "timestamp" });

// Hand-rolled spelled-out naive type, object-method shorthand.
// oxlint-disable-next-line require-timestamptz-column/require-timestamptz-column
const _method = customType<{ data: Date }>({
  dataType() {
    return "timestamp without time zone";
  },
});

// PostgreSQL type names are case-insensitive; an uppercase variant is the
// same naive type and must not bypass the rule.
// oxlint-disable-next-line require-timestamptz-column/require-timestamptz-column
const _uppercase = customType<{ data: Date }>({ dataType: () => "TIMESTAMP" });

// Surrounding whitespace splices into valid DDL naming the same naive type.
// oxlint-disable-next-line require-timestamptz-column/require-timestamptz-column
const _padded = customType<{ data: Date }>({ dataType: () => " timestamp " });

// Whitespace around the precision modifier names the same naive type.
// oxlint-disable-next-line require-timestamptz-column/require-timestamptz-column
const _spacedPrecision = customType<{ data: Date }>({
  dataType: () => "timestamp ( 6 )",
});

// A quoted property key parses as a string literal, not an identifier, and
// must not bypass the rule. oxfmt-ignore keeps the quotes in place.
// oxfmt-ignore
// oxlint-disable-next-line require-timestamptz-column/require-timestamptz-column
const _quotedKey = customType<{ data: Date }>({
  "dataType": () => "timestamp",
});

// A zero-expression template literal names the same SQL type as a string
// literal and must not bypass the rule.
// oxlint-disable-next-line require-timestamptz-column/require-timestamptz-column
const _backtick = customType<{ data: Date }>({ dataType: () => `timestamp` });

// A statically computed key is the same `dataType` property.
// oxlint-disable-next-line require-timestamptz-column/require-timestamptz-column
const _computedKey = customType<{ data: Date }>({
  // oxlint-disable-next-line no-useless-computed-key
  ["dataType"]: () => "timestamp",
});

// --- Cases the rule MUST NOT flag ---

// A customType that yields timestamptz carries its UTC anchoring.
const _tz = customType<{ data: Date }>({ dataType: () => "timestamptz" });

export const __requireTimestamptzFixture = {
  _stock,
  _namespaced,
  _computed,
  _manualTz,
  _arrow,
  _method,
  _uppercase,
  _padded,
  _spacedPrecision,
  _quotedKey,
  _backtick,
  _computedKey,
  _tz,
};
