import { expect, test } from "bun:test";
import * as v from "valibot";

import { isRecord, isUnknownArray } from "@/api/lib/type-guards";
import { deriveMcpOutputSchema } from "@/api/mcp/valibot-tool-definition";

const recordOf = (value: unknown): Record<string, unknown> => {
  if (!isRecord(value)) {
    throw new TypeError("Expected a schema record");
  }
  return value;
};

const names = ["__proto__", "constructor", "toString", "ordinary"];

for (const compaction of ["equivalent", "none"] as const) {
  test.each(names)(
    `${compaction} output projection retains the own %s field in schema examples`,
    (name) => {
      const example = { value: { [name]: "retained" } };
      const schema = deriveMcpOutputSchema(
        v.pipe(
          v.strictObject({ value: v.unknown() }),
          v.metadata({ examples: [example] }),
        ),
        { compaction },
      );
      expect(schema["examples"]).toEqual([example]);
      const examples = schema["examples"];
      if (!isUnknownArray(examples)) {
        throw new TypeError("Expected published examples");
      }
      const published = recordOf(recordOf(examples[0])["value"]);
      expect(Object.getOwnPropertyDescriptor(published, name)?.value).toBe(
        "retained",
      );
      expect(Object.getPrototypeOf(published)).toBe(Object.prototype);
      const serialized = JSON.stringify(schema);
      expect(JSON.parse(serialized)).toEqual(schema);
    },
  );
}

test.each(["constructor", "toString", "ordinary"])(
  "object union projection retains the own %s field and its requiredness",
  (name) => {
    const schema = deriveMcpOutputSchema(
      v.union([
        v.strictObject({ [name]: v.nullable(v.string()), first: v.string() }),
        v.strictObject({ [name]: v.nullable(v.string()), second: v.number() }),
      ]),
    );
    const properties = recordOf(schema["properties"]);
    expect(Object.getOwnPropertyDescriptor(properties, name)?.value).toEqual({
      type: ["string", "null"],
    });
    expect(Object.getPrototypeOf(properties)).toBe(Object.prototype);
    expect(schema["required"]).toEqual([name]);
    expect(properties["first"]).toEqual({ type: "string" });
    expect(properties["second"]).toEqual({ type: "number" });
    expect(schema["additionalProperties"]).toBe(false);
  },
);
