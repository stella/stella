import { panic, Result } from "better-result";
import { t } from "elysia";
import type { Static } from "elysia";

import {
  ENTITY_CHECK_KINDS,
  ENTITY_CHECK_SUBJECT_TYPES,
} from "@stll/business-registries/entity-checks";
import type { EntityCheckSubject } from "@stll/business-registries/entity-checks";

import { createSafeRootHandler } from "@/api/lib/api-handlers";
import { runEntityCheckShared } from "@/api/lib/business-registries/entity-checks";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const querySchema = t.Object({
  check: t.UnionEnum(ENTITY_CHECK_KINDS, {
    description: "Which official source to screen the subject against",
  }),
  subjectType: t.UnionEnum(ENTITY_CHECK_SUBJECT_TYPES, {
    description:
      "'company-id' screens a registered business by its national ID; " +
      "'tax-id' a taxpayer by its tax ID; 'person' a natural person by " +
      "name and birth date",
  }),
  companyId: t.Optional(
    t.String({
      minLength: 1,
      maxLength: 32,
      description: "National business ID",
    }),
  ),
  taxId: t.Optional(
    t.String({ minLength: 1, maxLength: 32, description: "Tax ID" }),
  ),
  firstName: t.Optional(t.String({ minLength: 1, maxLength: 100 })),
  lastName: t.Optional(t.String({ minLength: 1, maxLength: 100 })),
  birthDate: t.Optional(
    t.String({ format: "date", description: "Birth date, YYYY-MM-DD" }),
  ),
});

type CheckQuery = Static<typeof querySchema>;

const missingSubjectFields = (fields: string) =>
  Result.err(
    new HandlerError({
      status: 400,
      code: "validation_error",
      message: `The '${fields}' query parameters are required for this subject type`,
    }),
  );

const subjectFromQuery = (
  query: CheckQuery,
): Result<EntityCheckSubject, HandlerError> => {
  switch (query.subjectType) {
    case "company-id": {
      return query.companyId === undefined
        ? missingSubjectFields("companyId")
        : Result.ok({
            type: "company-id",
            value: query.companyId,
          } satisfies EntityCheckSubject);
    }
    case "tax-id": {
      return query.taxId === undefined
        ? missingSubjectFields("taxId")
        : Result.ok({
            type: "tax-id",
            value: query.taxId,
          } satisfies EntityCheckSubject);
    }
    case "person": {
      const { firstName, lastName, birthDate } = query;
      return firstName === undefined ||
        lastName === undefined ||
        birthDate === undefined
        ? missingSubjectFields("firstName, lastName, birthDate")
        : Result.ok({
            type: "person",
            firstName,
            lastName,
            birthDate,
          } satisfies EntityCheckSubject);
    }
    default: {
      query.subjectType satisfies never;
      return panic("Unhandled subjectType");
    }
  }
};

const businessRegistriesCheck = createSafeRootHandler(
  {
    description:
      "Screen a company or person against an official source, such as the " +
      "Czech insolvency or VAT register. Returns one outcome: clear (the " +
      "source answered and holds nothing adverse), found (with the adverse " +
      "records), not-registered (the source holds no record of the subject), " +
      "unavailable (the source could not answer; never read this as clear), " +
      "or not-covered (the source cannot answer for this subject type).",
    permissions: { workspace: ["read"] },
    mcp: { type: "tool", name: "check_counterparty" },
    access: "read",
    query: querySchema,
  },
  async function* ({ query, request }) {
    const subject = yield* subjectFromQuery(query);
    const result = yield* Result.await(
      runEntityCheckShared({
        check: query.check,
        subject,
        signal: request.signal,
      }),
    );
    return Result.ok(result);
  },
);

export default businessRegistriesCheck;
