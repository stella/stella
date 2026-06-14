// Passive regression fixture for
// `no-coerced-optional-union-enum/no-coerced-optional-union-enum`.
//
// Each `oxlint-disable-next-line` below intentionally suppresses a case the
// rule MUST flag. If the rule regresses (e.g. someone drops the bare-Identifier
// branch from the callee matcher and only `t.Optional(t.UnionEnum(...))` is
// caught), the matching disable becomes unused and
// `--report-unused-disable-directives-severity=error` fails CI.

import { t } from "elysia";

// Namespaced `t.Optional(t.UnionEnum(...))`.
// oxlint-disable-next-line no-coerced-optional-union-enum/no-coerced-optional-union-enum
const _namespaced = t.Optional(t.UnionEnum(["person", "organization"]));

// Destructured / bare `Optional(UnionEnum(...))` (`const { Optional } = t`).
const { Optional, UnionEnum } = t;
// oxlint-disable-next-line no-coerced-optional-union-enum/no-coerced-optional-union-enum
const _bare = Optional(UnionEnum(["person", "organization"]));

// --- Cases the rule MUST NOT flag ---

// The non-coercing replacement (absent -> `undefined`).
const _allowed = t.Optional(
  t.Union([t.Literal("person"), t.Literal("organization")]),
);

// A required (non-optional) `UnionEnum` does not coerce on absence.
const _required = t.UnionEnum(["person", "organization"]);

export const __coercedUnionEnumFixture = {
  _namespaced,
  _bare,
  _allowed,
  _required,
};
