import { Ajv } from "ajv";
import type { ValidateFunction } from "ajv";
import addFormats from "ajv-formats";
import fc from "fast-check";

import { AGENT_INPUT_NORMALIZATION_KEY } from "@stll/agent-input";

/**
 * An independent reading of the JSON Schemas the MCP surface publishes: Ajv's
 * draft-07 validator, the dialect the generator targets, in strict mode so an
 * unknown keyword or a keyword on the wrong type fails compilation instead of
 * being ignored. The one extension keyword the surface emits is registered as
 * an annotation.
 */
export const createWireSchemaValidator = (): Ajv => {
  const ajv = new Ajv({ allowUnionTypes: true, strict: true });
  addFormats(ajv);
  ajv.addKeyword({ keyword: AGENT_INPUT_NORMALIZATION_KEY });
  return ajv;
};

/**
 * Compiles a schema exactly as the surface publishes it. The SDK types an
 * absent `$schema` as `string | undefined`, which Ajv's schema type does not
 * admit under exact optional properties; the published object is read as a
 * plain JSON object instead.
 */
export const compileWireSchema = (
  ajv: Ajv,
  schema: Readonly<Record<string, unknown>>,
): ValidateFunction => ajv.compile(schema);

type SchemaNode = Record<string, unknown>;

const isSchemaNode = (value: unknown): value is SchemaNode =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const numberOr = (value: unknown, fallback: number): number =>
  typeof value === "number" ? value : fallback;

// The generator stops descending here; a deeper node is any JSON value.
const MAX_ARBITRARY_DEPTH = 8;
const EXTRA_ARRAY_ITEMS = 3;

const FORMAT_ARBITRARIES: Readonly<Record<string, fc.Arbitrary<string>>> = {
  date: fc
    .date({
      min: new Date("1900-01-01T00:00:00Z"),
      max: new Date("2199-12-31T00:00:00Z"),
      noInvalidDate: true,
    })
    .map((date) => date.toISOString().slice(0, 10)),
  "date-time": fc
    .date({ noInvalidDate: true })
    .map((date) => date.toISOString()),
  email: fc.emailAddress(),
  uri: fc.webUrl(),
  uuid: fc.uuid(),
};

const stringArbitrary = (node: SchemaNode): fc.Arbitrary<string> => {
  const format = node["format"];
  const formatArbitrary =
    typeof format === "string" ? FORMAT_ARBITRARIES[format] : undefined;
  if (formatArbitrary !== undefined) {
    return formatArbitrary;
  }
  const pattern = node["pattern"];
  if (typeof pattern === "string") {
    return fc.stringMatching(new RegExp(pattern, "u"));
  }
  const minLength = numberOr(node["minLength"], 0);
  return fc.string({
    minLength,
    maxLength: Math.min(
      numberOr(node["maxLength"], minLength + 12),
      minLength + 12,
    ),
  });
};

const numberArbitrary = (
  node: SchemaNode,
  integer: boolean,
): fc.Arbitrary<number> => {
  const min = numberOr(node["minimum"], -1000);
  const max = Math.max(numberOr(node["maximum"], 1000), min);
  return integer
    ? fc.integer({ min, max })
    : fc.double({ min, max, noDefaultInfinity: true, noNaN: true });
};

/**
 * The values a schema node describes, or near it: every declared shape, with
 * required keys, some optional keys and, where the node allows them, extra
 * keys. It reads the draft-07 subset the MCP generator emits and is a source of
 * test inputs, not a validator; a value it draws may still be rejected (a
 * pattern it cannot honour, say), which a caller comparing two validators on
 * the same value does not mind.
 */
const schemaValueArbitrary = (
  schema: unknown,
  depth = 0,
): fc.Arbitrary<unknown> => {
  if (!isSchemaNode(schema) || depth > MAX_ARBITRARY_DEPTH) {
    return fc.jsonValue({ maxDepth: 2 });
  }
  const values = schema["enum"];
  if (Array.isArray(values) && values.length > 0) {
    return fc.constantFrom<unknown>(...values);
  }
  const { anyOf: alternatives, ...siblings } = schema;
  if (Array.isArray(alternatives) && alternatives.length > 0) {
    return fc.oneof(
      ...alternatives.map((branch) =>
        schemaValueArbitrary(
          isSchemaNode(branch) ? { ...siblings, ...branch } : branch,
          depth + 1,
        ),
      ),
    );
  }
  const type = schema["type"];
  if (Array.isArray(type)) {
    return fc.oneof(
      ...type.map((member: unknown) =>
        schemaValueArbitrary({ ...schema, type: member }, depth),
      ),
    );
  }
  switch (type) {
    case "null":
      return fc.constant(null);
    case "boolean":
      return fc.boolean();
    case "integer":
      return numberArbitrary(schema, true);
    case "number":
      return numberArbitrary(schema, false);
    case "string":
      return stringArbitrary(schema);
    case "array": {
      const minLength = numberOr(schema["minItems"], 0);
      return fc.array(schemaValueArbitrary(schema["items"], depth + 1), {
        minLength,
        maxLength: Math.min(
          numberOr(schema["maxItems"], minLength + EXTRA_ARRAY_ITEMS),
          minLength + EXTRA_ARRAY_ITEMS,
        ),
      });
    }
    case "object":
      return objectArbitrary(schema, depth);
    default:
      return fc.jsonValue({ maxDepth: 2 });
  }
};

const objectArbitrary = (
  schema: SchemaNode,
  depth: number,
): fc.Arbitrary<unknown> => {
  const properties = isSchemaNode(schema["properties"])
    ? schema["properties"]
    : {};
  const required = Array.isArray(schema["required"])
    ? schema["required"].filter(
        (name): name is string => typeof name === "string",
      )
    : [];
  const declared = fc.record(
    Object.fromEntries(
      Object.entries(properties).map(([name, property]) => [
        name,
        schemaValueArbitrary(property, depth + 1),
      ]),
    ),
    { requiredKeys: required.filter((name) => name in properties) },
  );
  if (schema["additionalProperties"] === false) {
    return declared;
  }
  return fc
    .tuple(
      declared,
      fc.dictionary(
        fc.string({ minLength: 1, maxLength: 8 }),
        fc.jsonValue({ maxDepth: 1 }),
        { maxKeys: 2 },
      ),
    )
    .map(([known, extra]) => {
      // Declared keys win over a drawn extra key of the same name.
      const value: Record<string, unknown> = {};
      Object.assign(value, extra, known);
      return value;
    });
};

/** Every literal a schema names anywhere, for values that sit next to a list. */
const collectLiterals = (schema: unknown, into: Set<unknown>): void => {
  if (Array.isArray(schema)) {
    for (const nested of schema) {
      collectLiterals(nested, into);
    }
    return;
  }
  if (!isSchemaNode(schema)) {
    return;
  }
  for (const [key, value] of Object.entries(schema)) {
    if (key === "enum" && Array.isArray(value)) {
      for (const literal of value) {
        into.add(literal);
      }
      continue;
    }
    collectLiterals(value, into);
  }
};

const REMOVE_KEY = Symbol("remove-key");

/**
 * A value one step off a drawn value: one node replaced by `null`, a literal
 * the schema names elsewhere, or a value of another JSON type, or one object
 * key removed. Near misses are what separate two schemas that disagree only
 * at one node.
 */
const perturb = (
  value: unknown,
  replacement: unknown,
  path: readonly number[],
): unknown => {
  const [step, ...rest] = path;
  if (step === undefined) {
    return replacement === REMOVE_KEY ? null : replacement;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return replacement === REMOVE_KEY ? [] : [replacement];
    }
    const index = step % value.length;
    if (replacement === REMOVE_KEY && rest.length === 0) {
      return value.filter((_item, position) => position !== index);
    }
    return value.map((item, position) =>
      position === index ? perturb(item, replacement, rest) : item,
    );
  }
  if (isSchemaNode(value)) {
    const keys = Object.keys(value);
    const key = keys.at(step % Math.max(keys.length, 1));
    if (key === undefined) {
      return replacement === REMOVE_KEY
        ? value
        : { ...value, extra: replacement };
    }
    if (replacement === REMOVE_KEY && rest.length === 0) {
      const { [key]: _removed, ...kept } = value;
      return kept;
    }
    return { ...value, [key]: perturb(value[key], replacement, rest) };
  }
  return replacement === REMOVE_KEY ? null : replacement;
};

/**
 * Values drawn from each schema, and near misses of those values, for
 * comparing what two schemas accept.
 */
export const schemaComparisonArbitrary = (
  schemas: readonly unknown[],
): fc.Arbitrary<unknown> => {
  const literals = new Set<unknown>();
  for (const schema of schemas) {
    collectLiterals(schema, literals);
  }
  const replacement = fc.oneof(
    fc.constant(null),
    fc.constant<unknown>(REMOVE_KEY),
    fc.constantFrom<unknown>("", 0, -1, 1.5, true, {}, []),
    ...(literals.size === 0 ? [] : [fc.constantFrom<unknown>(...literals)]),
    fc.jsonValue({ maxDepth: 1 }),
  );
  const drawn = fc.oneof(
    ...schemas.map((schema) => schemaValueArbitrary(schema)),
  );
  return fc.oneof(
    drawn,
    fc
      .tuple(
        drawn,
        replacement,
        fc.array(fc.nat({ max: 64 }), { minLength: 1, maxLength: 6 }),
      )
      .map(([value, substitute, path]) => perturb(value, substitute, path)),
  );
};
