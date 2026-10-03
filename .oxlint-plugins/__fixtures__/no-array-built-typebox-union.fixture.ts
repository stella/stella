// Passive regression fixture for
// `no-array-built-typebox-union/no-array-built-typebox-union`.
//
// Each `oxlint-disable-next-line` below intentionally suppresses a case the
// rule MUST flag. If the rule regresses, the matching disable becomes unused
// and `--report-unused-disable-directives-severity=error` fails CI.

import { Type } from "@sinclair/typebox";
import { t } from "elysia";

const DIRECTIONS = ["cited", "citing"] as const;
const STATUS = { draft: "draft", final: "final" } as const;
const table = { kind: { enumValues: ["a", "b"] as const } };

// A literal per element of a mapped array.
// oxlint-disable-next-line no-array-built-typebox-union/no-array-built-typebox-union
const _mapped = t.Union(DIRECTIONS.map((value) => t.Literal(value)));

// `Object.values` of a const object.
// oxlint-disable-next-line no-array-built-typebox-union/no-array-built-typebox-union
const _objectValues = t.UnionEnum(Object.values(STATUS));

// A filtered tuple loses its tuple type.
// oxlint-disable-next-line no-array-built-typebox-union/no-array-built-typebox-union
const _filtered = t.UnionEnum(DIRECTIONS.filter((value) => value !== "x"));

// An array literal of spreads alone is still a widened array.
// oxlint-disable-next-line no-array-built-typebox-union/no-array-built-typebox-union
const _spread = Type.Union([...DIRECTIONS.map((v) => Type.Literal(v))]);

// --- Cases the rule MUST NOT flag ---

// expect-clean: no-array-built-typebox-union/no-array-built-typebox-union
const _literal = t.Union([t.Literal("cited"), t.Literal("citing")]);

// expect-clean: no-array-built-typebox-union/no-array-built-typebox-union
const _tuple = t.UnionEnum(DIRECTIONS);

// expect-clean: no-array-built-typebox-union/no-array-built-typebox-union
const _member = t.UnionEnum(table.kind.enumValues);

// expect-clean: no-array-built-typebox-union/no-array-built-typebox-union
const _record = t.Enum(STATUS);

// A fixed first element makes the literal the tuple `[X, ...X[]]`.
// expect-clean: no-array-built-typebox-union/no-array-built-typebox-union
const _variadic = t.UnionEnum([DIRECTIONS[0], ...DIRECTIONS.slice(1)]);

export const __arrayBuiltTypeboxUnionFixture = {
  _mapped,
  _objectValues,
  _filtered,
  _spread,
  _literal,
  _tuple,
  _member,
  _record,
  _variadic,
};
