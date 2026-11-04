import { panic } from "better-result";
import * as v from "valibot";

import type { RecordCellState } from "./record-cell";
import {
  isCanonicalDecimal,
  RECORD_LIMITS,
  recordFieldValueSchema,
} from "./record-schema";
import type {
  RecordField,
  RecordFieldType,
  RecordMoney,
  RecordScalar,
  RecordSchema,
} from "./record-schema";

/**
 * A projection column reads one value out of a record column and casts it to
 * an ordinary column type, so verdicts, calculations, filters and exports work
 * on it unchanged. It is deterministic: no model is involved.
 */

export const RECORD_PROJECTION_TARGETS = [
  "text",
  "single-select",
  "date",
  "int",
  "money",
] as const;

export type RecordProjectionTarget = (typeof RECORD_PROJECTION_TARGETS)[number];

/** Which column types each record field type may be projected into. */
export const RECORD_PROJECTION_CASTS = {
  text: ["text", "single-select"],
  url: ["text"],
  date: ["date", "text"],
  integer: ["int", "text"],
  decimal: ["text", "int"],
  boolean: ["single-select", "text"],
  money: ["money"],
} as const satisfies Record<RecordFieldType, readonly RecordProjectionTarget[]>;

export const recordProjectionSelectSchema = v.variant("kind", [
  v.strictObject({
    kind: v.literal("field"),
    key: v.pipe(
      v.string(),
      v.minLength(1),
      v.maxLength(RECORD_LIMITS.keyLength),
    ),
  }),
  // How many records a `many` or `candidates` result holds.
  v.strictObject({ kind: v.literal("count") }),
]);

export type RecordProjectionSelect = v.InferOutput<
  typeof recordProjectionSelectSchema
>;

type ProjectionCompatibility =
  | { type: "compatible" }
  | { type: "incompatible"; reason: "unknown-field" | "cast" | "count-on-one" };

/** Whether `select` can be cast to `target` for records of `schema`. */
export const recordProjectionCompatibility = (
  schema: RecordSchema,
  select: RecordProjectionSelect,
  target: RecordProjectionTarget,
): ProjectionCompatibility => {
  switch (select.kind) {
    case "count":
      if (schema.cardinality === "one") {
        return { type: "incompatible", reason: "count-on-one" };
      }
      return target === "int"
        ? { type: "compatible" }
        : { type: "incompatible", reason: "cast" };
    case "field": {
      const field = schema.fields.find(({ key }) => key === select.key);
      if (field === undefined) {
        return { type: "incompatible", reason: "unknown-field" };
      }
      const casts: readonly RecordProjectionTarget[] =
        RECORD_PROJECTION_CASTS[field.type];
      return casts.includes(target)
        ? { type: "compatible" }
        : { type: "incompatible", reason: "cast" };
    }
    default:
      select satisfies never;
      return panic("Unknown record projection select");
  }
};

/** A projected value, one branch per target column type. */
export type ProjectedValue =
  | { type: "text"; value: string }
  | { type: "single-select"; value: string }
  | { type: "date"; value: string }
  | { type: "int"; value: number }
  | { type: "money"; amountCents: number; currency: string };

export const RECORD_PROJECTION_REVIEW_REASONS = [
  // A candidate list nobody has chosen from, or a list read by field with no
  // record selected: reading the first entry would be a guess.
  "selection-required",
  // The record was written under an older output schema of its source.
  "stale-schema",
  // The tool refused its input; there is no record yet.
  "input-needs-review",
  // A decimal with a fraction cannot become an int without rounding.
  "not-integral",
  // A select column whose options do not contain the value.
  "no-matching-option",
] as const;

export type RecordProjectionReviewReason =
  (typeof RECORD_PROJECTION_REVIEW_REASONS)[number];

export type RecordProjectionOutcome =
  | { type: "value"; value: ProjectedValue }
  | { type: "empty" }
  | { type: "needs-review"; reason: RecordProjectionReviewReason };

export type ProjectRecordOptions = {
  state: RecordCellState;
  /** The schema version the stored record was written under. */
  storedSchemaVersion: number;
  schema: RecordSchema;
  schemaVersion: number;
  select: RecordProjectionSelect;
  target: RecordProjectionTarget;
  /** Option values of a single-select target; unused for other targets. */
  selectOptions: readonly string[];
};

type RecordToRead =
  | { type: "record"; record: Readonly<Record<string, unknown>> }
  | { type: "unselected" };

const recordToRead = (
  result: Extract<RecordCellState, { status: "resolved" }>["result"],
): RecordToRead => {
  switch (result.kind) {
    case "one":
      return { type: "record", record: result.record };
    case "many":
    case "candidates": {
      const record =
        result.selected === null
          ? undefined
          : result.records.at(result.selected);
      return record === undefined
        ? { type: "unselected" }
        : { type: "record", record };
    }
    default:
      result satisfies never;
      return panic("Unknown record result kind");
  }
};

const isMoney = (value: unknown): value is RecordMoney =>
  typeof value === "object" &&
  value !== null &&
  "amountMinor" in value &&
  "currency" in value &&
  typeof value.amountMinor === "number" &&
  typeof value.currency === "string";

const castScalar = (
  field: RecordField,
  value: RecordScalar,
  options: Pick<ProjectRecordOptions, "target" | "selectOptions">,
): RecordProjectionOutcome => {
  const { target, selectOptions } = options;
  const text = (): RecordProjectionOutcome => {
    if (typeof value === "string") {
      return { type: "value", value: { type: "text", value } };
    }
    if (typeof value === "number" || typeof value === "boolean") {
      return { type: "value", value: { type: "text", value: String(value) } };
    }
    return panic(`A ${field.type} record value cannot be shown as text`);
  };
  switch (target) {
    case "text":
      return text();
    case "single-select": {
      if (typeof value !== "string" && typeof value !== "boolean") {
        return panic(`A ${field.type} record value cannot become an option`);
      }
      const option = String(value);
      return selectOptions.includes(option)
        ? { type: "value", value: { type: "single-select", value: option } }
        : { type: "needs-review", reason: "no-matching-option" };
    }
    case "date":
      return typeof value === "string"
        ? { type: "value", value: { type: "date", value } }
        : panic("A date record value is a string");
    case "int": {
      if (typeof value === "number") {
        return { type: "value", value: { type: "int", value } };
      }
      if (typeof value === "string" && isCanonicalDecimal(value)) {
        return value.includes(".")
          ? { type: "needs-review", reason: "not-integral" }
          : { type: "value", value: { type: "int", value: Number(value) } };
      }
      return panic(`A ${field.type} record value cannot become an int`);
    }
    case "money":
      return isMoney(value)
        ? {
            type: "value",
            value: {
              type: "money",
              amountCents: value.amountMinor,
              currency: value.currency,
            },
          }
        : panic("A money record value has an amount and a currency");
    default:
      target satisfies never;
      return panic("Unknown record projection target");
  }
};

/**
 * Read one value out of a record cell. Never picks among candidates, never
 * reads a record written under another schema version, never rounds.
 */
export const projectRecord = ({
  state,
  storedSchemaVersion,
  schema,
  schemaVersion,
  select,
  target,
  selectOptions,
}: ProjectRecordOptions): RecordProjectionOutcome => {
  if (storedSchemaVersion !== schemaVersion) {
    return { type: "needs-review", reason: "stale-schema" };
  }
  switch (state.status) {
    case "input-needs-review":
      return { type: "needs-review", reason: "input-needs-review" };
    case "not-found":
      return { type: "empty" };
    case "resolved":
      break;
    default:
      state satisfies never;
      return panic("Unknown record cell status");
  }
  const { result } = state;
  if (result.kind === "candidates" && result.selected === null) {
    return { type: "needs-review", reason: "selection-required" };
  }
  switch (select.kind) {
    case "count":
      return result.kind === "one"
        ? panic("A count projection reads a list")
        : {
            type: "value",
            value: { type: "int", value: result.records.length },
          };
    case "field": {
      const field =
        schema.fields.find(({ key }) => key === select.key) ??
        panic(`Record field ${select.key} is not in the schema`);
      const read = recordToRead(result);
      if (read.type === "unselected") {
        return { type: "needs-review", reason: "selection-required" };
      }
      // Values are checked against the schema when written; one that no
      // longer parses was written under a shape this version does not have.
      const parsed = v.safeParse(
        recordFieldValueSchema(field),
        read.record[select.key],
      );
      if (!parsed.success) {
        return { type: "needs-review", reason: "stale-schema" };
      }
      return parsed.output === null
        ? { type: "empty" }
        : castScalar(field, parsed.output, { target, selectOptions });
    }
    default:
      select satisfies never;
      return panic("Unknown record projection select");
  }
};
