import { panic, Result } from "better-result";
import { t } from "elysia";
import type { Static } from "elysia";

import { isCountryCode } from "@stll/country-codes";

import { nationalityCodesSchema } from "@/api/handlers/contacts/person-details";
import { createSafePublicHandler } from "@/api/lib/api-handlers";
import { dateOfBirthSchema } from "@/api/lib/business-registries/date-of-birth";
import { personDateOfBirth } from "@/api/lib/business-registries/entity-checks";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import type { SanctionsPublicReadDb } from "@/api/lib/lists/sanctions/read-db";
import type { SanctionsIndexCache } from "@/api/lib/lists/sanctions/screening-index";
import { screenSanctionsSubject } from "@/api/lib/lists/sanctions/screening-service";
import type { SanctionsScreeningSubject } from "@/api/lib/lists/sanctions/screening-service";
import { sanctionsPublicReadDb } from "@/api/lib/root-scoped-db";

const bodySchema = t.Object(
  {
    subject: t.Union([
      t.Object(
        {
          type: t.Literal("organization"),
          name: t.String({ minLength: 1, maxLength: 512 }),
          companyId: t.Optional(t.String({ minLength: 1, maxLength: 32 })),
        },
        { additionalProperties: false },
      ),
      t.Object(
        {
          type: t.Literal("person"),
          firstName: t.String({ minLength: 1, maxLength: 100 }),
          lastName: t.String({ minLength: 1, maxLength: 100 }),
          dateOfBirth: t.Optional(dateOfBirthSchema),
          nationalityCodes: t.Optional(nationalityCodesSchema),
        },
        { additionalProperties: false },
      ),
    ]),
  },
  { additionalProperties: false },
);

type PublicSanctionsBody = Static<typeof bodySchema>;

const invalidSubject = (message: string) =>
  Result.err(
    new HandlerError({
      status: 400,
      code: "validation_error",
      message,
    }),
  );

const screeningSubject = ({
  subject,
}: PublicSanctionsBody): Result<SanctionsScreeningSubject, HandlerError> => {
  switch (subject.type) {
    case "organization": {
      const companyId = subject.companyId?.trim();
      return Result.ok({
        type: "organization",
        name: subject.name.trim(),
        identifiers:
          companyId === undefined || companyId === "" ? [] : [companyId],
      });
    }
    case "person": {
      const codes =
        subject.nationalityCodes === undefined ? [] : subject.nationalityCodes;
      const nationalityCodes = codes.filter(isCountryCode);
      if (codes.length !== nationalityCodes.length) {
        return invalidSubject(
          "Nationalities must be ISO 3166-1 alpha-2 country codes",
        );
      }
      return personDateOfBirth({
        birthDate: undefined,
        dateOfBirth: subject.dateOfBirth,
      }).map((date) => ({
        type: "person",
        name: `${subject.firstName.trim()} ${subject.lastName.trim()}`,
        birthDate:
          date === null
            ? null
            : {
                year: date.year,
                ...(date.precision !== "year" && { month: date.month }),
                ...(date.precision === "day" && { day: date.day }),
              },
        nationalityCodes: [...new Set(nationalityCodes)],
      }));
    }
    default: {
      subject satisfies never;
      return panic("Unhandled public sanctions subject");
    }
  }
};

export type PublicSanctionsSearchOptions = {
  db?: SanctionsPublicReadDb;
  screen?: typeof screenSanctionsSubject;
  now?: Date;
  indexCache?: SanctionsIndexCache;
};

/** Anonymous name screening: no practice jurisdictions, so every list is informational. */
export const createPublicSanctionsSearchHandler = ({
  db = sanctionsPublicReadDb,
  screen = screenSanctionsSubject,
  now,
  indexCache,
}: PublicSanctionsSearchOptions = {}) =>
  createSafePublicHandler(
    {
      mcp: { type: "covered", by: "check_counterparty" },
      body: bodySchema,
    },
    async function* ({ body }) {
      const subject = yield* screeningSubject(body);
      // Never retain the rejected operation's cause: it may contain identity input.
      const result = yield* Result.await(
        Result.tryPromise({
          try: async () =>
            await screen({
              db,
              subject,
              practiceJurisdictions: [],
              now,
              indexCache,
            }),
          catch: () =>
            new HandlerError({
              status: 500,
              code: "internal_server_error",
              message: "Could not screen the sanctions lists",
            }),
        }),
      );
      return result.mapError(
        (error) =>
          new HandlerError({
            status: 400,
            code: "validation_error",
            message:
              error.code === "empty-query"
                ? "The name to screen has no letters"
                : "The date of birth is not a valid calendar date",
          }),
      );
    },
  );

const publicSanctionsSearch = createPublicSanctionsSearchHandler();
export default publicSanctionsSearch;
