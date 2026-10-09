import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import * as v from "valibot";

import { assertProperty } from "@stll/property-testing";

import {
  STRUCTURED_OUTPUT_REPAIR_STEP,
  repairStructuredOutput,
} from "@/api/lib/structured-output-repair";

const jsonValueSchema = v.unknown();

const withTrailingCommas = (json: string): string =>
  json.replaceAll(/(\n\s*)([}\]])/gu, ",$1$2");

const wrapJson = (json: string, wrapper: string): string => {
  switch (wrapper) {
    case "fence":
      return `\`\`\`json\n${json}\n\`\`\``;
    case "prose":
      return `Result:\n\`\`\`json\n${json}\n\`\`\`\nEnd.`;
    case "trailing-comma":
      return `\`\`\`json\n${withTrailingCommas(json)}\n\`\`\``;
    case "encoded":
      return JSON.stringify(json);
    default:
      throw new TypeError(`Unknown test wrapper: ${wrapper}`);
  }
};

describe("structured model output repair", () => {
  test("formatting noise preserves every JSON value", () => {
    assertProperty(
      "structured-output-repair-preserves-json-values",
      fc.property(
        fc.jsonValue(),
        fc.constantFrom("fence", "prose", "trailing-comma", "encoded"),
        (value, wrapper) => {
          const json = JSON.stringify(value, null, 2);
          const raw = wrapJson(json, wrapper);

          const repaired = repairStructuredOutput(
            raw,
            v.custom(
              (candidate) =>
                JSON.stringify(candidate) === JSON.stringify(value),
            ),
          );
          expect(repaired.type).toBe("repaired");
          if (repaired.type === "repaired") {
            expect(repaired.value).toEqual(value);
          }
        },
      ),
    );
  });

  test("repaired scalar leaves occur verbatim in the noisy input", () => {
    assertProperty(
      "structured-output-repair-preserves-scalar-leaves",
      fc.property(fc.jsonValue(), (value) => {
        const json = JSON.stringify(value);
        const raw = `Before \`\`\`json\n${json}\n\`\`\` after`;
        const repaired = repairStructuredOutput(raw, jsonValueSchema);
        expect(repaired.type).toBe("repaired");
        if (repaired.type !== "repaired") {
          return;
        }

        const visit = (leaf: unknown): void => {
          if (Array.isArray(leaf)) {
            for (const child of leaf) {
              visit(child);
            }
            return;
          }
          if (leaf !== null && typeof leaf === "object") {
            for (const child of Object.values(leaf)) {
              visit(child);
            }
            return;
          }
          expect(raw).toContain(JSON.stringify(leaf));
        };
        visit(repaired.value);
      }),
    );
  });

  test("never creates a missing required field", () => {
    assertProperty(
      "structured-output-repair-never-creates-required-fields",
      fc.property(fc.dictionary(fc.string(), fc.jsonValue()), (value) => {
        delete value["required"];
        const repaired = repairStructuredOutput(
          `\`\`\`json\n${JSON.stringify(value)}\n\`\`\``,
          v.strictObject({ required: v.string() }),
        );
        expect(repaired).toEqual({ type: "unrepairable" });
      }),
    );
  });

  test("already-valid input is unchanged", () => {
    assertProperty(
      "structured-output-repair-valid-input-is-unchanged",
      fc.property(fc.jsonValue(), (value) => {
        expect(
          repairStructuredOutput(JSON.stringify(value), jsonValueSchema),
        ).toEqual({
          type: "unchanged",
        });
      }),
    );
  });

  test.each([
    [
      "extracts one fenced value",
      'prefix\n```json\n{"value":1}\n```\nsuffix',
      STRUCTURED_OUTPUT_REPAIR_STEP.EXTRACT_JSON,
    ],
    [
      "removes trailing commas",
      '```json\n{"value":1,}\n```',
      STRUCTURED_OUTPUT_REPAIR_STEP.REMOVE_TRAILING_COMMAS,
    ],
    [
      "unwraps encoded JSON",
      JSON.stringify('{"value":1}'),
      STRUCTURED_OUTPUT_REPAIR_STEP.UNWRAP_JSON_STRING,
    ],
  ])("%s", (_name, raw, step) => {
    const repaired = repairStructuredOutput(
      raw,
      v.strictObject({ value: v.number() }),
    );
    expect(repaired.type).toBe("repaired");
    if (repaired.type === "repaired") {
      expect(repaired.value).toEqual({ value: 1 });
      expect(repaired.steps).toContain(step);
    }
  });

  test("coerces a scalar only through an explicit schema transform", () => {
    const schema = v.strictObject({
      value: v.pipe(v.string(), v.transform(Number), v.number()),
    });
    const repaired = repairStructuredOutput(
      '```json\n{"value":"1"}\n```',
      schema,
    );
    expect(repaired).toEqual({
      type: "repaired",
      value: { value: 1 },
      steps: [
        STRUCTURED_OUTPUT_REPAIR_STEP.EXTRACT_JSON,
        STRUCTURED_OUTPUT_REPAIR_STEP.SCALAR_COERCION,
      ],
    });
  });

  test("fills an optional field only through its schema default", () => {
    const schema = v.strictObject({
      status: v.optional(v.literal("not stated"), "not stated"),
    });
    const repaired = repairStructuredOutput("```json\n{}\n```", schema);
    expect(repaired).toEqual({
      type: "repaired",
      value: { status: "not stated" },
      steps: [
        STRUCTURED_OUTPUT_REPAIR_STEP.EXTRACT_JSON,
        STRUCTURED_OUTPUT_REPAIR_STEP.FILL_OPTIONAL_NOT_STATED,
      ],
    });
  });

  test("refuses multiple top-level candidates", () => {
    expect(
      repairStructuredOutput('{"value":1} {"value":2}', jsonValueSchema),
    ).toEqual({
      type: "unrepairable",
    });
  });

  test("refuses a fenced value when prose contains another candidate", () => {
    expect(
      repairStructuredOutput(
        '```json\n{"value":1}\n``` then {"value":2}',
        jsonValueSchema,
      ),
    ).toEqual({ type: "unrepairable" });
  });
});
