import { panic, Result, TaggedError } from "better-result";
import { Temporal } from "temporal-polyfill/full";

import { validate as validateCzIco } from "@stll/stdnum/cz/ico";

import { checkCzInsolvency, CZ_INSOLVENCY_SOURCE } from "./cz-insolvency.js";
import type { CzInsolvencyFinding } from "./cz-insolvency.js";
import { nowInstant } from "./result.js";
import type {
  EntityCheckCancelledError,
  EntityCheckOutcome,
  EntityCheckSource,
  EntityCheckSourceError,
  EntityCheckSubject,
  EntityCheckSubjectType,
  SourceAnswer,
} from "./result.js";

export const ENTITY_CHECK_KINDS = ["cz-insolvency"] as const;

export type EntityCheckKind = (typeof ENTITY_CHECK_KINDS)[number];

type EntityCheckFindings = {
  "cz-insolvency": CzInsolvencyFinding;
};

export type EntityCheckResultOf<TKind extends EntityCheckKind> =
  EntityCheckOutcome<TKind, EntityCheckFindings[TKind]>;

export type EntityCheckResult = {
  [TKind in EntityCheckKind]: EntityCheckResultOf<TKind>;
}[EntityCheckKind];

type EntityCheckDescriptor = {
  country: "CZ";
  source: EntityCheckSource;
  subjectTypes: readonly [EntityCheckSubjectType, ...EntityCheckSubjectType[]];
};

export const ENTITY_CHECKS = {
  "cz-insolvency": {
    country: "CZ",
    source: CZ_INSOLVENCY_SOURCE,
    subjectTypes: ["company-id", "person"],
  },
} as const satisfies Record<EntityCheckKind, EntityCheckDescriptor>;

/** Rejected before any request: the subject cannot be sent to the source. */
export class EntityCheckInputError extends TaggedError(
  "EntityCheckInputError",
)<{ message: string }> {}

type InputResult<T> = Result<T, EntityCheckInputError>;

const invalidInput = (message: string) =>
  Result.err(new EntityCheckInputError({ message }));

// The insolvency service rejects name fragments shorter than two characters.
const MIN_NAME_LENGTH = 2;
const MAX_NAME_LENGTH = 100;

const normalizeName = (value: string, label: string): InputResult<string> => {
  const collapsed = value.trim().replaceAll(/\s+/gu, " ");
  return collapsed.length < MIN_NAME_LENGTH ||
    collapsed.length > MAX_NAME_LENGTH
    ? invalidInput(
        `${label} must be ${MIN_NAME_LENGTH} to ${MAX_NAME_LENGTH} characters`,
      )
    : Result.ok(collapsed);
};

const normalizeBirthDate = (value: string): InputResult<string> => {
  const parsed = /^\d{4}-\d{2}-\d{2}$/u.test(value)
    ? Result.try(() =>
        Temporal.PlainDate.from(value, { overflow: "reject" }),
      ).unwrapOr(null)
    : null;
  if (parsed === null) {
    return invalidInput("Birth date must be an ISO date (YYYY-MM-DD)");
  }
  if (Temporal.PlainDate.compare(parsed, Temporal.Now.plainDateISO()) > 0) {
    return invalidInput("Birth date cannot be in the future");
  }
  return Result.ok(parsed.toString());
};

const normalizeCompanyId = (
  country: EntityCheckDescriptor["country"],
  value: string,
): InputResult<string> => {
  switch (country) {
    case "CZ": {
      const result = validateCzIco(value);
      return result.valid
        ? Result.ok(result.compact)
        : invalidInput("Company ID must be a valid Czech IČO (8 digits)");
    }
    default: {
      country satisfies never;
      return panic("Unhandled country");
    }
  }
};

const normalizeSubject = (
  country: EntityCheckDescriptor["country"],
  subject: EntityCheckSubject,
): InputResult<EntityCheckSubject> =>
  Result.gen(function* () {
    switch (subject.type) {
      case "company-id": {
        return Result.ok({
          type: "company-id",
          value: yield* normalizeCompanyId(country, subject.value),
        } as const);
      }
      case "person": {
        return Result.ok({
          type: "person",
          firstName: yield* normalizeName(subject.firstName, "First name"),
          lastName: yield* normalizeName(subject.lastName, "Last name"),
          birthDate: yield* normalizeBirthDate(subject.birthDate),
        } as const);
      }
      default: {
        subject satisfies never;
        return panic("Unhandled subject");
      }
    }
  });

export type EntityCheckError =
  | EntityCheckInputError
  | EntityCheckCancelledError;

type SettleOptions<TKind extends EntityCheckKind, TFinding> = {
  kind: TKind;
  subject: EntityCheckSubject;
  signal: AbortSignal | undefined;
  query: (
    subject: EntityCheckSubject,
    signal: AbortSignal | undefined,
  ) => Promise<Result<SourceAnswer<TFinding>, EntityCheckSourceError>>;
};

// The single place a source answer becomes an outcome. `clear` is reachable
// only from a source client's explicit clear answer; every source error is
// `unavailable`.
const settle = async <TKind extends EntityCheckKind, TFinding>({
  kind,
  subject,
  signal,
  query,
}: SettleOptions<TKind, TFinding>): Promise<
  Result<EntityCheckOutcome<TKind, TFinding>, EntityCheckError>
> => {
  const { country, source, subjectTypes } = ENTITY_CHECKS[kind];
  if (!subjectTypes.some((type) => type === subject.type)) {
    return Result.ok({
      status: "not-covered",
      kind,
      source,
      subject,
      reason: "subject-type-not-supported",
      supportedSubjectTypes: [...subjectTypes],
    } satisfies EntityCheckOutcome<TKind, TFinding>);
  }
  const normalized = normalizeSubject(country, subject);
  if (normalized.isErr()) {
    return Result.err(normalized.error);
  }
  const checkedAt = nowInstant();
  const answer = await query(normalized.value, signal);
  if (answer.isErr()) {
    const error = answer.error;
    switch (error._tag) {
      case "EntityCheckCancelledError": {
        return Result.err(error);
      }
      case "EntityCheckUnavailableError": {
        return Result.ok({
          status: "unavailable",
          kind,
          source,
          subject: normalized.value,
          checkedAt,
          reason: error.reason,
          detail: error.detail,
        } satisfies EntityCheckOutcome<TKind, TFinding>);
      }
      default: {
        error satisfies never;
        return panic("Unhandled error");
      }
    }
  }
  const value = answer.value;
  switch (value.type) {
    case "clear": {
      return Result.ok({
        status: "clear",
        kind,
        source,
        subject: normalized.value,
        checkedAt,
        sourceDataAsOf: value.sourceDataAsOf,
      } satisfies EntityCheckOutcome<TKind, TFinding>);
    }
    case "found": {
      return Result.ok({
        status: "found",
        kind,
        source,
        subject: normalized.value,
        checkedAt,
        sourceDataAsOf: value.sourceDataAsOf,
        totalMatches: value.totalMatches,
        findings: value.findings,
      } satisfies EntityCheckOutcome<TKind, TFinding>);
    }
    default: {
      value satisfies never;
      return panic("Unhandled value");
    }
  }
};

export type RunEntityCheckOptions = {
  kind: EntityCheckKind;
  subject: EntityCheckSubject;
  signal?: AbortSignal | undefined;
};

/**
 * Run one entity check against its official source. Source failures are
 * `unavailable` outcomes; only a malformed subject or caller cancellation is
 * an error.
 */
export const runEntityCheck = async ({
  kind,
  subject,
  signal,
}: RunEntityCheckOptions): Promise<
  Result<EntityCheckResult, EntityCheckError>
> => {
  switch (kind) {
    case "cz-insolvency": {
      return await settle({ kind, subject, signal, query: checkCzInsolvency });
    }
    default: {
      kind satisfies never;
      return panic("Unhandled kind");
    }
  }
};
