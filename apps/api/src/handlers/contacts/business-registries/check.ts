import { panic, Result } from "better-result";
import { t } from "elysia";
import type { Static } from "elysia";

import { isCountryCode } from "@stll/country-codes";

import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import { grantThirdPartyOutboundPermit } from "@/api/lib/auth/third-party-outbound-permit";
import { dateOfBirthSchema } from "@/api/lib/business-registries/date-of-birth";
import {
  COUNTERPARTY_CHECK_KINDS,
  COUNTERPARTY_CHECK_SUBJECT_TYPES,
  personDateOfBirth,
  runEntityCheckShared,
} from "@/api/lib/business-registries/entity-checks";
import type { CounterpartyCheckSubject } from "@/api/lib/business-registries/entity-checks";
import { nationalityCodesSchema } from "@/api/lib/business-registries/nationality-codes";
import { SANCTIONS_COMPANY_ID_COUNTRIES } from "@/api/lib/business-registries/sanctions-check-vocabulary";
import type { SanctionsCompanyIdCountry } from "@/api/lib/business-registries/sanctions-check-vocabulary";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import {
  ACTION_COST_CALL_KIND,
  actionRequestObserver,
} from "@/api/lib/usage/action-costs/context";

// A tuple of literals keeps each option in the route types; `satisfies` fails
// when the vocabulary changes.
const [czechCompanyId, slovakCompanyId] =
  SANCTIONS_COMPANY_ID_COUNTRIES satisfies readonly [
    SanctionsCompanyIdCountry,
    SanctionsCompanyIdCountry,
  ];

// A POST body keeps a person's name and birth date out of URLs and access logs.
const bodySchema = t.Object({
  check: t.UnionEnum(COUNTERPARTY_CHECK_KINDS, {
    description:
      "Which official source to screen the subject against; 'sanctions' " +
      "screens every sanctions list and answers per list",
  }),
  subjectType: t.UnionEnum(COUNTERPARTY_CHECK_SUBJECT_TYPES, {
    description:
      "'company-id' screens a registered business by its national ID; " +
      "'tax-id' a taxpayer by its tax ID; 'person' a natural person by " +
      "name and birth date; 'organization' an organization by name " +
      "(sanctions only)",
  }),
  companyId: t.Optional(
    t.String({
      minLength: 1,
      maxLength: 32,
      description: "National business ID",
    }),
  ),
  country: t.Optional(
    t.Union([t.Literal(czechCompanyId), t.Literal(slovakCompanyId)], {
      description:
        "Country that issued the company ID; defaults to CZ. The register " +
        "checks cover CZ only",
    }),
  ),
  taxId: t.Optional(
    t.String({ minLength: 1, maxLength: 32, description: "Tax ID" }),
  ),
  name: t.Optional(
    t.String({
      minLength: 1,
      maxLength: 512,
      description: "Organization name, for the 'organization' subject type",
    }),
  ),
  firstName: t.Optional(t.String({ minLength: 1, maxLength: 100 })),
  lastName: t.Optional(t.String({ minLength: 1, maxLength: 100 })),
  birthDate: t.Optional(
    t.String({ format: "date", description: "Birth date, YYYY-MM-DD" }),
  ),
  dateOfBirth: t.Optional(dateOfBirthSchema),
  nationalityCodes: t.Optional(nationalityCodesSchema),
});

type CheckBody = Static<typeof bodySchema>;

const missingSubjectFields = (fields: string) =>
  Result.err(
    new HandlerError({
      status: 400,
      code: "validation_error",
      message: `The '${fields}' fields are required for this subject type`,
    }),
  );

const subjectFromBody = (
  body: CheckBody,
): Result<CounterpartyCheckSubject, HandlerError> => {
  switch (body.subjectType) {
    case "company-id": {
      return body.companyId === undefined
        ? missingSubjectFields("companyId")
        : Result.ok({
            type: "company-id",
            value: body.companyId,
            country: body.country ?? "CZ",
          } satisfies CounterpartyCheckSubject);
    }
    case "tax-id": {
      return body.taxId === undefined
        ? missingSubjectFields("taxId")
        : Result.ok({
            type: "tax-id",
            value: body.taxId,
          } satisfies CounterpartyCheckSubject);
    }
    case "person": {
      const { firstName, lastName } = body;
      if (firstName === undefined || lastName === undefined) {
        return missingSubjectFields("firstName, lastName");
      }
      const codes = body.nationalityCodes;
      const nationalityCodes =
        codes === undefined ? [] : codes.filter(isCountryCode);
      if (codes !== undefined && nationalityCodes.length !== codes.length) {
        return Result.err(
          new HandlerError({
            status: 400,
            code: "validation_error",
            message: "Nationalities must be ISO 3166-1 alpha-2 country codes",
          }),
        );
      }
      return personDateOfBirth({
        birthDate: body.birthDate,
        dateOfBirth: body.dateOfBirth,
      }).map(
        (dateOfBirth) =>
          ({
            type: "person",
            firstName,
            lastName,
            dateOfBirth,
            nationalityCodes,
          }) satisfies CounterpartyCheckSubject,
      );
    }
    case "organization": {
      return body.name === undefined
        ? missingSubjectFields("name")
        : Result.ok({
            type: "organization",
            name: body.name,
            companyId: body.companyId ?? null,
          } satisfies CounterpartyCheckSubject);
    }
    default: {
      body.subjectType satisfies never;
      return panic("Unhandled subjectType");
    }
  }
};

const businessRegistriesCheck = createSafeRootHandler(
  {
    description:
      "Screen a company or person against an official source, such as the " +
      "Czech insolvency or VAT register, or against every sanctions list. " +
      "A register check returns one outcome: clear (the source answered and " +
      "holds nothing adverse), found (with the adverse records), " +
      "not-registered (the source holds no record of the subject), " +
      "unavailable (the source could not answer; never read this as clear), " +
      "or not-covered (the source cannot answer for this subject type). The " +
      "sanctions check returns one outcome per list (clear, possible-match " +
      "or unavailable) with the edition screened, and is clear only when " +
      "every list is.",
    permissions: { workspace: ["read"] },
    accountAccess: ACCOUNT_ACCESS.sandbox,
    mcp: { type: "tool", name: "check_counterparty" },
    access: "read",
    body: bodySchema,
  },
  async function* ({ body, request, scopedDb, session }) {
    const observer = actionRequestObserver(
      session.activeOrganizationId,
      ACTION_COST_CALL_KIND.registryRequest,
    );
    const subject = yield* subjectFromBody(body);
    const result = yield* Result.await(
      runEntityCheckShared({
        observer,
        permit: grantThirdPartyOutboundPermit(),
        check: body.check,
        subject,
        signal: request.signal,
        sanctions: {
          scopedDb,
          organizationId: session.activeOrganizationId,
        },
      }),
    );
    return Result.ok(result);
  },
);

export default businessRegistriesCheck;
