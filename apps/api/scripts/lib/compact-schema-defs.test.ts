import { describe, expect, test } from "bun:test";

import { expandSchemaDefs } from "../../../../packages/cli/src/expand-schema-defs";
import {
  inputSchemaByteSize,
  MAX_CAPABILITY_SCHEMA_BYTES,
} from "./capability-catalog";
import { compactSchemaDefs } from "./compact-schema-defs";

// THE correctness gate for `$defs` compaction. A compacted schema that admits
// even slightly more than its source is a schema the CLI accepts and the
// handler then rejects; one that admits less is a command the CLI refuses to
// send at all. Either way the failure is silent, so the property is asserted
// over every capability in the committed catalog rather than spot-checked on
// the recursive view schemas that motivated the pass.
//
// The exporter runs the same check against the LIVE handler schemas before it
// writes anything (`compactInputSchemaGuarded`), which is what establishes
// `expand(compact(source)) === source`. This file pins the property on the
// committed artifact, where it holds with no handler graph, no env, and no
// database, and where it also catches a hand-edit of the generated JSON.

// Read rather than `import`: a 300KB JSON literal in a module graph is a large
// bill for the type checker to pay on every build, for a value only this file
// reads once.
const catalogEntries: readonly Record<string, unknown>[] = JSON.parse(
  await Bun.file(
    new URL(
      "../../../../packages/cli/capability-catalog.json",
      import.meta.url,
    ),
  ).text(),
);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Narrow a schema node for assertions; anything else is a test failure. */
const recordOf = (value: unknown): Record<string, unknown> => {
  if (!isRecord(value)) {
    throw new TypeError(`expected a schema object, got ${typeof value}`);
  }
  return value;
};

/** Every entry's compacted `inputSchema`, keyed by capability id. */
const compactedById = new Map(
  catalogEntries.map(
    (entry) =>
      [
        String(entry["id"]),
        isRecord(entry["inputSchema"]) ? entry["inputSchema"] : undefined,
      ] as const,
  ),
);

describe("committed capability catalog", () => {
  test("holds every capability, so the properties below are not vacuous", () => {
    expect(compactedById.size).toBeGreaterThan(300);
  });

  test("gives every entry an input schema and no truncation flag", () => {
    const withoutSchema = [...compactedById]
      .filter(([, schema]) => schema === undefined)
      .map(([id]) => id);
    expect(withoutSchema).toEqual([]);
    const flagged = catalogEntries
      .filter((entry) => entry["inputSchemaTruncated"] !== undefined)
      .map((entry) => String(entry["id"]));
    expect(flagged).toEqual([]);
  });

  test("keeps every input schema inside the byte cap", () => {
    const over = [...compactedById]
      .filter(
        ([, schema]) =>
          inputSchemaByteSize(schema) > MAX_CAPABILITY_SCHEMA_BYTES,
      )
      .map(([id]) => id);
    expect(over).toEqual([]);
  });

  test("compaction actually happened, so the round trip below has refs to resolve", () => {
    const withDefs = [...compactedById].filter(
      ([, schema]) => schema?.["$defs"] !== undefined,
    );
    expect(withDefs.length).toBeGreaterThan(0);
  });
});

describe("compact/expand round trip over every catalog entry", () => {
  test("expanding then recompacting reproduces the committed artifact exactly", () => {
    const mismatches: string[] = [];
    for (const [id, compacted] of compactedById) {
      if (compacted === undefined) {
        continue;
      }
      const expanded = expandSchemaDefs(compacted);
      if (expanded === null) {
        mismatches.push(`${id}: $defs refs do not resolve`);
        continue;
      }
      // Expansion must leave nothing behind to resolve. A half-resolved schema
      // would be validated against whatever a validator makes of a dangling
      // ref, which is exactly the silent divergence this guards.
      if (JSON.stringify(expanded).includes('"$ref"')) {
        mismatches.push(`${id}: expanded schema still contains a $ref`);
        continue;
      }
      const recompacted = compactSchemaDefs(expanded);
      if (recompacted.status !== "compacted") {
        mismatches.push(`${id}: recompaction failed: ${recompacted.reason}`);
        continue;
      }
      // Deterministic down to the byte, in a different process than the one
      // that wrote the artifact.
      if (
        JSON.stringify(recompacted.inputSchema) !== JSON.stringify(compacted)
      ) {
        mismatches.push(`${id}: recompaction did not reproduce the artifact`);
        continue;
      }
      // The other direction, so neither pass can drift from the other.
      if (
        JSON.stringify(expandSchemaDefs(recompacted.inputSchema)) !==
        JSON.stringify(expanded)
      ) {
        mismatches.push(`${id}: re-expansion did not reproduce the schema`);
      }
    }
    expect(mismatches).toEqual([]);
  });
});

const condition = {
  type: "object",
  required: ["operator", "value"],
  properties: {
    operator: { type: "string", enum: ["eq", "neq", "gt", "lt", "contains"] },
    value: {
      type: "string",
      description: "The value the operator compares the column against",
    },
    caseSensitive: {
      type: "boolean",
      description: "Whether a string comparison is case sensitive",
    },
  },
};

describe("compactSchemaDefs", () => {
  test("hoists a repeated subschema and expands back to the source", () => {
    const source = {
      body: {
        type: "object",
        properties: { where: condition, having: condition, unless: condition },
      },
    };
    const result = compactSchemaDefs(source);
    expect(result.status).toBe("compacted");
    if (result.status !== "compacted") {
      return;
    }
    expect(Object.keys(result.inputSchema.$defs ?? {})).toHaveLength(1);
    expect(inputSchemaByteSize(result.inputSchema)).toBeLessThan(
      inputSchemaByteSize(source),
    );
    expect(expandSchemaDefs(result.inputSchema)).toEqual(source);
  });

  test("leaves a schema with nothing worth hoisting byte-identical", () => {
    const source = {
      query: { type: "object", properties: { id: { type: "string" } } },
    };
    const result = compactSchemaDefs(source);
    expect(result.status).toBe("compacted");
    if (result.status !== "compacted") {
      return;
    }
    expect(JSON.stringify(result.inputSchema)).toBe(JSON.stringify(source));
    expect(result.inputSchema.$defs).toBeUndefined();
  });

  test("sizes a non-ASCII fragment by its UTF-8 bytes, not code units", () => {
    // The export cap is bytes. A fragment under the hoist threshold in UTF-16
    // code units but over it in UTF-8 was skipped, so a schema of repeated
    // non-ASCII prose could fail the cap that $defs hoisting would have cleared.
    const described = {
      type: "string",
      description: "Смотрите документацию по условиям фильтра матери".repeat(3),
    };
    const source = {
      body: {
        type: "object",
        properties: { first: described, second: described },
      },
    };
    expect(JSON.stringify(described).length).toBeLessThan(
      Buffer.byteLength(JSON.stringify(described), "utf-8"),
    );

    const result = compactSchemaDefs(source);
    expect(result.status).toBe("compacted");
    if (result.status !== "compacted") {
      return;
    }
    expect(Object.keys(result.inputSchema.$defs ?? {})).toHaveLength(1);
    expect(inputSchemaByteSize(result.inputSchema)).toBeLessThan(
      inputSchemaByteSize(source),
    );
    expect(expandSchemaDefs(result.inputSchema)).toEqual(source);
  });

  test("does not hoist a repeated fragment too small to pay for its ref", () => {
    const source = {
      body: {
        type: "object",
        properties: { a: { type: "string" }, b: { type: "string" } },
      },
    };
    const result = compactSchemaDefs(source);
    expect(result.status).toBe("compacted");
    if (result.status !== "compacted") {
      return;
    }
    expect(JSON.stringify(result.inputSchema)).toBe(JSON.stringify(source));
  });

  test("hoists a repeated subschema nested inside another hoisted one", () => {
    const conditionList = {
      type: "array",
      items: condition,
      description: "Conditions applied in order, all of which must hold",
    };
    const source = {
      body: {
        type: "object",
        properties: {
          all: conditionList,
          any: conditionList,
          none: {
            type: "object",
            properties: { inner: condition, outer: condition },
          },
        },
      },
    };
    const result = compactSchemaDefs(source);
    expect(result.status).toBe("compacted");
    if (result.status !== "compacted") {
      return;
    }
    // The list and the condition inside it each earn a def, and the list's
    // stored body refs the condition instead of repeating it.
    const defs = result.inputSchema.$defs ?? {};
    expect(Object.keys(defs)).toHaveLength(2);
    expect(expandSchemaDefs(result.inputSchema)).toEqual(source);
  });

  test("refuses a source schema that already speaks $ref", () => {
    const result = compactSchemaDefs({
      body: { type: "object", properties: { self: { $ref: "#/$defs/other" } } },
    });
    expect(result.status).toBe("unsupported");
  });

  test("substitutes refs only in schema positions, never over a property map", () => {
    // `properties` is a MAP of schemas, not a schema: replacing the map itself
    // with a `$ref` would round-trip fine here and produce a document no other
    // JSON Schema reader could make sense of.
    const column = {
      type: "string",
      description:
        "The column this clause applies to, given as its stable field id rather than its display label, because display labels are user-editable and are not unique within a view. Long enough on its own to be worth hoisting.",
    };
    const shared = { first: column, second: column };
    const source = {
      body: { type: "object", properties: shared },
      query: { type: "object", title: "Query", properties: shared },
    };
    const result = compactSchemaDefs(source);
    expect(result.status).toBe("compacted");
    if (result.status !== "compacted") {
      return;
    }
    const properties = recordOf(
      recordOf(result.inputSchema.body)["properties"],
    );
    expect(Object.keys(properties)).toEqual(["first", "second"]);
    for (const value of Object.values(properties)) {
      expect(Object.keys(recordOf(value))).toEqual(["$ref"]);
    }
    expect(expandSchemaDefs(result.inputSchema)).toEqual(source);
  });
});

describe("expandSchemaDefs bounds", () => {
  test("rejects a ref to a def that is not there", () => {
    expect(
      expandSchemaDefs({ body: { $ref: "#/$defs/missing" }, $defs: {} }),
    ).toBeNull();
  });

  test("rejects a ref cycle", () => {
    expect(
      expandSchemaDefs({
        body: { $ref: "#/$defs/a" },
        $defs: {
          a: { items: { $ref: "#/$defs/b" } },
          b: { items: { $ref: "#/$defs/a" } },
        },
      }),
    ).toBeNull();
  });

  test("rejects a pointer outside $defs", () => {
    expect(
      expandSchemaDefs({ body: { $ref: "#/body/properties/x" } }),
    ).toBeNull();
  });

  test("rejects a $ref carrying siblings", () => {
    expect(
      expandSchemaDefs({
        body: { $ref: "#/$defs/a", type: "object" },
        $defs: { a: { type: "string" } },
      }),
    ).toBeNull();
  });

  test("rejects a remote ref", () => {
    expect(
      expandSchemaDefs({ body: { $ref: "https://example.test/schema.json" } }),
    ).toBeNull();
  });

  test("keeps legitimate null values in the schema", () => {
    const source = {
      body: { type: ["string", "null"], default: null, enum: ["a", null] },
    };
    expect(expandSchemaDefs(source)).toEqual(source);
  });
});
