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

// A POST body keeps a person's name and birth date out of URLs and access logs.
const bodySchema = t.Object({
  check: t.UnionEnum(ENTITY_CHECK_KINDS, {
    description: "Which official source to screen the subject against",
  }),
  subjectType: t.UnionEnum(ENTITY_CHECK_SUBJECT_TYPES, {
    description:
      "'company-id' screens a registered business by its national ID; " +
      "'person' screens a natural person by name and birth date",
  }),
  companyId: t.Optional(
    t.String({
      minLength: 1,
      maxLength: 32,
      description: "National business ID",
    }),
  ),
  firstName: t.Optional(t.String({ minLength: 1, maxLength: 100 })),
  lastName: t.Optional(t.String({ minLength: 1, maxLength: 100 })),
  birthDate: t.Optional(
    t.String({ format: "date", description: "Birth date, YYYY-MM-DD" }),
  ),
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
): Result<EntityCheckSubject, HandlerError> => {
  switch (body.subjectType) {
    case "company-id": {
      return body.companyId === undefined
        ? missingSubjectFields("companyId")
        : Result.ok({
            type: "company-id",
            value: body.companyId,
          } satisfies EntityCheckSubject);
    }
    case "person": {
      const { firstName, lastName, birthDate } = body;
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
      body.subjectType satisfies never;
      return panic("Unhandled subjectType");
    }
  }
};

const businessRegistriesCheck = createSafeRootHandler(
  {
    description:
      "Screen a company or person against an official source, such as the " +
      "Czech insolvency register. Returns one outcome: clear (the source " +
      "answered and holds nothing), found (with the records it holds), " +
      "unavailable (the source could not answer; never read this as clear), " +
      "or not-covered (the source cannot answer for this subject type).",
    permissions: { workspace: ["read"] },
    mcp: { type: "tool", name: "check_counterparty" },
    access: "read",
    body: bodySchema,
  },
  async function* ({ body, request }) {
    const subject = yield* subjectFromBody(body);
    const result = yield* Result.await(
      runEntityCheckShared({
        check: body.check,
        subject,
        signal: request.signal,
      }),
    );
    return Result.ok(result);
  },
);

export default businessRegistriesCheck;
