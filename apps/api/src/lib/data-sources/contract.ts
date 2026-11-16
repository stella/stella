import type { Result } from "better-result";
import { panic, TaggedError } from "better-result";

import type { RecordInputIssue } from "@stll/api-contract/record-cell";
import type {
  RecordSchema,
  RecordValue,
} from "@stll/api-contract/record-schema";
import type { RegistryRequestObservation } from "@stll/business-registries/shared/request-observer";
import { declareFingerprintFields } from "@stll/errors";
import type { Temporal } from "@stll/time";

import type { ThirdPartyOutboundPermit } from "@/api/lib/auth/third-party-outbound-permit";

/**
 * A data-source tool: a deterministic lookup a table column can call once a
 * model has filled its input from a row's documents. Company registers are one
 * family; an exchange rate, a medicine register entry or a land parcel is the
 * same contract. Nothing here knows what a company is.
 *
 * A tool declares its input and output as `RecordSchema`s, so the model's
 * argument schema, the input validator, the stored record's validator and the
 * paths a projection column may read all derive from the declaration.
 */

const DATA_SOURCE_UNAVAILABLE_REASONS = [
  "timeout",
  "network",
  "source-error",
  "malformed-response",
] as const;

export type DataSourceUnavailableReason =
  (typeof DATA_SOURCE_UNAVAILABLE_REASONS)[number];

/** The source did not answer; the cell takes the workflow's retryable error. */
export class DataSourceUnavailableError extends TaggedError(
  "DataSourceUnavailableError",
)<{
  message: string;
  toolId: string;
  reason: DataSourceUnavailableReason;
  cause?: unknown;
}> {
  static {
    declareFingerprintFields(this, ["reason"]);
  }
}

/** A text input value; the input was checked against the tool's schema. */
export const textInput = (input: RecordValue, key: string): string => {
  const value = input[key];
  return typeof value === "string"
    ? value
    : panic(`Data-source input ${key} is not text`);
};

export type DataSourceCallContext = {
  permit: ThirdPartyOutboundPermit;
  observer: RegistryRequestObservation;
  signal: AbortSignal;
};

/**
 * What a source answered. `records` is the fact the source holds: exactly one
 * record for a `one` tool, any number (zero included) for a `many` tool, at
 * least one candidate for a `candidates` tool. `url` is the address the record
 * can be checked at; `sourceDataAsOf` the source's own freshness stamp.
 */
export type DataSourceAnswer =
  | {
      type: "records";
      records: readonly RecordValue[];
      url: string;
      sourceDataAsOf?: string;
    }
  | { type: "not-found"; url: string; sourceDataAsOf?: string };

export type DataSourceInputCheck = Result<
  RecordValue,
  readonly [RecordInputIssue, ...RecordInputIssue[]]
>;

export type DataSourceTool = {
  /** Stable, dotted, lower-case: `<country or scope>.<source>.<operation>`. */
  id: string;
  /** What the tool returns, for the model and for the column picker. */
  description: string;
  input: RecordSchema & { cardinality: "one" };
  /**
   * Checks after the schema: checksums, plausible ranges, dates not in the
   * future. Returns the normalized input (an IČO compacted and padded) or the
   * issues that keep the source from being called. Deterministic: the clock
   * is passed in.
   */
  checkInput: (
    input: RecordValue,
    today: Temporal.PlainDate,
  ) => DataSourceInputCheck;
  output: {
    schema: RecordSchema;
    /**
     * Bumped whenever `schema` changes. A stored record of another version
     * is stale: projections refuse it and the next run recomputes it.
     */
    version: number;
  };
  /**
   * `exact`: the input identifies the answer (an IČO, a currency and a date).
   * `candidates`: the source searched, and a person picks among the results.
   */
  match: "exact" | "candidates";
  /** How long a stored answer for the same input is reused without a call. */
  cacheTtl: { hours: number };
  call: (
    input: RecordValue,
    context: DataSourceCallContext,
  ) => Promise<Result<DataSourceAnswer, DataSourceUnavailableError>>;
};
