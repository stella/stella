import { expect, test } from "bun:test";
import path from "node:path";
import * as v from "valibot";

import {
  AGENT_INPUT_NORMALIZATION_KEY,
  AGENT_INPUT_NORMALIZATION_KIND,
} from "@stll/agent-input";

import { isRecord, isUnknownArray } from "@/api/lib/type-guards";
import { nullAsAbsent } from "@/api/mcp/input-schemas";
import { deriveValibotMcpInputSchema } from "@/api/mcp/valibot-tool-definition";

const recordOf = (value: unknown): Record<string, unknown> => {
  if (!isRecord(value)) {
    throw new TypeError("Expected a schema record");
  }
  return value;
};

const field = (schema: unknown, name: string) =>
  recordOf(recordOf(recordOf(schema)["properties"])[name]);

test("annotations accumulate across nullable array branches and independent paths", () => {
  const schema = deriveValibotMcpInputSchema({
    inputSchema: nullAsAbsent(
      v.strictObject({
        rows: v.nullable(
          v.array(
            v.union([
              v.strictObject({ amount: v.number(), first: v.string() }),
              v.strictObject({ amount: v.number(), second: v.string() }),
            ]),
          ),
        ),
        enabled: v.boolean(),
      }),
    ),
    inputNormalization: {
      "rows[].amount": { kind: AGENT_INPUT_NORMALIZATION_KIND.number },
      enabled: { kind: AGENT_INPUT_NORMALIZATION_KIND.boolean },
    },
  });
  const nullable = field(schema, "rows")["anyOf"];
  if (!isUnknownArray(nullable)) {
    throw new TypeError("Expected nullable branches");
  }
  const array = nullable.find(
    (branch) => isRecord(branch) && branch["type"] === "array",
  );
  const branches = recordOf(recordOf(array)["items"])["anyOf"];
  if (!isUnknownArray(branches)) {
    throw new TypeError("Expected object branches");
  }
  expect(branches).toHaveLength(2);
  for (const branch of branches) {
    expect(field(branch, "amount")[AGENT_INPUT_NORMALIZATION_KEY]).toEqual({
      kind: "number",
    });
  }
  expect(field(schema, "enabled")[AGENT_INPUT_NORMALIZATION_KEY]).toEqual({
    kind: "boolean",
  });
});

// A regression of a missing-property lookup must not modify the test worker's
// shared prototypes. The child executes the public schema factory in isolation.
test.each(["__proto__", "rows[].__proto__"])(
  "an inherited %s path is not a declared input property",
  (annotationPath) => {
    const api = path.resolve(import.meta.dir, "../..");
    const source = `
import * as v from "valibot";
import { AGENT_INPUT_NORMALIZATION_KEY } from "@stll/agent-input";
import { nullAsAbsent } from "./src/mcp/input-schemas";
import { deriveValibotMcpInputSchema } from "./src/mcp/valibot-tool-definition";
let accepted = false;
let message = "";
try {
  deriveValibotMcpInputSchema({
    inputSchema: nullAsAbsent(v.strictObject({ rows: v.array(v.strictObject({ amount: v.number() })) })),
    inputNormalization: { [${JSON.stringify(annotationPath)}]: { kind: "number" } },
  });
  accepted = true;
} catch (error) {
  message = error instanceof Error ? error.message : String(error);
}
process.stdout.write(JSON.stringify({ accepted, message, inheritedAnnotated: Object.hasOwn(Object.prototype, AGENT_INPUT_NORMALIZATION_KEY) }));
`;
    const child = Bun.spawnSync({
      cmd: [process.execPath, "--eval", source],
      cwd: api,
      timeout: 4000,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(child.exitCode, new TextDecoder().decode(child.stderr)).toBe(0);
    const result: unknown = JSON.parse(new TextDecoder().decode(child.stdout));
    expect(result).toEqual({
      accepted: false,
      message: `Agent input normalization path does not exist: ${annotationPath}`,
      inheritedAnnotated: false,
    });
  },
);
