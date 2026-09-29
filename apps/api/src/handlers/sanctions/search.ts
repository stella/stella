import { panic, Result } from "better-result";
import { t } from "elysia";
import type { Static } from "elysia";

import { isCountryCode } from "@stll/country-codes";
import { hasExcessQueryTokens, MAX_QUERY_TOKENS } from "@stll/sanctions";

import { nationalityCodesSchema } from "@/api/handlers/contacts/person-details";
import { createSafePublicHandler } from "@/api/lib/api-handlers";
import { dateOfBirthSchema } from "@/api/lib/business-registries/date-of-birth";
import { personDateOfBirth } from "@/api/lib/business-registries/entity-checks";
import { resolveSanctionsNameSubject } from "@/api/lib/business-registries/sanctions-check";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import type { SanctionsPublicReadDb } from "@/api/lib/lists/sanctions/read-db";
import type { SanctionsIndexCache } from "@/api/lib/lists/sanctions/screening-index";
import {
  screenSanctionsSubject,
  SANCTIONS_SUBJECT_ERROR_MESSAGES,
} from "@/api/lib/lists/sanctions/screening-service";
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
      return Result.ok(
        resolveSanctionsNameSubject({
          type: "organization",
          name: subject.name,
          companyId: subject.companyId === undefined ? null : subject.companyId,
        }).subject,
      );
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
      }).map(
        (dateOfBirth) =>
          resolveSanctionsNameSubject({
            type: "person",
            firstName: subject.firstName,
            lastName: subject.lastName,
            dateOfBirth,
            nationalityCodes,
          }).subject,
      );
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

const screeningUnavailable = () =>
  new HandlerError({
    status: 500,
    code: "internal_server_error",
    message: "Could not screen the sanctions lists",
  });

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
      if (
        hasExcessQueryTokens(
          subject.name,
          subject.type === "organization" ? "organisation" : "person",
        )
      ) {
        return invalidSubject(
          `The name to screen must contain at most ${MAX_QUERY_TOKENS} normalized tokens`,
        );
      }
      const role = yield* Result.await(
        Result.tryPromise({
          try: async () => await db.validateRole(),
          catch: screeningUnavailable,
        }),
      );
      yield* role.mapError(screeningUnavailable);
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
          catch: screeningUnavailable,
        }),
      );
      return result.mapError(
        (error) =>
          new HandlerError({
            status: 400,
            code: "validation_error",
            message: SANCTIONS_SUBJECT_ERROR_MESSAGES[error.code],
          }),
      );
    },
  );

const publicSanctionsSearch = createPublicSanctionsSearchHandler();
export default publicSanctionsSearch;
