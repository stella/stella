import { panic } from "better-result";
import * as v from "valibot";

import { apiDateTimeSchema } from "./api-date";
import { RECORD_LIMITS } from "./record-schema";

/**
 * What a `record` cell stores. The record values are checked against the
 * column's `RecordSchema` when they are written (the cell schema alone does not
 * know the column); here they are only held to the scalar shapes a record may
 * contain.
 */

const SHA256_HEX = /^[0-9a-f]{64}$/u;

/**
 * Where a tool record came from. `sha256` is the SHA-256 of the canonical JSON
 * (sorted keys) of the normalized source payload the record was built from, so
 * the stored record can be checked against it without the original response.
 * `sourceDataAsOf` is the source's own freshness stamp when it publishes one
 * (a register's last synchronisation, a rate's effective date).
 */
export const recordProvenanceSchema = v.strictObject({
  url: v.pipe(v.string(), v.url(), v.maxLength(RECORD_LIMITS.urlLength)),
  retrievedAt: apiDateTimeSchema,
  sha256: v.pipe(v.string(), v.regex(SHA256_HEX)),
  sourceDataAsOf: v.exactOptional(v.pipe(v.string(), v.maxLength(64))),
});

export type RecordProvenance = v.InferOutput<typeof recordProvenanceSchema>;

const recordScalarShapeSchema = v.union([
  v.pipe(v.string(), v.maxLength(RECORD_LIMITS.textValueLength)),
  v.number(),
  v.boolean(),
  v.strictObject({
    amountMinor: v.pipe(v.number(), v.safeInteger()),
    currency: v.pipe(v.string(), v.regex(/^[A-Z]{3}$/u)),
  }),
  v.null(),
]);

const storedRecordSchema = v.pipe(
  v.record(
    v.pipe(v.string(), v.maxLength(RECORD_LIMITS.keyLength)),
    recordScalarShapeSchema,
  ),
  v.check(
    (record) => Object.keys(record).length <= RECORD_LIMITS.fields,
    "Too many record fields",
  ),
);

const storedRecordListSchema = v.pipe(
  v.array(storedRecordSchema),
  v.maxLength(RECORD_LIMITS.records),
);

const selectedIndexSchema = v.nullable(
  v.pipe(v.number(), v.integer(), v.minValue(0)),
);

/**
 * `many`: the list is the fact (every proceeding a register holds); a
 * selection is optional and only narrows what a projection reads.
 * `candidates`: search results, ambiguous until a person selects one. Nothing
 * ever selects a candidate automatically, not even the only one.
 */
export const recordResultSchema = v.pipe(
  v.variant("kind", [
    v.strictObject({ kind: v.literal("one"), record: storedRecordSchema }),
    v.strictObject({
      kind: v.literal("many"),
      records: storedRecordListSchema,
      selected: selectedIndexSchema,
    }),
    v.strictObject({
      kind: v.literal("candidates"),
      records: v.pipe(storedRecordListSchema, v.minLength(1)),
      selected: selectedIndexSchema,
    }),
  ]),
  v.check(
    (result) =>
      result.kind === "one" ||
      result.selected === null ||
      result.selected < result.records.length,
    "The selected record does not exist",
  ),
);

/** Checks that run only at parse; published schemas keep the plain shape. */
export const RECORD_CELL_RUNTIME_ONLY_CHECKS = [
  storedRecordSchema.pipe[1],
  recordResultSchema.pipe[1],
] as const;

export type RecordResult = v.InferOutput<typeof recordResultSchema>;

/** The tool input as validated (or as filled, when validation refused it). */
const recordInputSchema = storedRecordSchema;

export const RECORD_INPUT_ISSUE_CODES = [
  "missing",
  "invalid",
  "uncertain",
] as const;

const recordInputIssueSchema = v.strictObject({
  key: v.pipe(v.string(), v.maxLength(RECORD_LIMITS.keyLength)),
  code: v.picklist(RECORD_INPUT_ISSUE_CODES),
  message: v.pipe(v.string(), v.maxLength(RECORD_LIMITS.descriptionLength)),
});

export type RecordInputIssue = v.InferOutput<typeof recordInputIssueSchema>;

/**
 * A source that fails (timeout, outage, malformed answer) leaves the cell in
 * the workflow's ordinary `error` state with its retry, not in a record state:
 * there is no fact to store.
 */
export const recordCellStateSchema = v.variant("status", [
  // The tool's validator refused the filled input: nothing was called and
  // nothing was guessed. A person corrects the source or the input.
  v.strictObject({
    status: v.literal("input-needs-review"),
    input: recordInputSchema,
    issues: v.pipe(
      v.array(recordInputIssueSchema),
      v.minLength(1),
      v.maxLength(RECORD_LIMITS.fields),
    ),
  }),
  v.strictObject({
    status: v.literal("not-found"),
    input: recordInputSchema,
    provenance: recordProvenanceSchema,
  }),
  // A tool record carries its input and provenance; an AI record carries
  // neither (its citations are the cell's justification).
  v.strictObject({
    status: v.literal("resolved"),
    input: v.exactOptional(recordInputSchema),
    provenance: v.exactOptional(recordProvenanceSchema),
    result: recordResultSchema,
  }),
]);

export type RecordCellState = v.InferOutput<typeof recordCellStateSchema>;

type StoredRecord = Extract<RecordResult, { kind: "one" }>["record"];

/** Renders a money value; minor units are not a readable amount. */
export type RecordMoneyText = (money: {
  amountMinor: number;
  currency: string;
}) => string;

const recordText = (
  record: StoredRecord,
  formatMoney: RecordMoneyText,
): string =>
  Object.values(record)
    .flatMap((value) => {
      if (value === null) {
        return [];
      }
      return [typeof value === "object" ? formatMoney(value) : String(value)];
    })
    .join("; ");

/**
 * The plain text of a record cell, for search and flat exports: the values of
 * every record a reader would take as the cell's answer. An unselected
 * candidate list has no answer yet, so it has no text.
 */
export const recordCellText = (
  state: RecordCellState,
  formatMoney: RecordMoneyText,
): string => {
  switch (state.status) {
    case "input-needs-review":
    case "not-found":
      return "";
    case "resolved":
      break;
    default:
      state satisfies never;
      return panic("Unknown record cell status");
  }
  const { result } = state;
  switch (result.kind) {
    case "one":
      return recordText(result.record, formatMoney);
    case "many":
      return result.records
        .map((record) => recordText(record, formatMoney))
        .join(" | ");
    case "candidates": {
      const selected =
        result.selected === null
          ? undefined
          : result.records.at(result.selected);
      return selected === undefined ? "" : recordText(selected, formatMoney);
    }
    default:
      result satisfies never;
      return panic("Unknown record result kind");
  }
};
