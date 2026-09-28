import { Ajv } from "ajv";
import { expect, test } from "bun:test";
import fc from "fast-check";

import { propertyConfig, propertyTestTimeout } from "@stll/property-testing";

import {
  withModelPlaceholdersOmitted,
  withOptionalsNullable,
} from "@/api/lib/json-schema/null-optionals";
import { isRecord, isUnknownArray } from "@/api/lib/type-guards";

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

const NOT_NULL: Schema = { not: { type: "null" } };

/**
 * `schema` with every open object refusing a null in a field it does not
 * declare. An open union branch takes any extra field, a null included,
 * without declaring it; only a branch that declares the field and takes null
 * there makes a null a value rather than a spelling of "not set".
 */
const undeclaredNullsRefused = (schema: unknown): unknown => {
  if (isUnknownArray(schema)) {
    return schema.map(undeclaredNullsRefused);
  }
  if (!isRecord(schema)) {
    return schema;
  }
  const refusing: Schema = Object.fromEntries(
    Object.entries(schema).map(([keyword, entry]) => [
      keyword,
      keyword === "properties" && isRecord(entry)
        ? Object.fromEntries(
            Object.entries(entry).map(([name, property]) => [
              name,
              undeclaredNullsRefused(property),
            ]),
          )
        : undeclaredNullsRefused(entry),
    ]),
  );
  if (isRecord(schema["properties"]) && !("additionalProperties" in schema)) {
    refusing["additionalProperties"] = NOT_NULL;
  }
  return refusing;
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
        // Whatever the widened schema lets the model send reads back as the
        // declared input it stands for; one a union already declares (a
        // sibling branch declaring the field and taking null there) is read
        // as itself. An open sibling that merely tolerates an undeclared
        // field does not make its null a value.
        if (ajv.validate(widened, sent)) {
          expect(withModelPlaceholdersOmitted(schema, sent)).toEqual(
            ajv.validate(undeclaredNullsRefused(schema), sent) ? sent : value,
          );
        }
        // Outside unions, where a branch may require what a sibling leaves
        // optional, every absent optional field may be spelled null.
        if (!hasUnion(schema)) {
          expect(ajv.validate(widened, sent)).toBe(true);
        }
      }),
      propertyConfig({ numRuns: 150 }),
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
