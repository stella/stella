import { describe, expect, test } from "bun:test";

import { schemaBreaks } from "./mcp-schema-compat";

const stringSchema = { type: "string" };
const numberSchema = { type: "number" };

const objectSchema = (
  properties: Record<string, unknown>,
  required: string[] = [],
) => ({
  type: "object",
  properties,
  required,
});

describe("output compatibility", () => {
  test("keeps existing field names during a rename", () => {
    const previous = objectSchema({ title: stringSchema });
    const renamed = objectSchema({ label: stringSchema });
    const additive = objectSchema({ title: stringSchema, label: stringSchema });

    expect(schemaBreaks("output", previous, renamed)).toEqual([
      { path: "/properties/title", rule: "output-property-removed" },
    ]);
    expect(schemaBreaks("output", previous, additive)).toEqual([]);
  });

  test("preserves the type of an output field", () => {
    const previous = objectSchema({ title: stringSchema });
    const changed = objectSchema({ title: numberSchema });
    const documented = objectSchema({
      title: { ...stringSchema, description: "The title of the record" },
    });

    expect(schemaBreaks("output", previous, changed)).toEqual([
      { path: "/properties/title/type", rule: "output-type-changed" },
    ]);
    expect(schemaBreaks("output", previous, documented)).toEqual([]);
  });

  test("only emits enum values the previous schema allowed", () => {
    const previous = { type: "string", enum: ["draft", "final"] };
    const expanded = { type: "string", enum: ["draft", "final", "archived"] };
    const narrowed = { type: "string", enum: ["final"] };

    expect(schemaBreaks("output", previous, expanded)).toEqual([
      { path: "/enum", rule: "output-enum-expanded" },
    ]);
    expect(schemaBreaks("output", previous, narrowed)).toEqual([]);
  });

  test("allows added fields when the previous output object is open", () => {
    const previous = objectSchema({ title: stringSchema });
    const current = objectSchema({ title: stringSchema, label: stringSchema });

    expect(
      schemaBreaks(
        "output",
        { ...previous, additionalProperties: false },
        current,
      ),
    ).toEqual([
      {
        path: "/properties/label",
        rule: "output-closed-object-property-added",
      },
    ]);
    expect(schemaBreaks("output", previous, current)).toEqual([]);
    expect(
      schemaBreaks(
        "output",
        { ...previous, additionalProperties: true },
        current,
      ),
    ).toEqual([]);
  });

  test("rejects closing a previously open output object", () => {
    const previous = objectSchema({ title: stringSchema });
    const closed = { ...previous, additionalProperties: false };

    expect(schemaBreaks("output", previous, closed)).toEqual([
      { path: "/additionalProperties", rule: "output-object-closed" },
    ]);
    expect(
      schemaBreaks(
        "output",
        { ...previous, additionalProperties: true },
        closed,
      ),
    ).toEqual([
      { path: "/additionalProperties", rule: "output-object-closed" },
    ]);
    expect(schemaBreaks("output", closed, previous)).toEqual([]);
  });

  test("rejects introducing an output enum on a field with examples", () => {
    const previous = { ...stringSchema, examples: ["draft", "final"] };
    const current = { ...stringSchema, enum: ["draft", "final"] };

    expect(schemaBreaks("output", previous, current)).toEqual([
      { path: "/enum", rule: "output-enum-introduced" },
    ]);
  });

  test("allows migrating an output enum to examples drawn from the same values", () => {
    const previous = { ...stringSchema, enum: ["draft", "final"] };
    const same = { ...stringSchema, examples: ["final", "draft"] };
    const expanded = {
      ...stringSchema,
      examples: ["final", "draft", "archived"],
    };

    expect(schemaBreaks("output", previous, same)).toEqual([]);
    expect(schemaBreaks("output", previous, expanded)).toEqual([
      { path: "/examples/2", rule: "output-enum-expanded" },
    ]);
    expect(schemaBreaks("output", previous, stringSchema)).toEqual([
      { path: "/enum", rule: "output-enum-removed" },
    ]);
  });

  test("allows new examples for an output field without an enum", () => {
    const previous = { ...stringSchema, examples: ["draft", "final"] };
    const current = {
      ...stringSchema,
      examples: ["draft", "final", "archived"],
    };

    expect(schemaBreaks("output", previous, current)).toEqual([]);
    expect(schemaBreaks("output", stringSchema, current)).toEqual([]);
  });

  test("preserves output constants when their schemas change", () => {
    const draft = { ...stringSchema, const: "draft" };
    const final = { ...stringSchema, const: "final" };
    const examples = { ...stringSchema, examples: ["draft"] };

    expect(schemaBreaks("output", draft, final)).toEqual([
      { path: "/const", rule: "output-const-expanded" },
    ]);
    expect(schemaBreaks("output", draft, examples)).toEqual([
      { path: "/const", rule: "output-const-expanded" },
    ]);
    expect(
      schemaBreaks("output", draft, { ...stringSchema, enum: ["draft"] }),
    ).toEqual([{ path: "/enum", rule: "output-enum-introduced" }]);
    expect(
      schemaBreaks("output", draft, { ...draft, examples: ["draft"] }),
    ).toEqual([]);
    expect(schemaBreaks("output", stringSchema, draft)).toEqual([]);
  });

  test("keeps required output fields required", () => {
    const properties = { title: stringSchema, label: stringSchema };
    const previous = objectSchema(properties, ["title"]);

    expect(schemaBreaks("output", previous, objectSchema(properties))).toEqual([
      { path: "/properties/title", rule: "output-required-property-relaxed" },
    ]);
    expect(
      schemaBreaks(
        "output",
        previous,
        objectSchema(properties, ["title", "label"]),
      ),
    ).toEqual([]);
  });

  test("reports the added terms field inside a closed case-law search result", () => {
    const resultProperties = { decisionId: stringSchema };
    const result = {
      ...objectSchema(resultProperties, ["decisionId"]),
      additionalProperties: false,
    };
    const terms = objectSchema(
      {
        query: { type: "integer" },
        matched: { type: "array", items: stringSchema },
        missing: { type: "array", items: stringSchema },
      },
      ["query", "matched", "missing"],
    );
    const previous = objectSchema({
      results: { type: "array", items: result },
    });
    const current = objectSchema({
      results: {
        type: "array",
        items: {
          ...result,
          properties: { ...resultProperties, terms },
          required: ["decisionId", "terms"],
        },
      },
    });

    expect(schemaBreaks("output", previous, current)).toEqual([
      {
        path: "/properties/results/items/properties/terms",
        rule: "output-closed-object-property-added",
      },
    ]);
  });
});

describe("input compatibility", () => {
  test("allows added parameters when they are optional", () => {
    const previous = objectSchema({ query: stringSchema }, ["query"]);
    const properties = { query: stringSchema, limit: numberSchema };

    expect(
      schemaBreaks(
        "input",
        previous,
        objectSchema(properties, ["query", "limit"]),
      ),
    ).toEqual([
      { path: "/properties/limit", rule: "input-required-property-added" },
    ]);
    expect(
      schemaBreaks("input", previous, objectSchema(properties, ["query"])),
    ).toEqual([]);
  });

  test("keeps accepting existing optional parameters", () => {
    const properties = { query: stringSchema, limit: numberSchema };
    const previous = objectSchema(properties, ["query"]);

    expect(
      schemaBreaks(
        "input",
        previous,
        objectSchema({ query: stringSchema }, ["query"]),
      ),
    ).toEqual([{ path: "/properties/limit", rule: "input-property-removed" }]);
    expect(schemaBreaks("input", previous, objectSchema(properties))).toEqual(
      [],
    );
  });

  test("keeps accepting every previous enum value", () => {
    const previous = { type: "string", enum: ["draft", "final"] };
    const narrowed = { type: "string", enum: ["final"] };
    const expanded = { type: "string", enum: ["draft", "final", "archived"] };

    expect(schemaBreaks("input", previous, narrowed)).toEqual([
      { path: "/enum", rule: "input-enum-narrowed" },
    ]);
    expect(schemaBreaks("input", previous, expanded)).toEqual([]);
  });

  test.each([
    { keyword: "minimum", previous: 1, tighter: 2, looser: 0 },
    { keyword: "maximum", previous: 10, tighter: 9, looser: 11 },
    { keyword: "minLength", previous: 2, tighter: 3, looser: 1 },
    { keyword: "maxLength", previous: 9, tighter: 8, looser: 10 },
  ])(
    "allows loosening $keyword and rejects tightening it",
    ({ keyword, previous, tighter, looser }) => {
      const schema = keyword.endsWith("Length") ? stringSchema : numberSchema;
      const oldSchema = { ...schema, [keyword]: previous };

      expect(
        schemaBreaks("input", oldSchema, { ...schema, [keyword]: tighter }),
      ).toEqual([{ path: `/${keyword}`, rule: "input-constraint-tightened" }]);
      expect(
        schemaBreaks("input", oldSchema, { ...schema, [keyword]: looser }),
      ).toEqual([]);
    },
  );

  test("allows removing an input pattern and rejects imposing it", () => {
    const constrained = { ...stringSchema, pattern: "^[a-z]+$" };

    expect(schemaBreaks("input", stringSchema, constrained)).toEqual([
      { path: "/pattern", rule: "input-constraint-tightened" },
    ]);
    expect(schemaBreaks("input", constrained, stringSchema)).toEqual([]);
  });
});

describe("schema references", () => {
  const treeSchema = (definition: string, label: unknown) => {
    const key = definition.replaceAll("~", "~0").replaceAll("/", "~1");
    const node = { $ref: `#/$defs/${key}` };
    return {
      ...objectSchema({ root: node }),
      $defs: {
        [definition]: objectSchema({
          children: { type: "array", items: node },
          label,
        }),
      },
    };
  };

  test("follows changed recursive definitions through unchanged references", () => {
    const previous = treeSchema("node", stringSchema);
    const current = treeSchema("node", numberSchema);

    expect(schemaBreaks("output", previous, current)).toEqual([
      {
        path: "/$defs/node/properties/label/type",
        rule: "output-type-changed",
      },
    ]);
  });

  test("allows renamed reference targets that still describe the same recursive tree", () => {
    expect(
      schemaBreaks(
        "output",
        treeSchema("a/b~c", stringSchema),
        treeSchema("node", stringSchema),
      ),
    ).toEqual([]);
  });

  test("follows references into draft-07 definitions", () => {
    const previous = {
      definitions: { mixin: stringSchema },
      $ref: "#/definitions/mixin",
    };
    const current = {
      definitions: { mixin: numberSchema },
      $ref: "#/definitions/mixin",
    };

    expect(schemaBreaks("input", previous, current)).toEqual([
      { path: "/definitions/mixin/type", rule: "input-constraint-tightened" },
    ]);
  });
});

describe("schema structure and output constraints", () => {
  test("rejects changes to unsupported structural keywords", () => {
    const previous = { allOf: [stringSchema] };
    const current = { allOf: [stringSchema, { minLength: 2 }] };

    expect(schemaBreaks("input", previous, current)).toEqual([
      { path: "/allOf", rule: "unsupported-schema-keyword-changed" },
    ]);
  });

  test("compares the value schema of a map", () => {
    const previous = { type: "object", additionalProperties: stringSchema };
    const current = { type: "object", additionalProperties: numberSchema };

    expect(schemaBreaks("output", previous, current)).toEqual([
      { path: "/additionalProperties/type", rule: "output-type-changed" },
    ]);
  });

  test("reports output constraints removed or relaxed", () => {
    const previous = { ...stringSchema, pattern: "^s", maxLength: 10 };
    const relaxed = { ...stringSchema, maxLength: 20 };
    const tightened = { ...previous, maxLength: 5 };

    expect(schemaBreaks("output", previous, relaxed)).toEqual([
      { path: "/maxLength", rule: "output-constraint-relaxed" },
      { path: "/pattern", rule: "output-constraint-relaxed" },
    ]);
    expect(schemaBreaks("output", previous, tightened)).toEqual([]);
  });
});
