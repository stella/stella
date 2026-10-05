import { panic, Result } from "better-result";

import type { RegistryRequestObservation } from "@stll/business-registries/shared/request-observer";
import type { CountryCode } from "@stll/country-codes";

import type { ScopedDb } from "@/api/db/safe-db";
import type { ThirdPartyOutboundPermit } from "@/api/lib/auth/third-party-outbound-permit";
import type { SafeId } from "@/api/lib/branded-types";
import type { DateOfBirth } from "@/api/lib/business-registries/date-of-birth";
import { BUSINESS_REGISTRY_DISPATCH } from "@/api/lib/business-registries/dispatch";
import type { executeRegistryLookup } from "@/api/lib/business-registries/dispatch";
import { lookupBusinessRegistryShared } from "@/api/lib/business-registries/registry-lookup";
import { SANCTIONS_COMPANY_REGISTRY_BY_COUNTRY } from "@/api/lib/business-registries/sanctions-check-vocabulary";
import type {
  SanctionsCompanyIdCountry,
  SanctionsCompanyRegistry,
} from "@/api/lib/business-registries/sanctions-check-vocabulary";
import { loadPracticeJurisdictions } from "@/api/lib/db/practice-jurisdictions";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import {
  screenSanctionsSubject,
  SANCTIONS_SUBJECT_ERROR_MESSAGES,
  unavailableSanctionsScreening,
} from "@/api/lib/lists/sanctions/screening-service";
import type {
  SanctionsScreening,
  SanctionsScreeningSubject,
} from "@/api/lib/lists/sanctions/screening-service";
import type { SanctionsUnavailableReason } from "@/api/lib/lists/sanctions/screening-vocabulary";

// The sanctions check of the counterparty check: resolves the subject the
// caller named into a name to screen, reads the firm's practice
// jurisdictions (which only label each list binding or informational), and
// hands both to the shared screening service. Nothing here logs the subject.

const COMPANY_ID_LABELS = {
  CZ: "Czech",
  SK: "Slovak",
} as const satisfies Record<SanctionsCompanyIdCountry, string>;

/** Who the caller asked to screen, as the counterparty check reads it. */
type SanctionsCheckSubject =
  | {
      type: "company-id";
      value: string;
      country: SanctionsCompanyIdCountry;
    }
  | {
      type: "organization";
      name: string;
      /** Screened as an identifier beside the name; no register is read. */
      companyId: string | null;
    }
  | {
      type: "person";
      firstName: string;
      lastName: string;
      dateOfBirth: DateOfBirth | null;
      nationalityCodes: readonly CountryCode[];
    };

/** The subject as screened, so a reader sees which name was used. */
type SanctionsCheckedSubject =
  | {
      type: "organization";
      name: string;
      identifiers: string[];
      /** Set when the name came from a register rather than the caller. */
      resolvedFrom: {
        type: "company-id";
        value: string;
        country: SanctionsCompanyIdCountry;
        registry: SanctionsCompanyRegistry;
      } | null;
    }
  | {
      type: "person";
      name: string;
      dateOfBirth: DateOfBirth | null;
      nationalityCodes: CountryCode[];
    }
  | {
      /** A company ID whose name could not be resolved; nothing was screened. */
      type: "company-id";
      value: string;
      country: SanctionsCompanyIdCountry;
    };

export type SanctionsCheckResult = SanctionsScreening & {
  kind: "sanctions";
  subject: SanctionsCheckedSubject;
};

export type SanctionsCheckDependencies = {
  observer: RegistryRequestObservation;
  /** Resolving a company ID to its name asks the company's register. */
  permit: ThirdPartyOutboundPermit;
  scopedDb: ScopedDb;
  organizationId: SafeId<"organization">;
  executeLookup?: typeof executeRegistryLookup | undefined;
  screen?: typeof screenSanctionsSubject | undefined;
  loadPracticeJurisdictions?: typeof loadPracticeCountries | undefined;
};

const invalidSubject = (message: string, hint?: string) =>
  Result.err(
    new HandlerError({
      status: 400,
      code: "validation_error",
      message,
      ...(hint !== undefined && { hint }),
    }),
  );

/** The countries the firm practises in, as stored codes. */
const loadPracticeCountries = async (
  props: Parameters<typeof loadPracticeJurisdictions>[0],
): Promise<CountryCode[]> =>
  (await loadPracticeJurisdictions(props)).map(
    (jurisdiction) => jurisdiction.countryCode,
  );

/** A register lookup the register refused as malformed input, not one it failed to answer. */
const isInputRejection = (error: HandlerError): boolean =>
  error.status === 400 || error.status === 422;

type ResolvedName =
  | {
      type: "resolved";
      subject: SanctionsScreeningSubject;
      checked: SanctionsCheckedSubject;
    }
  | { type: "unresolved"; reason: SanctionsUnavailableReason };

const resolveCompanyName = async ({
  value,
  country,
  dependencies,
}: {
  value: string;
  country: SanctionsCompanyIdCountry;
  dependencies: SanctionsCheckDependencies;
}): Promise<Result<ResolvedName, HandlerError>> => {
  const registry = SANCTIONS_COMPANY_REGISTRY_BY_COUNTRY[country];
  const label = COMPANY_ID_LABELS[country];
  const companyId = value.trim();
  // The adapter validates through a native checksum binding; a throw there is
  // a register fault like any adapter error, not a malformed ID.
  const canonical = Result.try(() =>
    BUSINESS_REGISTRY_DISPATCH[registry].isCanonicalId(companyId),
  );
  if (canonical.isErr()) {
    return Result.ok({ type: "unresolved", reason: "registry-unavailable" });
  }
  if (!canonical.value) {
    return invalidSubject(
      `Company ID must be a valid ${label} IČO (8 digits)`,
      "Pass the company's name as an organization subject if its ID is not known.",
    );
  }
  const lookup = await lookupBusinessRegistryShared({
    observer: dependencies.observer,
    permit: dependencies.permit,
    scopedDb: dependencies.scopedDb,
    organizationId: dependencies.organizationId,
    registry,
    q: companyId,
    executeLookup: dependencies.executeLookup,
  });
  if (lookup.isErr()) {
    // The register refusing the ID itself (a failed checksum) is the caller's
    // to correct; only a register that could not answer (down, timed out,
    // not configured) leaves the lists unscreened for want of a name.
    return isInputRejection(lookup.error)
      ? invalidSubject(
          `Company ID must be a valid ${label} IČO (8 digits)`,
          "Check the ID against the register, or pass the company's name as an organization subject.",
        )
      : Result.ok({ type: "unresolved", reason: "registry-unavailable" });
  }
  const response = lookup.value;
  if (response.type !== "lookup") {
    return Result.ok({ type: "unresolved", reason: "registry-unavailable" });
  }
  if (response.hit === null) {
    return Result.ok({ type: "unresolved", reason: "company-not-found" });
  }
  const identifiers = [companyId];
  return Result.ok({
    type: "resolved",
    subject: { type: "organization", name: response.hit.name, identifiers },
    checked: {
      type: "organization",
      name: response.hit.name,
      identifiers,
      resolvedFrom: { type: "company-id", value: companyId, country, registry },
    },
  });
};

/** Normalize a name subject identically for public and in-product screening. */
export const resolveSanctionsNameSubject = (
  subject: Exclude<SanctionsCheckSubject, { type: "company-id" }>,
): Extract<ResolvedName, { type: "resolved" }> => {
  switch (subject.type) {
    case "organization": {
      const name = subject.name.trim();
      const identifiers =
        subject.companyId === null || subject.companyId.trim() === ""
          ? []
          : [subject.companyId.trim()];
      return {
        type: "resolved",
        subject: { type: "organization", name, identifiers },
        checked: {
          type: "organization",
          name,
          identifiers,
          resolvedFrom: null,
        },
      };
    }
    case "person": {
      const name = `${subject.firstName.trim()} ${subject.lastName.trim()}`;
      const { dateOfBirth } = subject;
      const nationalityCodes = [...new Set(subject.nationalityCodes)];
      return {
        type: "resolved",
        subject: {
          type: "person",
          name,
          birthDate:
            dateOfBirth === null
              ? null
              : {
                  year: dateOfBirth.year,
                  ...(dateOfBirth.precision !== "year" && {
                    month: dateOfBirth.month,
                  }),
                  ...(dateOfBirth.precision === "day" && {
                    day: dateOfBirth.day,
                  }),
                },
          nationalityCodes,
        },
        checked: { type: "person", name, dateOfBirth, nationalityCodes },
      };
    }
    default: {
      subject satisfies never;
      return panic("Unhandled sanctions subject");
    }
  }
};

const resolveSubject = async (
  subject: SanctionsCheckSubject,
  dependencies: SanctionsCheckDependencies,
): Promise<Result<ResolvedName, HandlerError>> => {
  switch (subject.type) {
    case "company-id": {
      return await resolveCompanyName({
        value: subject.value,
        country: subject.country,
        dependencies,
      });
    }
    case "organization":
    case "person": {
      return Result.ok(resolveSanctionsNameSubject(subject));
    }
    default: {
      subject satisfies never;
      return panic("Unhandled sanctions subject");
    }
  }
};

/**
 * Screen a counterparty against every sanctions list. A company named only by
 * its ID is resolved through its register first; when that fails, every list
 * is `unavailable` with the reason, never `clear`.
 */
export const runSanctionsCheck = async ({
  subject,
  dependencies,
}: {
  subject: SanctionsCheckSubject;
  dependencies: SanctionsCheckDependencies;
}): Promise<Result<SanctionsCheckResult, HandlerError>> => {
  const {
    screen = screenSanctionsSubject,
    loadPracticeJurisdictions: loadJurisdictions = loadPracticeCountries,
  } = dependencies;
  const resolved = await resolveSubject(subject, dependencies);
  if (resolved.isErr()) {
    return Result.err(resolved.error);
  }
  const jurisdictions = await Result.tryPromise({
    try: async () =>
      await loadJurisdictions({
        scopedDb: dependencies.scopedDb,
        organizationId: dependencies.organizationId,
      }),
    catch: (cause) =>
      new HandlerError({
        status: 500,
        message: "Could not read the practice jurisdictions",
        cause,
      }),
  });
  if (jurisdictions.isErr()) {
    return Result.err(jurisdictions.error);
  }
  const practiceJurisdictions = jurisdictions.value;
  const outcome = resolved.value;
  if (outcome.type === "unresolved") {
    if (subject.type !== "company-id") {
      return panic("Only a company ID resolves through a register");
    }
    return Result.ok({
      kind: "sanctions",
      subject: {
        type: "company-id",
        value: subject.value.trim(),
        country: subject.country,
      },
      ...unavailableSanctionsScreening({
        reason: outcome.reason,
        practiceJurisdictions,
      }),
    });
  }
  const screened = await screen({
    db: dependencies.scopedDb,
    subject: outcome.subject,
    nameSource: subject.type === "company-id" ? "register" : "free-text",
    practiceJurisdictions,
  });
  if (screened.isErr()) {
    if (subject.type === "company-id") {
      return Result.ok({
        kind: "sanctions",
        subject: outcome.checked,
        ...unavailableSanctionsScreening({
          reason: "load-failed",
          practiceJurisdictions,
        }),
      });
    }
    return invalidSubject(
      SANCTIONS_SUBJECT_ERROR_MESSAGES[screened.error.code],
    );
  }
  return Result.ok({
    kind: "sanctions",
    subject: outcome.checked,
    ...screened.value,
  });
};
