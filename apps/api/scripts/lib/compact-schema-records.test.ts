import { describe, expect, test } from "bun:test";

import { expandSchemaDefs } from "../../../../packages/cli/src/expand-schema-defs";
import { serializeCapabilityJson } from "./capability-shards";
import { compactSchemaDefs, recompactSchemaDefs } from "./compact-schema-defs";

const names = ["__proto__", "constructor", "toString", "ordinary"];
const schemaMaps = [
  "properties",
  "patternProperties",
  "definitions",
  "dependentSchemas",
];
const fragment = {
  type: "string",
  description:
    "A shared schema description with preserved field identity. ".repeat(8),
};

const sourceWithRepeatedFragment = {
  body: {
    type: "object",
    properties: { first: fragment, second: fragment, third: fragment },
  },
};

describe("schema record ownership during compaction", () => {
  test.each(
    schemaMaps.flatMap((keyword) => names.map((name) => ({ keyword, name }))),
  )(
    "$keyword retains the own $name entry through a compact/expand round trip",
    ({ keyword, name }) => {
      const source = {
        body: {
          type: "object",
          [keyword]: Object.fromEntries([
            [name, fragment],
            ["second", fragment],
            ["third", fragment],
          ]),
        },
      };
      const result = compactSchemaDefs(source);
      expect(result.status).toBe("compacted");
      if (result.status !== "compacted") {
        throw new TypeError(result.reason);
      }
      expect(Object.keys(result.inputSchema.$defs ?? {})).toHaveLength(1);
      const expanded = expandSchemaDefs(result.inputSchema);
      expect(JSON.stringify(expanded)).toBe(JSON.stringify(source));
      expect(serializeCapabilityJson(expanded)).toBe(
        serializeCapabilityJson(source),
      );
    },
  );

  test.each(names)(
    "preserves an own %s schema keyword while rewriting shared children",
    (name) => {
      const source = {
        body: {
          ...sourceWithRepeatedFragment.body,
          [name]: { marker: "retained" },
        },
      };
      const result = compactSchemaDefs(source);
      expect(result.status).toBe("compacted");
      if (result.status !== "compacted") {
        throw new TypeError(result.reason);
      }
      expect(Object.keys(result.inputSchema.$defs ?? {})).toHaveLength(1);
      const body = result.inputSchema.body;
      expect(Object.getOwnPropertyDescriptor(body, name)?.value).toEqual({
        marker: "retained",
      });
      expect(Object.getPrototypeOf(body)).toBe(Object.prototype);
      expect(JSON.stringify(expandSchemaDefs(result.inputSchema))).toBe(
        JSON.stringify(source),
      );
    },
  );

  test.each(names)(
    "retains the published own %s definition name during recompaction",
    (name) => {
      const publishedNames = new Map([
        [serializeCapabilityJson(fragment), name],
      ]);
      const result = compactSchemaDefs(
        sourceWithRepeatedFragment,
        publishedNames,
      );
      expect(result.status).toBe("compacted");
      if (result.status !== "compacted") {
        throw new TypeError(result.reason);
      }
      const defs = result.inputSchema.$defs;
      expect(Object.keys(defs ?? {})).toEqual([name]);
      expect(Object.getOwnPropertyDescriptor(defs, name)?.value).toEqual(
        fragment,
      );
      expect(Object.getPrototypeOf(defs)).toBe(Object.prototype);
      expect(JSON.stringify(expandSchemaDefs(result.inputSchema))).toBe(
        JSON.stringify(sourceWithRepeatedFragment),
      );
      const recompacted = recompactSchemaDefs(result.inputSchema);
      expect(recompacted.status).toBe("compacted");
      if (recompacted.status !== "compacted") {
        throw new TypeError(recompacted.reason);
      }
      expect(serializeCapabilityJson(recompacted.inputSchema)).toBe(
        serializeCapabilityJson(result.inputSchema),
      );
    },
  );
});
