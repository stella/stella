import { panic, Result } from "better-result";

import {
  ENTITY_CHECK_KINDS,
  runEntityCheck,
} from "@stll/business-registries/entity-checks";
import type {
  EntityCheckKind,
  EntityCheckResult,
  EntityCheckSubject,
} from "@stll/business-registries/entity-checks";
import type { RegistryRequestObservation } from "@stll/business-registries/shared/request-observer";
import type { CountryCode } from "@stll/country-codes";
import { Temporal } from "@stll/time";

import type { ThirdPartyOutboundPermit } from "@/api/lib/auth/third-party-outbound-permit";
import type { DateOfBirth } from "@/api/lib/business-registries/date-of-birth";
import { runSanctionsCheck } from "@/api/lib/business-registries/sanctions-check";
import type {
  SanctionsCheckDependencies,
  SanctionsCheckResult,
} from "@/api/lib/business-registries/sanctions-check";
import type { SanctionsCompanyIdCountry } from "@/api/lib/business-registries/sanctions-check-vocabulary";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

// Shared by the HTTP route, the check_counterparty MCP tool and the
// counterparty_check chat tool.

/** The register checks, plus screening against every sanctions list. */
export const COUNTERPARTY_CHECK_KINDS = [
  ...ENTITY_CHECK_KINDS,
  "sanctions",
] as const;

type CounterpartyCheckKind = (typeof COUNTERPARTY_CHECK_KINDS)[number];

export const COUNTERPARTY_CHECK_SUBJECT_TYPES = [
  "company-id",
  "tax-id",
  "person",
  "organization",
] as const satisfies readonly CounterpartyCheckSubject["type"][];

/** Who to check, as every surface reads it before the check runs. */
export type CounterpartyCheckSubject =
  | {
      type: "company-id";
      value: string;
      country: SanctionsCompanyIdCountry;
    }
  | { type: "tax-id"; value: string }
  | {
      type: "person";
      firstName: string;
      lastName: string;
      dateOfBirth: DateOfBirth | null;
      nationalityCodes: readonly CountryCode[];
    }
  | {
      type: "organization";
      name: string;
      companyId: string | null;
    };

export type CounterpartyCheckResult = EntityCheckResult | SanctionsCheckResult;

export type RunEntityCheckSharedProps = {
  observer: RegistryRequestObservation;
  /** Every check asks a third-party source: an official register or list. */
  permit: ThirdPartyOutboundPermit;
  check: CounterpartyCheckKind;
  subject: CounterpartyCheckSubject;
  signal?: AbortSignal | undefined;
  runCheck?: typeof runEntityCheck | undefined;
  /** What the sanctions check reads: the lists, the register, the firm's jurisdictions. */
  sanctions: Omit<SanctionsCheckDependencies, "observer" | "permit"> & {
    runSanctionsCheck?: typeof runSanctionsCheck | undefined;
  };
};

const invalidSubject = (message: string, hint: string) =>
  Result.err(
    new HandlerError({
      status: 400,
      code: "validation_error",
      message,
      hint,
    }),
  );

const ISO_BIRTH_DATE = /^(\d{4})-(\d{2})-(\d{2})$/u;

type DayDateOfBirth = Extract<DateOfBirth, { precision: "day" }>;

/** Whether a day-precision date exists in the calendar: 1990-02-31 does not. */
const isCalendarDate = ({ year, month, day }: DayDateOfBirth): boolean =>
  Result.try(() =>
    Temporal.PlainDate.from({ year, month, day }, { overflow: "reject" }),
  ).isOk();

/** Whether a date at any precision says nothing the full date denies. */
const agreesWith = (full: DayDateOfBirth, partial: DateOfBirth): boolean => {
  if (partial.year !== full.year) {
    return false;
  }
  switch (partial.precision) {
    case "year": {
      return true;
    }
    case "month": {
      return partial.month === full.month;
    }
    case "day": {
      return partial.month === full.month && partial.day === full.day;
    }
    default: {
      partial satisfies never;
      return panic("Unhandled date of birth precision");
    }
  }
};

/**
 * A person's birth date from the two ways a caller may give it: a full ISO
 * date, or a date at the precision known. Both at once must not contradict
 * each other: a full date beside a year-only date of the same year is the
 * full date. A day-precision date must exist in the calendar.
 */
export const personDateOfBirth = ({
  birthDate,
  dateOfBirth,
}: {
  birthDate: string | undefined;
  dateOfBirth: DateOfBirth | undefined;
}): Result<DateOfBirth | null, HandlerError> => {
  const parts = birthDate === undefined ? null : ISO_BIRTH_DATE.exec(birthDate);
  if (birthDate !== undefined && parts === null) {
    return invalidSubject(
      "The birth date must be an ISO date (YYYY-MM-DD)",
      "Send the full date as YYYY-MM-DD, or the date of birth at the precision known.",
    );
  }
  const fromBirthDate: DayDateOfBirth | null =
    parts === null
      ? null
      : {
          precision: "day",
          year: Number(parts[1]),
          month: Number(parts[2]),
          day: Number(parts[3]),
        };
  for (const date of [fromBirthDate, dateOfBirth]) {
    if (date?.precision === "day" && !isCalendarDate(date)) {
      return invalidSubject(
        "The birth date is not a valid calendar date",
        "Send a date that exists in the calendar, or the date of birth at the precision known.",
      );
    }
  }
  if (fromBirthDate === null) {
    return Result.ok(dateOfBirth ?? null);
  }
  if (dateOfBirth !== undefined && !agreesWith(fromBirthDate, dateOfBirth)) {
    return invalidSubject(
      "The full birth date and the date of birth name different dates",
      "Send one of them: the full birth date, or the date of birth when only the year or month is known.",
    );
  }
  return Result.ok(fromBirthDate);
};

const pad = (value: number) => String(value).padStart(2, "0");

/**
 * Whether a register check screens a natural person. The one that does needs
 * the full birth date; the other answers only for a tax or company ID.
 */
const REGISTER_CHECKS_SCREEN_PERSONS = {
  "cz-insolvency": true,
  "cz-vat-reliability": false,
} as const satisfies Record<EntityCheckKind, boolean>;

// The register checks cover Czech subjects and a person by full birth date.
const toEntityCheckSubject = (
  check: EntityCheckKind,
  subject: CounterpartyCheckSubject,
): Result<EntityCheckSubject, HandlerError> => {
  switch (subject.type) {
    case "company-id": {
      return subject.country === "CZ"
        ? Result.ok({ type: "company-id", value: subject.value })
        : invalidSubject(
            `The ${check} check covers Czech companies only`,
            `Use check "sanctions" for a company registered in ${subject.country}.`,
          );
    }
    case "tax-id": {
      return Result.ok(subject);
    }
    case "person": {
      const { dateOfBirth } = subject;
      if (dateOfBirth?.precision === "day") {
        return Result.ok({
          type: "person",
          firstName: subject.firstName,
          lastName: subject.lastName,
          birthDate: `${dateOfBirth.year}-${pad(dateOfBirth.month)}-${pad(dateOfBirth.day)}`,
        });
      }
      // Asking for a birth date the check would not use sends the caller
      // after the wrong fix.
      return REGISTER_CHECKS_SCREEN_PERSONS[check]
        ? invalidSubject(
            `The ${check} check needs the person's full birth date`,
            "Pass the birth date with year, month and day, or ask the user for it.",
          )
        : invalidSubject(
            `The ${check} check does not screen persons`,
            'It takes a tax ID or a company ID. Use check "sanctions" to screen a person by name.',
          );
    }
    case "organization": {
      // An organization by name is the sanctions check's subject. Reading its
      // registration number as a company ID would lose which country issued
      // it and could send a foreign ID to a Czech register.
      return invalidSubject(
        `The ${check} check does not take an organization by name`,
        'Pass subject type company-id with the company\'s IČO, or use check "sanctions" to screen the name.',
      );
    }
    default: {
      subject satisfies never;
      return panic("Unhandled subject");
    }
  }
};

const runRegisterCheck = async ({
  check,
  observer,
  subject,
  signal,
  runCheck,
}: {
  check: EntityCheckKind;
  observer: RegistryRequestObservation;
  subject: CounterpartyCheckSubject;
  signal: AbortSignal | undefined;
  runCheck: typeof runEntityCheck;
}): Promise<Result<EntityCheckResult, HandlerError>> => {
  const entitySubject = toEntityCheckSubject(check, subject);
  if (entitySubject.isErr()) {
    return Result.err(entitySubject.error);
  }
  const result = await runCheck({
    observer,
    kind: check,
    subject: entitySubject.value,
    signal,
  });
  if (result.isOk()) {
    return Result.ok(result.value);
  }
  const error = result.error;
  switch (error._tag) {
    case "EntityCheckInputError": {
      return Result.err(
        new HandlerError({
          status: 400,
          code: "validation_error",
          message: error.message,
        }),
      );
    }
    case "EntityCheckCancelledError": {
      return Result.err(
        new HandlerError({
          status: 503,
          code: "entity_check_cancelled",
          message: "The check was cancelled before the source answered",
        }),
      );
    }
    default: {
      error satisfies never;
      return panic("Unhandled error");
    }
  }
};

/**
 * Screen a subject against one official source, or against every sanctions
 * list. A source that could not answer is an `unavailable` outcome, not an
 * error: the caller must see that the check did not run rather than a
 * missing result.
 */
export const runEntityCheckShared = async ({
  observer,
  permit,
  check,
  subject,
  signal,
  runCheck = runEntityCheck,
  sanctions,
}: RunEntityCheckSharedProps): Promise<
  Result<CounterpartyCheckResult, HandlerError>
> => {
  if (check !== "sanctions") {
    return await runRegisterCheck({
      check,
      observer,
      subject,
      signal,
      runCheck,
    });
  }
  if (subject.type === "tax-id") {
    return invalidSubject(
      "The sanctions check screens a name, and a tax ID alone has none",
      "Pass subject type company-id (resolved to the company's name through its register), organization with the name, or person.",
    );
  }
  const { runSanctionsCheck: run = runSanctionsCheck, ...dependencies } =
    sanctions;
  return await run({
    subject,
    dependencies: { ...dependencies, observer, permit },
  });
};
