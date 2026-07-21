import { describe, expect, test } from "bun:test";

import { buildFlag } from "./build-cli-tree.js";
import type { FlagSpec } from "./route-types.js";

const flagSpec = (overrides: Partial<FlagSpec>): FlagSpec => ({
  flag: "example",
  prop: "example",
  kind: "string",
  required: false,
  repeatable: false,
  ...overrides,
});

// Every generated value flag must be optional at the stricli layer: a field can
// always be supplied via --input, and required-ness is enforced after the
// --input/flag merge against the JSON schema. A *required* stricli flag rejects
// the whole command when the field is omitted — the bug that made optional array
// flags like --assignee-ids unusable when left off. This pins the class so no
// flag kind (present or future) can regress into requiring a value.
describe("buildFlag optionality invariant", () => {
  const cases: FlagSpec[] = [
    flagSpec({ kind: "string", required: false }),
    flagSpec({ kind: "string", required: true }),
    flagSpec({ kind: "int", required: true, min: 0, max: 10 }),
    flagSpec({ kind: "enum", required: true, enum: ["a", "b"] }),
    flagSpec({ kind: "boolean", required: false }),
    // The regression case: an optional repeatable array field.
    flagSpec({ kind: "string-array", required: false, repeatable: true }),
    // Even a required array is optional at the stricli layer.
    flagSpec({ kind: "int-array", required: true, repeatable: true }),
  ];

  test("every generated value flag is optional", () => {
    for (const spec of cases) {
      expect(buildFlag(spec).optional).toBe(true);
    }
  });

  test("repeatable fields become variadic, non-repeatable do not", () => {
    const variadic = buildFlag(
      flagSpec({ kind: "string-array", repeatable: true }),
    ) as Record<string, unknown>;
    expect(variadic).toMatchObject({ kind: "parsed", variadic: true });

    const scalar = buildFlag(flagSpec({ kind: "string" })) as Record<
      string,
      unknown
    >;
    expect(scalar.variadic).toBeUndefined();
  });

  test("boolean fields build a boolean flag", () => {
    const boolean = buildFlag(flagSpec({ kind: "boolean" })) as Record<
      string,
      unknown
    >;
    expect(boolean).toMatchObject({ kind: "boolean", optional: true });
  });
});
