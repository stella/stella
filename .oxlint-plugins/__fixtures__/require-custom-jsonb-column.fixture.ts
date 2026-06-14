// Passive regression fixture for
// `require-custom-jsonb-column/require-custom-jsonb-column`.
//
// Each `oxlint-disable-next-line` below intentionally suppresses a case the
// rule MUST flag. If the rule regresses (e.g. someone drops the block-body or
// function-expression branch from the hand-rolled customType detector), the
// matching disable becomes unused and
// `--report-unused-disable-directives-severity=error` fails CI.
//
// The `arrow-body-style` disable keeps the block-bodied arrow in block form so
// the rule's BlockStatement branch is actually exercised; otherwise the
// stylistic rule would collapse it to an expression body.

import { customType, jsonb } from "drizzle-orm/pg-core";

// Stock named `jsonb()` from pg-core.
// oxlint-disable-next-line require-custom-jsonb-column/require-custom-jsonb-column
const _stock = jsonb("value");

// Hand-rolled customType, arrow-expression body: `() => "jsonb"`.
// oxlint-disable-next-line require-custom-jsonb-column/require-custom-jsonb-column
const _arrow = customType<{ data: unknown }>({ dataType: () => "jsonb" });

// Hand-rolled customType, block-bodied arrow: `() => { return "jsonb"; }`.
// oxlint-disable-next-line require-custom-jsonb-column/require-custom-jsonb-column
const _block = customType<{ data: unknown }>({
  // oxlint-disable-next-line arrow-body-style
  dataType: () => {
    return "jsonb";
  },
});

// Hand-rolled customType, object-method shorthand (a FunctionExpression value):
// `dataType() { return "jsonb"; }`.
// oxlint-disable-next-line require-custom-jsonb-column/require-custom-jsonb-column
const _method = customType<{ data: unknown }>({
  dataType() {
    return "jsonb";
  },
});

// --- Cases the rule MUST NOT flag ---

// A non-jsonb customType is unrelated to the bun-sql JSONB storage hazard.
const _text = customType<{ data: unknown }>({ dataType: () => "text" });

export const __requireCustomJsonbFixture = {
  _stock,
  _arrow,
  _block,
  _method,
  _text,
};
