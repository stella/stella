import { panic, Result, TaggedError } from "better-result";
import { Temporal } from "temporal-polyfill/full";

import { validate as validateCzDic } from "@stll/stdnum/cz/dic";
import { validate as validateCzIco } from "@stll/stdnum/cz/ico";

import { checkCzInsolvency, CZ_INSOLVENCY_SOURCE } from "./cz-insolvency.js";
import type { CzInsolvencyFinding } from "./cz-insolvency.js";
import {
  checkCzVatReliability,
  CZ_VAT_RELIABILITY_SOURCE,
} from "./cz-vat-reliability.js";
import type {
  CzVatPayerRecord,
  CzVatReliabilityFinding,
} from "./cz-vat-reliability.js";
import { nowInstant } from "./result.js";
import type {
  CheckedEntityCheckSubject,
  EntityCheckCancelledError,
  EntityCheckOutcome,
  EntityCheckSource,
  EntityCheckSourceError,
  EntityCheckSubject,
  EntityCheckSubjectType,
  SourceAnswer,
} from "./result.js";

export const ENTITY_CHECK_KINDS = [
  "cz-insolvency",
  "cz-vat-reliability",
] as const;

export type EntityCheckKind = (typeof ENTITY_CHECK_KINDS)[number];

type EntityCheckFindings = {
  "cz-insolvency": CzInsolvencyFinding;
  "cz-vat-reliability": CzVatReliabilityFinding;
};

type EntityCheckRecords = {
  "cz-insolvency": null;
  "cz-vat-reliability": CzVatPayerRecord;
};

type EntityCheckResultOf<TKind extends EntityCheckKind> = EntityCheckOutcome<
  TKind,
  EntityCheckFindings[TKind],
  EntityCheckRecords[TKind]
>;

export type EntityCheckResult = {
  [TKind in EntityCheckKind]: EntityCheckResultOf<TKind>;
}[EntityCheckKind];

type EntityCheckDescriptor = {
  country: "CZ";
  source: EntityCheckSource;
  subjectTypes: readonly [EntityCheckSubjectType, ...EntityCheckSubjectType[]];
  /**
   * `derive-tax-id`: a company ID is sent as the tax ID a legal person is
   * assigned from it (CZ + IČO), and the outcome marks it derived.
   */
  companyId: "as-is" | "derive-tax-id";
};

const ENTITY_CHECKS = {
  "cz-insolvency": {
    country: "CZ",
    source: CZ_INSOLVENCY_SOURCE,
    subjectTypes: ["company-id", "person"],
    companyId: "as-is",
  },
  "cz-vat-reliability": {
    country: "CZ",
    source: CZ_VAT_RELIABILITY_SOURCE,
    subjectTypes: ["tax-id", "company-id"],
    companyId: "derive-tax-id",
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

/** A tax ID in its prefixed form, e.g. CZ45274649. */
const normalizeTaxId = (
  country: EntityCheckDescriptor["country"],
  value: string,
): InputResult<string> => {
  switch (country) {
    case "CZ": {
      const result = validateCzDic(value);
      return result.valid
        ? Result.ok(`CZ${result.compact}`)
        : invalidInput(
            "Tax ID must be a valid Czech DIČ (CZ followed by 8 to 10 digits)",
          );
    }
    default: {
      country satisfies never;
      return panic("Unhandled country");
    }
  }
};

const checkedSubject = (
  descriptor: EntityCheckDescriptor,
  subject: EntityCheckSubject,
): InputResult<CheckedEntityCheckSubject> =>
  Result.gen(function* () {
    switch (subject.type) {
      case "company-id": {
        const companyId = yield* normalizeCompanyId(
          descriptor.country,
          subject.value,
        );
        switch (descriptor.companyId) {
          case "as-is": {
            return Result.ok({
              type: "company-id",
              value: companyId,
            } satisfies CheckedEntityCheckSubject);
          }
          case "derive-tax-id": {
            return Result.ok({
              type: "tax-id",
              value: `${descriptor.country}${companyId}`,
              derivedFrom: { type: "company-id", value: companyId },
            } satisfies CheckedEntityCheckSubject);
          }
          default: {
            descriptor.companyId satisfies never;
            return panic("Unhandled company ID disposition");
          }
        }
      }
      case "tax-id": {
        return Result.ok({
          type: "tax-id",
          value: yield* normalizeTaxId(descriptor.country, subject.value),
          derivedFrom: null,
        } satisfies CheckedEntityCheckSubject);
      }
      case "person": {
        return Result.ok({
          type: "person",
          firstName: yield* normalizeName(subject.firstName, "First name"),
          lastName: yield* normalizeName(subject.lastName, "Last name"),
          birthDate: yield* normalizeBirthDate(subject.birthDate),
        } satisfies CheckedEntityCheckSubject);
      }
      default: {
        subject satisfies never;
        return panic("Unhandled subject");
      }
    }
  });

/** The subject as given, for an outcome that sent nothing to the source. */
const unsentSubject = (
  subject: EntityCheckSubject,
): CheckedEntityCheckSubject =>
  subject.type === "tax-id"
    ? { type: "tax-id", value: subject.value, derivedFrom: null }
    : subject;

type EntityCheckError = EntityCheckInputError | EntityCheckCancelledError;

type SettleOptions<TKind extends EntityCheckKind, TFinding, TRecord> = {
  kind: TKind;
  subject: EntityCheckSubject;
  signal: AbortSignal | undefined;
  query: (
    subject: CheckedEntityCheckSubject,
    signal: AbortSignal | undefined,
  ) => Promise<Result<SourceAnswer<TFinding, TRecord>, EntityCheckSourceError>>;
};

// The single place a source answer becomes an outcome. `clear` is reachable
// only from a source client's explicit clear answer; every source error is
// `unavailable`.
const settle = async <TKind extends EntityCheckKind, TFinding, TRecord>({
  kind,
  subject,
  signal,
  query,
}: SettleOptions<TKind, TFinding, TRecord>): Promise<
  Result<EntityCheckOutcome<TKind, TFinding, TRecord>, EntityCheckError>
> => {
  const descriptor: EntityCheckDescriptor = ENTITY_CHECKS[kind];
  const { source, subjectTypes } = descriptor;
  if (!subjectTypes.some((type) => type === subject.type)) {
    return Result.ok({
      status: "not-covered",
      kind,
      source,
      subject: unsentSubject(subject),
      reason: "subject-type-not-supported",
      supportedSubjectTypes: [...subjectTypes],
    } satisfies EntityCheckOutcome<TKind, TFinding, TRecord>);
  }
  const normalized = checkedSubject(descriptor, subject);
  if (normalized.isErr()) {
    return Result.err(normalized.error);
  }
  const checked = normalized.value;
  const checkedAt = nowInstant();
  const answer = await query(checked, signal);
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
          subject: checked,
          checkedAt,
          reason: error.reason,
          detail: error.detail,
        } satisfies EntityCheckOutcome<TKind, TFinding, TRecord>);
      }
      default: {
        error satisfies never;
        return panic("Unhandled source error");
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
        subject: checked,
        checkedAt,
        sourceDataAsOf: value.sourceDataAsOf,
        record: value.record,
      } satisfies EntityCheckOutcome<TKind, TFinding, TRecord>);
    }
    case "found": {
      return Result.ok({
        status: "found",
        kind,
        source,
        subject: checked,
        checkedAt,
        sourceDataAsOf: value.sourceDataAsOf,
        totalMatches: value.totalMatches,
        findings: value.findings,
        record: value.record,
      } satisfies EntityCheckOutcome<TKind, TFinding, TRecord>);
    }
    case "not-registered": {
      return Result.ok({
        status: "not-registered",
        kind,
        source,
        subject: checked,
        checkedAt,
        sourceDataAsOf: value.sourceDataAsOf,
      } satisfies EntityCheckOutcome<TKind, TFinding, TRecord>);
    }
    default: {
      value satisfies never;
      return panic("Unhandled source answer");
    }
  }
};

type RunEntityCheckOptions = {
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
    case "cz-vat-reliability": {
      return await settle({
        kind,
        subject,
        signal,
        query: checkCzVatReliability,
      });
    }
    default: {
      kind satisfies never;
      return panic("Unhandled entity check");
    }
  }
};
