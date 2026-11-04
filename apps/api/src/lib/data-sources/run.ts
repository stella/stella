import { panic, Result } from "better-result";
import * as v from "valibot";

import type {
  RecordCellState,
  RecordInputIssue,
  RecordProvenance,
} from "@stll/api-contract/record-cell";
import {
  recordFieldValueSchema,
  recordValueSchema,
} from "@stll/api-contract/record-schema";
import type { RecordValue } from "@stll/api-contract/record-schema";
import { sha256Hex } from "@stll/sha256/bun";
import { stableStringify } from "@stll/stable-stringify";
import { Temporal } from "@stll/time";

import type {
  DataSourceAnswer,
  DataSourceCallContext,
  DataSourceTool,
} from "@/api/lib/data-sources/contract";
import { DataSourceUnavailableError } from "@/api/lib/data-sources/contract";

/**
 * The three stages after a model has filled a tool's input: the schema and the
 * tool's own checks, then the call, then the typed record. Refused input never
 * reaches the source and is never repaired by a guess; it becomes a cell a
 * person reviews.
 */

/** What the model filled: one value per input key, and the keys it doubted. */
export type FilledToolInput = {
  values: Readonly<Record<string, unknown>>;
  uncertainKeys: readonly string[];
};

export type ToolRecordCell = {
  schemaVersion: number;
  state: RecordCellState;
};

/** Keeps only what a stored input may hold, so a refused input stays storable. */
const storableInput = (
  tool: DataSourceTool,
  values: FilledToolInput["values"],
): RecordValue =>
  Object.fromEntries(
    tool.input.fields.flatMap((field) => {
      const parsed = v.safeParse(
        v.nullable(recordFieldValueSchema({ ...field, nullable: true })),
        values[field.key] ?? null,
      );
      return [[field.key, parsed.success ? parsed.output : null]];
    }),
  );

type CheckedInput = Result<RecordValue, readonly RecordInputIssue[]>;

const checkFilledInput = (
  tool: DataSourceTool,
  filled: FilledToolInput,
  today: Temporal.PlainDate,
): CheckedInput => {
  const issues: RecordInputIssue[] = [];
  for (const field of tool.input.fields) {
    const value = filled.values[field.key] ?? null;
    if (value === null) {
      if (!field.nullable) {
        issues.push({
          key: field.key,
          code: "missing",
          message: `${field.label} is not stated in the documents`,
        });
      }
      continue;
    }
    if (!v.is(recordFieldValueSchema(field), value)) {
      issues.push({
        key: field.key,
        code: "invalid",
        message: `${field.label} is not a valid ${field.type}`,
      });
    }
  }
  for (const key of new Set(filled.uncertainKeys)) {
    const field = tool.input.fields.find((candidate) => candidate.key === key);
    if (field !== undefined) {
      issues.push({
        key,
        code: "uncertain",
        message: `${field.label} could not be read with certainty`,
      });
    }
  }
  if (issues.length > 0) {
    return Result.err(issues);
  }
  const complete = Object.fromEntries(
    tool.input.fields.map(({ key }) => [key, filled.values[key] ?? null]),
  );
  const typed = v.safeParse(recordValueSchema(tool.input), complete);
  if (!typed.success) {
    return panic(`Field checks admitted an input ${tool.id} refuses`);
  }
  const checked = tool.checkInput(typed.output, today);
  return checked.isOk() ? Result.ok(checked.value) : Result.err(checked.error);
};

const unavailable = (
  tool: DataSourceTool,
  message: string,
): Result<never, DataSourceUnavailableError> =>
  Result.err(
    new DataSourceUnavailableError({
      message,
      toolId: tool.id,
      reason: "malformed-response",
    }),
  );

/**
 * The provenance of an answer. The hash covers the canonical JSON of the
 * normalized records (or of the empty answer), so it can be recomputed from
 * the stored cell without the original response.
 */
const provenanceOf = (
  answer: DataSourceAnswer,
  retrievedAt: Temporal.Instant,
): RecordProvenance => ({
  url: answer.url,
  retrievedAt: retrievedAt.toString(),
  sha256: sha256Hex(
    stableStringify(answer.type === "records" ? answer.records : null),
  ),
  ...(answer.sourceDataAsOf === undefined
    ? {}
    : { sourceDataAsOf: answer.sourceDataAsOf }),
});

const resultOf = (
  tool: DataSourceTool,
  records: readonly RecordValue[],
): Result<
  Extract<RecordCellState, { status: "resolved" }>["result"],
  DataSourceUnavailableError
> => {
  const one = recordValueSchema(tool.output.schema);
  if (!records.every((record) => v.is(one, record))) {
    return unavailable(tool, `${tool.id} answered outside its output schema`);
  }
  // A search answers candidates. None is chosen here, not even a lone one:
  // a person confirms which result the row means.
  if (tool.match === "candidates") {
    return Result.ok({
      kind: "candidates",
      records: [...records],
      selected: null,
    });
  }
  switch (tool.output.schema.cardinality) {
    case "one": {
      const [record, ...rest] = records;
      return record === undefined || rest.length > 0
        ? unavailable(
            tool,
            `${tool.id} answered ${records.length} records for one`,
          )
        : Result.ok({ kind: "one", record });
    }
    case "many":
      return Result.ok({ kind: "many", records: [...records], selected: null });
    default:
      tool.output.schema.cardinality satisfies never;
      return panic("Unknown record cardinality");
  }
};

export type RunDataSourceToolOptions = {
  tool: DataSourceTool;
  filled: FilledToolInput;
  context: DataSourceCallContext;
  now: Temporal.Instant;
  timeZone: string;
};

/**
 * Validate, call, record. A refused input is a value (a cell to review), a
 * source that does not answer is an error (the cell's retryable failure).
 */
export const runDataSourceTool = async ({
  tool,
  filled,
  context,
  now,
  timeZone,
}: RunDataSourceToolOptions): Promise<
  Result<ToolRecordCell, DataSourceUnavailableError>
> => {
  const schemaVersion = tool.output.version;
  const today = now.toZonedDateTimeISO(timeZone).toPlainDate();
  const checked = checkFilledInput(tool, filled, today);
  if (checked.isErr()) {
    const [first, ...rest] = checked.error;
    return Result.ok({
      schemaVersion,
      state: {
        status: "input-needs-review",
        input: storableInput(tool, filled.values),
        issues:
          first === undefined ? panic("No input issue") : [first, ...rest],
      },
    });
  }
  const input = checked.value;
  const answer = await tool.call(input, context);
  if (answer.isErr()) {
    return Result.err(answer.error);
  }
  const provenance = provenanceOf(answer.value, now);
  if (answer.value.type === "not-found") {
    return Result.ok({
      schemaVersion,
      state: { status: "not-found", input, provenance },
    });
  }
  const result = resultOf(tool, answer.value.records);
  if (result.isErr()) {
    return Result.err(result.error);
  }
  return Result.ok({
    schemaVersion,
    state: { status: "resolved", input, provenance, result: result.value },
  });
};

type ReusableRecordOptions = {
  tool: DataSourceTool;
  stored: ToolRecordCell;
  input: RecordValue;
  now: Temporal.Instant;
};

/**
 * Whether a stored answer can stand in for a new call: same tool version, same
 * normalized input, retrieved within the tool's cache window. Only answers are
 * reused; a refused input is checked again on every run.
 */
export const isReusableRecord = ({
  tool,
  stored,
  input,
  now,
}: ReusableRecordOptions): boolean => {
  if (stored.schemaVersion !== tool.output.version) {
    return false;
  }
  const { state } = stored;
  switch (state.status) {
    case "input-needs-review":
      return false;
    case "not-found":
    case "resolved": {
      if (
        state.input === undefined ||
        state.provenance === undefined ||
        stableStringify(state.input) !== stableStringify(input)
      ) {
        return false;
      }
      const expiresAt = Temporal.Instant.from(state.provenance.retrievedAt).add(
        tool.cacheTtl,
      );
      return Temporal.Instant.compare(now, expiresAt) < 0;
    }
    default:
      state satisfies never;
      return panic("Unknown record cell status");
  }
};
