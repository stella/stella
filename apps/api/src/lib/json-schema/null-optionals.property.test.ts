import { Ajv } from "ajv";
import { deepEquals } from "bun";
import { expect, test } from "bun:test";
import fc from "fast-check";

import {
  assertProperty,
  propertyConfig,
  propertySeed,
  propertyTestTimeout,
} from "@stll/property-testing";

import {
  withModelPlaceholdersOmitted,
  withOptionalsNullable,
} from "@/api/lib/json-schema/null-optionals";
import { isRecord, isUnknownArray } from "@/api/lib/type-guards";
import {
  ownJsonKey,
  ownKeyJsonObject,
  prototypesIntact,
  withOwnEntry,
} from "@/api/tests/helpers/own-key-json";

// A tool schema whose optional fields are widened to admit null on the wire,
// and a model that spells some absent optional fields as null: reading the
// call against the declared schema gives back exactly the input the model
// meant, and an input that already fits the declared schema is untouched.

type Schema = Record<string, unknown>;

const ajv = new Ajv({ allowUnionTypes: true, strict: false });

const leafSchema = fc.oneof(
  fc.constant<Schema>({ type: "string" }),
  fc.constant<Schema>({ type: "string", minLength: 1 }),
  fc.constant<Schema>({ type: "integer" }),
  fc.constant<Schema>({ type: "boolean" }),
  fc.constant<Schema>({ type: ["string", "null"] }),
  fc.constant<Schema>({ type: "string", enum: ["fast", "slow"] }),
  fc.constant<Schema>({ anyOf: [{ type: "string" }, { type: "number" }] }),
);

const PROPERTY_NAMES = ["a", "b", "c", "d"] as const;

const { schema: schemaArbitrary } = fc.letrec<{ schema: Schema }>((tie) => ({
  schema: fc.oneof(
    { depthSize: "small", maxDepth: 4, withCrossShrink: true },
    leafSchema,
    fc
      .uniqueArray(fc.constantFrom(...PROPERTY_NAMES), {
        minLength: 1,
        maxLength: PROPERTY_NAMES.length,
      })
      .chain((names) =>
        fc
          .tuple(
            fc.tuple(...names.map(() => tie("schema"))),
            fc.subarray(names),
            fc.boolean(),
          )
          .map(([children, required, closed]) => {
            const node: Schema = {
              type: "object",
              properties: Object.fromEntries(
                names.map((name, index) => [name, children[index]]),
              ),
              required,
            };
            if (closed) {
              node["additionalProperties"] = false;
            }
            return node;
          }),
      ),
    tie("schema").map((items) => ({ type: "array", items })),
    fc
      .tuple(tie("schema"), tie("schema"))
      .map(([left, right]) => ({ anyOf: [left, right] })),
  ),
}));

/** A value that fits `schema`, drawn from it. */
const valueOf = (schema: Schema): fc.Arbitrary<unknown> => {
  const enumValues = schema["enum"];
  if (isUnknownArray(enumValues)) {
    return fc.constantFrom(...enumValues);
  }
  const branches = schema["anyOf"];
  if (isUnknownArray(branches)) {
    return fc.oneof(...branches.filter(isRecord).map(valueOf));
  }
  const type = schema["type"];
  if (isUnknownArray(type)) {
    return fc.oneof(
      ...type.map((member) => valueOf({ ...schema, type: member })),
    );
  }
  switch (type) {
    case "string":
      return fc.string({ minLength: Number(schema["minLength"] ?? 0) });
    case "integer":
    case "number":
      return fc.integer();
    case "boolean":
      return fc.boolean();
    case "null":
      return fc.constant(null);
    case "array":
      return isRecord(schema["items"])
        ? fc.array(valueOf(schema["items"]), { maxLength: 3 })
        : fc.constant([]);
    case "object": {
      const properties = isRecord(schema["properties"])
        ? schema["properties"]
        : {};
      const required = isUnknownArray(schema["required"])
        ? schema["required"].filter((name) => typeof name === "string")
        : [];
      return fc.record(
        Object.fromEntries(
          Object.entries(properties).map(([name, property]) => [
            name,
            isRecord(property) ? valueOf(property) : fc.constant(null),
          ]),
        ),
        { requiredKeys: required },
      );
    }
    default:
      return fc.constant(null);
  }
};

/**
 * `value` with absent optional properties spelled `null` wherever `spell`
 * says so, the way a model reading the widened schema may send them. A
 * property whose declared schema takes null is skipped: there null is a
 * value, not a spelling of "not set".
 */
const spellAbsentAsNull = (
  schema: Schema,
  value: unknown,
  spell: () => boolean,
): unknown => {
  const branches = schema["anyOf"];
  if (isUnknownArray(branches)) {
    const branch = branches
      .filter(isRecord)
      .find((candidate) => ajv.validate(candidate, value));
    return branch === undefined
      ? value
      : spellAbsentAsNull(branch, value, spell);
  }
  const items = schema["items"];
  if (isRecord(items) && isUnknownArray(value)) {
    return value.map((entry) => spellAbsentAsNull(items, entry, spell));
  }
  const properties = schema["properties"];
  if (!isRecord(properties) || !isRecord(value)) {
    return value;
  }
  const required = new Set(
    isUnknownArray(schema["required"]) ? schema["required"] : [],
  );
  const spelled: Record<string, unknown> = { ...value };
  for (const [name, property] of Object.entries(properties)) {
    if (name in value) {
      spelled[name] = isRecord(property)
        ? spellAbsentAsNull(property, value[name], spell)
        : value[name];
    } else if (
      !required.has(name) &&
      !ajv.validate(isRecord(property) ? property : {}, null) &&
      spell()
    ) {
      spelled[name] = null;
    }
  }
  return spelled;
};

const caseArbitrary = schemaArbitrary
  .map((property) => ({
    type: "object",
    properties: { root: property },
    required: ["root"],
  }))
  .chain((schema) =>
    fc.record({
      schema: fc.constant(schema),
      value: valueOf(schema),
      spellings: fc.infiniteStream(fc.boolean()),
    }),
  );

const widenedSchema = (schema: Schema): Schema => {
  const widened = withOptionalsNullable(schema);
  if (!isRecord(widened)) {
    throw new TypeError("The widened schema is not an object");
  }
  return widened;
};

type Path = readonly (number | string)[];

/** `path` as the JSON pointer ajv reports an instance at. */
const pointerOf = (path: Path): string =>
  path
    .map(
      (step) => `/${String(step).replaceAll("~", "~0").replaceAll("/", "~1")}`,
    )
    .join("");

/** The spelled nulls a validation is judging, as JSON pointers. */
let judgedNulls: ReadonlySet<string> = new Set();

// An undeclared field of an open object may hold anything but a judged null:
// an open union branch takes any extra field without declaring what is in
// it, so its tolerance neither declares a spelling nor makes a null a value.
ajv.addKeyword({
  keyword: "holdsNoJudgedNull",
  schemaType: "boolean",
  validate: (
    _enabled: boolean,
    _data: unknown,
    _parent: unknown,
    context?: { instancePath: string },
  ) => {
    const at = context?.instancePath ?? "";
    return ![...judgedNulls].some(
      (pointer) => pointer === at || pointer.startsWith(`${at}/`),
    );
  },
});

const UNDECLARED: Schema = { holdsNoJudgedNull: true };

/** `schema` with every open object's undeclared fields held to `UNDECLARED`. */
const declaredOnly = (schema: unknown): unknown => {
  if (isUnknownArray(schema)) {
    return schema.map(declaredOnly);
  }
  if (!isRecord(schema)) {
    return schema;
  }
  const declared: Schema = Object.fromEntries(
    Object.entries(schema).map(([keyword, entry]) => [
      keyword,
      keyword === "properties" && isRecord(entry)
        ? Object.fromEntries(
            Object.entries(entry).map(([name, property]) => [
              name,
              declaredOnly(property),
            ]),
          )
        : declaredOnly(entry),
    ]),
  );
  if (isRecord(schema["properties"]) && !("additionalProperties" in schema)) {
    declared["additionalProperties"] = UNDECLARED;
  }
  return declared;
};

// Ajv compiles a schema once per object, so each case's schema is projected
// once.
const declaredOnlyOf = new WeakMap<Schema, Schema>();

/** Whether `schema` takes `data` with each null at `judged` in a declared place. */
const takesDeclared = (
  schema: Schema,
  data: unknown,
  judged: readonly Path[],
): boolean => {
  const projected = declaredOnlyOf.get(schema) ?? declaredOnly(schema);
  if (!isRecord(projected)) {
    throw new TypeError("The projected schema is not an object");
  }
  declaredOnlyOf.set(schema, projected);
  judgedNulls = new Set(judged.map(pointerOf));
  try {
    return ajv.validate(projected, data);
  } finally {
    judgedNulls = new Set();
  }
};

/** Where `sent` spells a field `value` leaves out as null. */
const spelledNullPaths = (
  value: unknown,
  sent: unknown,
  path: Path = [],
): Path[] => {
  if (isUnknownArray(value) && isUnknownArray(sent)) {
    return value.flatMap((entry, index) =>
      spelledNullPaths(entry, sent[index], [...path, index]),
    );
  }
  if (!isRecord(value) || !isRecord(sent)) {
    return [];
  }
  return Object.entries(sent).flatMap(([key, entry]) => {
    if (key in value) {
      return spelledNullPaths(value[key], entry, [...path, key]);
    }
    return entry === null ? [[...path, key]] : [];
  });
};

/** `value` with a null set at `path`. */
const withNullAt = (value: unknown, path: Path): unknown => {
  const [head, ...rest] = path;
  if (head === undefined) {
    return null;
  }
  if (isUnknownArray(value) && typeof head === "number") {
    return value.map((entry, index) =>
      index === head ? withNullAt(entry, rest) : entry,
    );
  }
  const record = isRecord(value) ? value : {};
  return { ...record, [head]: withNullAt(record[head], rest) };
};

/**
 * The input `sent` reads back as: `value`, plus each spelled null that a
 * branch declaring its field takes. Each null is judged on its own, as the
 * reader does, since sibling branches may each declare a different one.
 */
const expectedReading = (
  schema: Schema,
  value: unknown,
  sent: unknown,
): unknown => {
  let reading = value;
  for (const path of spelledNullPaths(value, sent)) {
    if (takesDeclared(schema, withNullAt(value, path), [path])) {
      reading = withNullAt(reading, path);
    }
  }
  return reading;
};

const hasUnion = (schema: Schema): boolean =>
  JSON.stringify(schema).includes('"anyOf"');

test(
  "widening optional fields to null and reading them back is the identity on declared inputs",
  () => {
    fc.assert(
      fc.property(caseArbitrary, ({ schema, spellings, value }) => {
        expect(ajv.validate(schema, value)).toBe(true);
        const widened = widenedSchema(schema);
        const nextSpelling = spellings[Symbol.iterator]();
        const sent = spellAbsentAsNull(
          schema,
          value,
          () => nextSpelling.next().value === true,
        );

        // A declared input passes through, and the widened schema still takes it.
        expect(withModelPlaceholdersOmitted(schema, value)).toEqual(value);
        expect(ajv.validate(widened, value)).toBe(true);
        // A required field stays as nullable as it was declared.
        expect(ajv.validate(widened, { root: null })).toBe(
          ajv.validate(schema, { root: null }),
        );
        // Whatever the widened schema declares the model may send reads back
        // as the declared input it stands for; one a union already declares
        // (a sibling branch declaring the field and taking null there) keeps
        // that null. An open sibling that merely tolerates an undeclared
        // field neither declares a spelling nor makes its null a value.
        if (takesDeclared(widened, sent, spelledNullPaths(value, sent))) {
          expect(withModelPlaceholdersOmitted(schema, sent)).toEqual(
            expectedReading(schema, value, sent),
          );
        }
        // Outside unions, where a branch may require what a sibling leaves
        // optional, every absent optional field may be spelled null.
        if (!hasUnion(schema)) {
          expect(ajv.validate(widened, sent)).toBe(true);
        }
      }),
      propertyConfig({ numRuns: 150, seed: propertySeed() }),
    );
  },
  propertyTestTimeout(30_000),
);

test("a spelled-out absent field is one the declared schema refuses", () => {
  // The fixture reaches the fault: without widening, the null is invalid.
  const schema = {
    type: "object",
    properties: { name: { type: "string" }, note: { type: "string" } },
    required: ["name"],
  };
  const sent = { name: "draft", note: null };
  expect(ajv.validate(schema, sent)).toBe(false);
  expect(ajv.validate(widenedSchema(schema), sent)).toBe(true);
  expect(withModelPlaceholdersOmitted(schema, sent)).toEqual({ name: "draft" });
});

// Schemas that declare nothing, a plain property, keys named after inherited
// members (parsed, so they are own), and every undeclared key. With no
// placeholder (`null`, "") in the input, the fold must return it unchanged.
const inheritedNamedProperties: unknown = JSON.parse(
  '{"__proto__":{"type":"object"},"constructor":{"type":"integer"}}',
);
const ownKeySchema = fc.constantFrom<unknown>(
  {},
  { type: "object", properties: { a: { type: "string", minLength: 1 } } },
  {
    type: "object",
    properties: inheritedNamedProperties,
    additionalProperties: { type: "integer" },
  },
  { type: "object", additionalProperties: {} },
);

const placeholderFreeValue = fc.oneof(
  fc.integer(),
  fc.string({ minLength: 1, maxLength: 3 }),
  ownKeyJsonObject({ nulls: false }),
);

test("withModelPlaceholdersOmitted keeps every own key as data", () => {
  assertProperty(
    "withModelPlaceholdersOmitted keeps every own key as data",
    fc.property(
      ownKeySchema,
      ownKeyJsonObject({ nulls: false }),
      (schema, value) => {
        const folded = withModelPlaceholdersOmitted(schema, value);
        expect(deepEquals(folded, value, true)).toBe(true);
        expect(prototypesIntact(folded)).toBe(true);
      },
    ),
  );
});

test("withModelPlaceholdersOmitted separates values that differ in one own key", () => {
  assertProperty(
    "withModelPlaceholdersOmitted separates values that differ in one own key",
    fc.property(
      ownKeySchema,
      ownKeyJsonObject({ nulls: false }),
      fc.nat(),
      fc.tuple(ownJsonKey, placeholderFreeValue),
      (schema, value, nodeIndex, entry) => {
        const extended = withOwnEntry({ entry, nodeIndex, value });
        expect(
          deepEquals(
            withModelPlaceholdersOmitted(schema, value),
            withModelPlaceholdersOmitted(schema, extended),
          ),
        ).toBe(false);
      },
    ),
  );
});
