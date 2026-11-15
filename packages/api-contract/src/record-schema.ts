import { panic } from "better-result";
import * as v from "valibot";

import { apiDateSchema } from "./api-date";

/**
 * Typed records a table cell can hold: the structured result of a data-source
 * tool call (a company register entry, a list of insolvency proceedings, an
 * exchange rate) or of an AI column that declares the shape of its answer
 * ("reference projects: client, value, currency, date").
 *
 * The schema language is deliberately small and flat. Every consumer derives
 * what it needs from one `RecordSchema`: the value validator below, the model's
 * structured-output schema, and the paths a projection column may read. Nothing
 * mirrors a schema by hand, so a field added to a tool's output reaches the
 * validator, the model and the projection picker together.
 */

export const RECORD_FIELD_TYPES = [
  "text",
  "date",
  "integer",
  "decimal",
  "boolean",
  "money",
  "url",
] as const;

export type RecordFieldType = (typeof RECORD_FIELD_TYPES)[number];

export const RECORD_CARDINALITIES = ["one", "many"] as const;

export type RecordCardinality = (typeof RECORD_CARDINALITIES)[number];

export const RECORD_LIMITS = {
  fields: 24,
  records: 200,
  keyLength: 40,
  labelLength: 80,
  descriptionLength: 300,
  textValueLength: 2000,
  urlLength: 2048,
} as const;

const recordFieldKeySchema = v.pipe(
  v.string(),
  v.regex(
    new RegExp(`^[a-z][A-Za-z0-9]{0,${RECORD_LIMITS.keyLength - 1}}$`, "u"),
    "A record field key is a camelCase identifier",
  ),
);

export const recordFieldSchema = v.strictObject({
  key: recordFieldKeySchema,
  label: v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(RECORD_LIMITS.labelLength),
  ),
  type: v.picklist(RECORD_FIELD_TYPES),
  nullable: v.boolean(),
  description: v.exactOptional(
    v.pipe(v.string(), v.maxLength(RECORD_LIMITS.descriptionLength)),
  ),
});

export type RecordField = v.InferOutput<typeof recordFieldSchema>;

export const recordSchemaSchema = v.pipe(
  v.strictObject({
    cardinality: v.picklist(RECORD_CARDINALITIES),
    fields: v.pipe(
      v.array(recordFieldSchema),
      v.minLength(1),
      v.maxLength(RECORD_LIMITS.fields),
    ),
  }),
  v.check(
    ({ fields }) =>
      new Set(fields.map(({ key }) => key)).size === fields.length,
    "Record field keys must be unique",
  ),
);

export type RecordSchema = v.InferOutput<typeof recordSchemaSchema>;

/** Checks that run only at parse; published schemas keep the plain shape. */
export const RECORD_SCHEMA_RUNTIME_ONLY_CHECKS = [
  recordSchemaSchema.pipe[1],
] as const;

/**
 * An exact decimal, written canonically: no leading zeros, no trailing
 * fractional zeros, no exponent, at most 18 integer and 12 fractional digits.
 * Exchange rates and percentages are decimals; a float would turn 25.345 into
 * 25.344999999999999 the moment anything compared or summed it.
 */
const CANONICAL_DECIMAL =
  /^(?:0|-?[1-9]\d{0,17}|-?(?:0|[1-9]\d{0,17})\.\d{0,11}[1-9])$/u;

export const isCanonicalDecimal = (value: string): boolean =>
  CANONICAL_DECIMAL.test(value);

const decimalValueSchema = v.pipe(
  v.string(),
  v.regex(CANONICAL_DECIMAL, "Expected a canonical decimal string"),
);

/** Same minor-unit rule as the money column: arithmetic stays exact. */
const moneyValueSchema = v.strictObject({
  amountMinor: v.pipe(v.number(), v.safeInteger()),
  currency: v.pipe(v.string(), v.regex(/^[A-Z]{3}$/u)),
});

export type RecordMoney = v.InferOutput<typeof moneyValueSchema>;

const RECORD_VALUE_SCHEMAS = {
  text: v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(RECORD_LIMITS.textValueLength),
  ),
  date: apiDateSchema,
  integer: v.pipe(v.number(), v.safeInteger()),
  decimal: decimalValueSchema,
  boolean: v.boolean(),
  money: moneyValueSchema,
  url: v.pipe(
    v.string(),
    v.maxLength(RECORD_LIMITS.urlLength),
    v.url(),
    v.regex(/^https:\/\//iu, "Expected an https URL"),
  ),
} as const satisfies Record<RecordFieldType, v.GenericSchema>;

export type RecordScalar = v.InferOutput<
  (typeof RECORD_VALUE_SCHEMAS)[RecordFieldType]
>;

/** One record: every declared key present, `null` only where nullable. */
export type RecordValue = Readonly<Record<string, RecordScalar | null>>;

type RecordValueSchema = v.GenericSchema<unknown, RecordValue>;

/** The validator for one field value, `null` admitted only where nullable. */
export const recordFieldValueSchema = (field: RecordField) => {
  const value = RECORD_VALUE_SCHEMAS[field.type];
  return field.nullable ? v.nullable(value) : value;
};

/**
 * The validator for one record of `schema`. Strict: an undeclared key is an
 * error, never silently kept, so a stored record holds exactly its schema.
 */
export const recordValueSchema = (schema: RecordSchema): RecordValueSchema =>
  v.strictObject(
    Object.fromEntries(
      schema.fields.map((field) => [field.key, recordFieldValueSchema(field)]),
    ),
  );

/** The validator for a record set: one record, or a bounded list of them. */
export const recordSetSchema = (
  schema: RecordSchema,
): v.GenericSchema<unknown, RecordValue | readonly RecordValue[]> => {
  const one = recordValueSchema(schema);
  switch (schema.cardinality) {
    case "one":
      return one;
    case "many":
      return v.pipe(v.array(one), v.maxLength(RECORD_LIMITS.records));
    default:
      schema.cardinality satisfies never;
      return panic("Unknown record cardinality");
  }
};
