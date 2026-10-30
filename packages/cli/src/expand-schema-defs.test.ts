import { expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import { expandSchemaDefs } from "./expand-schema-defs.js";

// Recursive pre-refactor oracle: preserve its traversal and refusal contract.
/** Same-document pointer prefix; the only `$ref` form this module accepts. */
const DEFS_REF_PREFIX = "#/$defs/";

/** The document key the exporter hoists shared subschemas into. */
const DEFS_KEY = "$defs";

/**
 * Guard rails against a corrupt artifact. Real capability schemas nest a few
 * dozen levels and expand to a few thousand nodes, so these bounds sit far
 * above anything the exporter produces and only fire on a malformed document.
 */
const MAX_EXPANSION_DEPTH = 200;
const MAX_EXPANSION_NODES = 500_000;

/**
 * Failure sentinel. `null` cannot serve: it is a legitimate JSON Schema value
 * (`default: null`, `enum: [null]`), so a nullable return would conflate "this
 * subtree is null" with "this document is malformed".
 */
const EXPANSION_FAILED = Symbol("expansion-failed");

type JsonRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The `$defs` name a node points at, or `null` when the node is not the
 * `{"$ref": "#/$defs/<name>"}` shape the compactor emits. A `$ref` with
 * siblings, a non-string `$ref`, or a pointer anywhere but `$defs` is not
 * something the compactor can produce, so it fails expansion instead of being
 * resolved on a guess.
 */
const defsRefName = (node: JsonRecord): string | null => {
  const ref = node["$ref"];
  if (
    Object.keys(node).length !== 1 ||
    typeof ref !== "string" ||
    !ref.startsWith(DEFS_REF_PREFIX)
  ) {
    return null;
  }
  const name = ref.slice(DEFS_REF_PREFIX.length);
  return name.length === 0 || name.includes("/") ? null : name;
};

type ExpansionState = {
  defs: JsonRecord;
  /** Names on the current resolution path, so a `$ref` cycle is caught. */
  resolving: Set<string>;
  /** Remaining node budget, shared across the whole document. */
  budget: number;
};

const expandValue = ({
  value,
  depth,
  state,
}: {
  value: unknown;
  depth: number;
  state: ExpansionState;
}): unknown => {
  if (depth > MAX_EXPANSION_DEPTH) {
    return EXPANSION_FAILED;
  }
  state.budget -= 1;
  if (state.budget < 0) {
    return EXPANSION_FAILED;
  }
  if (Array.isArray(value)) {
    const items: unknown[] = [];
    for (const item of value) {
      const expanded = expandValue({ value: item, depth: depth + 1, state });
      if (expanded === EXPANSION_FAILED) {
        return EXPANSION_FAILED;
      }
      items.push(expanded);
    }
    return items;
  }
  if (!isRecord(value)) {
    return value;
  }
  if ("$ref" in value) {
    const name = defsRefName(value);
    if (name === null) {
      return EXPANSION_FAILED;
    }
    // An unknown name or a name already on the resolution path is a corrupt
    // artifact: the compactor only ever emits refs to defs it wrote, and a
    // subschema cannot structurally contain itself, so no cycle can arise from
    // a well-formed export.
    //
    // `Object.hasOwn` rather than a plain read: `state.defs` comes from
    // `JSON.parse` and still inherits `Object.prototype`, so a ref to
    // `#/$defs/constructor` would otherwise resolve to an inherited function
    // and be inlined as a lost subtree instead of failing loudly.
    if (!Object.hasOwn(state.defs, name) || state.resolving.has(name)) {
      return EXPANSION_FAILED;
    }
    const target = state.defs[name];
    state.resolving.add(name);
    const expanded = expandValue({ value: target, depth: depth + 1, state });
    state.resolving.delete(name);
    return expanded;
  }
  // Collected then built with `Object.fromEntries`, which defines own data
  // properties: a JSON-parsed document can carry an own `__proto__` key, and
  // assigning that key would invoke the prototype setter instead of storing it.
  const entries: [string, unknown][] = [];
  for (const [key, child] of Object.entries(value)) {
    const expandedChild = expandValue({
      value: child,
      depth: depth + 1,
      state,
    });
    if (expandedChild === EXPANSION_FAILED) {
      return EXPANSION_FAILED;
    }
    entries.push([key, expandedChild]);
  }
  return Object.fromEntries(entries);
};

/**
 * Inline every `#/$defs/...` reference in a document and drop its `$defs`
 * block, yielding the schema the handler config declared. A document with
 * neither `$defs` nor `$ref` comes back unchanged (most capabilities), so this
 * is safe to run over anything the catalog carries.
 *
 * Two document shapes go through here, both `$defs`-at-the-root: a catalog
 * entry's `{ $defs?, body?, params?, query? }` input schema, and the CLI leaf's
 * synthesized `--input` wrapper schema.
 *
 * Returns `null` when the document cannot be expanded: unknown or malformed
 * ref, ref cycle, or a bound exceeded. Callers surface that as a malformed
 * snapshot rather than shipping a half-resolved schema.
 */
const recursiveExpandSchemaDefs = (
  document: Record<string, unknown>,
): Record<string, unknown> | null => {
  const rawDefs = document[DEFS_KEY];
  if (rawDefs !== undefined && !isRecord(rawDefs)) {
    return null;
  }
  const state: ExpansionState = {
    budget: MAX_EXPANSION_NODES,
    defs: rawDefs ?? {},
    resolving: new Set<string>(),
  };
  const expanded: [string, unknown][] = [];
  for (const [key, value] of Object.entries(document)) {
    if (key === DEFS_KEY) {
      continue;
    }
    const expandedValue = expandValue({ value, depth: 0, state });
    if (expandedValue === EXPANSION_FAILED) {
      return null;
    }
    expanded.push([key, expandedValue]);
  }
  return Object.fromEntries(expanded);
};

const generatedDocument = fc
  .record({
    leaf: fc.jsonValue(),
    steps: fc.array(
      fc.record({
        type: fc.constantFrom("array", "object", "ref"),
        key: fc.constantFrom("0", "10", "name", "__proto__", "nested"),
      }),
      { minLength: 1, maxLength: 12 },
    ),
    refusal: fc.constantFrom(
      "none",
      "missing",
      "siblings",
      "cycle",
      "remote",
      "invalid-defs",
    ),
  })
  .map(({ leaf, steps, refusal }) => {
    let value: unknown = leaf;
    const definitions: [string, unknown][] = [];
    for (const [index, step] of steps.entries()) {
      switch (step.type) {
        case "array":
          value = [value, null, { default: null }];
          break;
        case "object":
          value = Object.fromEntries([
            [step.key, value],
            ["tail", null],
          ]);
          break;
        case "ref": {
          const name = `definition${index}`;
          definitions.push([name, value]);
          value = { $ref: `#/$defs/${name}` };
          break;
        }
      }
    }
    const defs = Object.fromEntries(definitions);
    const document = {
      before: null,
      body: value,
      after: [null, "last"],
      $defs: defs,
    };
    switch (refusal) {
      case "missing":
        return { ...document, body: { $ref: "#/$defs/missing" } };
      case "siblings":
        return {
          ...document,
          body: { $ref: "#/$defs/missing", type: "string" },
        };
      case "cycle":
        return {
          ...document,
          $defs: { ...defs, cycle: { $ref: "#/$defs/cycle" } },
          body: { $ref: "#/$defs/cycle" },
        };
      case "remote":
        return { ...document, body: { $ref: "https://example.test/schema" } };
      case "invalid-defs":
        return { ...document, $defs: [] };
      default:
        return document;
    }
  });

test("iterative schema expansion matches the recursive contract and property order", () => {
  assertProperty(
    "iterative schema expansion matches the recursive contract and property order",
    fc.property(generatedDocument, (document) => {
      const expected = recursiveExpandSchemaDefs(document);
      const expanded = expandSchemaDefs(document);
      expect(expanded).toEqual(expected);
      expect(JSON.stringify(expanded)).toBe(JSON.stringify(expected));
    }),
  );
});

test("mixed ref chains, objects and arrays preserve sibling ref reuse", () => {
  const scalar = { type: "string", default: null };
  const inner = {
    items: [scalar, { type: "object", properties: { value: scalar } }],
  };
  const outer = { anyOf: [inner, { type: "array", items: inner }] };
  const document = {
    $defs: {
      scalar,
      inner: {
        items: [
          { $ref: "#/$defs/scalar" },
          { type: "object", properties: { value: { $ref: "#/$defs/scalar" } } },
        ],
      },
      middle: { $ref: "#/$defs/inner" },
      outer: {
        anyOf: [
          { $ref: "#/$defs/middle" },
          { type: "array", items: { $ref: "#/$defs/middle" } },
        ],
      },
    },
    before: null,
    body: { $ref: "#/$defs/outer" },
    after: [{ $ref: "#/$defs/middle" }, { $ref: "#/$defs/scalar" }],
  };
  const expected = { before: null, body: outer, after: [inner, scalar] };
  expect(expandSchemaDefs(document)).toEqual(expected);
  expect(JSON.stringify(expandSchemaDefs(document))).toBe(
    JSON.stringify(expected),
  );
  expect(JSON.stringify(expandSchemaDefs(document))).toBe(
    JSON.stringify(recursiveExpandSchemaDefs(document)),
  );
});

test("numeric and __proto__ own keys retain ordinary enumeration order", () => {
  const document = Object.fromEntries([
    ["z", { $ref: "#/$defs/leaf" }],
    ["2", null],
    ["10", "ten"],
    ["__proto__", { $ref: "#/$defs/leaf" }],
    ["a", [{ $ref: "#/$defs/leaf" }]],
    [
      "$defs",
      {
        leaf: Object.fromEntries([
          ["last", null],
          ["1", "one"],
          ["__proto__", "own"],
        ]),
      },
    ],
  ]);
  const expanded = expandSchemaDefs(document);
  if (expanded === null) {
    expect.unreachable("Expected a valid expanded document");
  }
  expect(Object.keys(expanded)).toEqual(["2", "10", "z", "__proto__", "a"]);
  expect(Object.hasOwn(expanded, "__proto__")).toBe(true);
  expect(Object.getPrototypeOf(expanded)).toBe(Object.prototype);
  expect(JSON.stringify(expanded)).toBe(
    JSON.stringify(recursiveExpandSchemaDefs(document)),
  );
});

const nestedDocument = (depth: number) => {
  let value: unknown = null;
  for (let index = 0; index < depth; index += 1) {
    value = { nested: value };
  }
  return { body: value };
};

const refDepthDocument = (depth: number) => {
  const definitions: [string, unknown][] = [];
  for (let index = 0; index < depth; index += 1) {
    const target =
      index + 1 < depth ? { $ref: `#/$defs/definition${index + 1}` } : null;
    definitions.push([`definition${index}`, target]);
  }
  return {
    $defs: Object.fromEntries(definitions),
    body: { $ref: "#/$defs/definition0" },
  };
};

test.each([200, 201])(
  "depth %s has the same exact recursive boundary",
  (depth) => {
    for (const document of [nestedDocument(depth), refDepthDocument(depth)]) {
      const expanded = expandSchemaDefs(document);
      expect(expanded).toEqual(recursiveExpandSchemaDefs(document));
      expect(expanded === null).toBe(depth === 201);
    }
  },
);

test("the 500000-node budget is shared across top-level values", () => {
  const values = Array.from({ length: 249_999 }, () => null);
  const document = { first: values, second: values };
  const expanded = expandSchemaDefs(document);
  if (expanded === null) {
    expect.unreachable("Exactly 500000 visits must fit");
  }
  const first = expanded["first"];
  const second = expanded["second"];
  if (!Array.isArray(first) || !Array.isArray(second)) {
    expect.unreachable("Expected expanded arrays");
  }
  expect(first.length).toBe(249_999);
  expect(second.length).toBe(249_999);
  expect(recursiveExpandSchemaDefs(document)).not.toBeNull();
  const exceeded = { ...document, third: null };
  expect(expandSchemaDefs(exceeded)).toBeNull();
  expect(recursiveExpandSchemaDefs(exceeded)).toBeNull();
});

test("reference nodes and their targets both consume the shared node budget", () => {
  const references = Array.from({ length: 249_999 }, () => ({
    $ref: "#/$defs/leaf",
  }));
  const document = { $defs: { leaf: null }, body: references, after: null };
  const expanded = expandSchemaDefs(document);
  if (expanded === null) {
    expect.unreachable("Exactly 500000 visits must fit");
  }
  expect(expanded["body"]).toEqual(Array.from({ length: 249_999 }, () => null));
  expect(expanded["after"]).toBeNull();
  expect(recursiveExpandSchemaDefs(document)).toEqual(expanded);
  const exceeded = { ...document, extra: null };
  expect(expandSchemaDefs(exceeded)).toBeNull();
  expect(recursiveExpandSchemaDefs(exceeded)).toBeNull();
});

test.each([
  {
    name: "missing def",
    document: { $defs: {}, body: { $ref: "#/$defs/missing" } },
  },
  {
    name: "inherited def",
    document: { $defs: {}, body: { $ref: "#/$defs/constructor" } },
  },
  { name: "empty def name", document: { body: { $ref: "#/$defs/" } } },
  { name: "nested pointer", document: { body: { $ref: "#/$defs/a/items" } } },
  {
    name: "remote pointer",
    document: { body: { $ref: "https://example.test/schema" } },
  },
  { name: "nonstring pointer", document: { body: { $ref: 42 } } },
  {
    name: "ref siblings",
    document: {
      $defs: { a: null },
      body: { $ref: "#/$defs/a", default: null },
    },
  },
  { name: "invalid defs", document: { $defs: [], body: null } },
  {
    name: "active path cycle",
    document: {
      $defs: {
        a: { items: { $ref: "#/$defs/b" } },
        b: { anyOf: [{ $ref: "#/$defs/a" }] },
      },
      body: { $ref: "#/$defs/a" },
    },
  },
])(
  "malformed compacted schemas preserve null refusal: $name",
  ({ document }) => {
    expect(expandSchemaDefs(document)).toBeNull();
    expect(recursiveExpandSchemaDefs(document)).toBeNull();
  },
);

test("legitimate null data never becomes the expansion failure sentinel", () => {
  const document = {
    $defs: { nullable: null },
    before: null,
    body: { $ref: "#/$defs/nullable" },
    after: [null, { default: null }],
  };
  expect(expandSchemaDefs(document)).toEqual({
    before: null,
    body: null,
    after: [null, { default: null }],
  });
  expect(expandSchemaDefs(document)).toEqual(
    recursiveExpandSchemaDefs(document),
  );
});
