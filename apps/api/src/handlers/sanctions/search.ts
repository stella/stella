import { panic, Result } from "better-result";
import { status, t } from "elysia";
import type { Static } from "elysia";

import { isCountryCode } from "@stll/country-codes";
import { hasExcessQueryTokens, MAX_QUERY_TOKENS } from "@stll/sanctions";

import { publicSanctionsResponseSchema } from "@/api/handlers/sanctions/search-response";
import type { PublicSanctionsScreening } from "@/api/handlers/sanctions/search-response";
import {
  ACCOUNT_ACCESS,
  createSafePublicHandler,
} from "@/api/lib/api-handlers";
import type { SafeHandlerGenerator } from "@/api/lib/api-handlers";
import { dateOfBirthSchema } from "@/api/lib/business-registries/date-of-birth";
import { personDateOfBirth } from "@/api/lib/business-registries/entity-checks";
import { nationalityCodesSchema } from "@/api/lib/business-registries/nationality-codes";
import { resolveSanctionsNameSubject } from "@/api/lib/business-registries/sanctions-check";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { API_RATE_LIMITS } from "@/api/lib/limits";
import { sanctionsPublicReadDb } from "@/api/lib/lists/sanctions/public-read-owner";
import {
  SANCTIONS_WARMING_RETRY_AFTER_SECONDS,
  screenPublicSanctionsSubject,
} from "@/api/lib/lists/sanctions/public-screening";
import type { SanctionsPublicReadDb } from "@/api/lib/lists/sanctions/read-db";
import { SANCTIONS_SUBJECT_ERROR_MESSAGES } from "@/api/lib/lists/sanctions/screening-service";
import type {
  screenSanctionsSubject,
  SanctionsScreening,
  SanctionsScreeningSubject,
} from "@/api/lib/lists/sanctions/screening-service";
import { logger } from "@/api/lib/observability/logger";

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
          companyId: subject.companyId ?? null,
        }).subject,
      );
    }
    case "person": {
      const { nationalityCodes: codes = [] } = subject;
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
};

const screeningUnavailable = () =>
  new HandlerError({
    status: 500,
    code: "internal_server_error",
    message: "Could not screen the sanctions lists",
  });

/**
 * An expected admission refusal, answered as a response rather than a
 * `HandlerError`: a 5xx error is reported as a fault, and this is capacity.
 */
const screeningBusy = () =>
  status(503, {
    code: "service_unavailable",
    message: "Sanctions screening is busy; try again shortly",
  });

type PublicSanctionsSearchResult =
  | PublicSanctionsScreening
  | ReturnType<typeof screeningBusy>;

const toPublicScreening = (
  screening: SanctionsScreening,
): PublicSanctionsScreening => ({
  ...screening,
  retryAfterSeconds: screening.lists.some((list) => list.reason === "warming")
    ? SANCTIONS_WARMING_RETRY_AFTER_SECONDS
    : null,
});

// CPU admission is per API process, shared by all mounted public handlers.
let activePublicScreenings = 0;

/** Anonymous name screening: no practice jurisdictions, so every list is informational. */
export const createPublicSanctionsSearchHandler = ({
  db = sanctionsPublicReadDb,
  screen = screenPublicSanctionsSubject,
  now,
}: PublicSanctionsSearchOptions = {}) =>
  createSafePublicHandler(
    {
      accountAccess: ACCOUNT_ACCESS.sandbox,
      cache: { kind: "none" },
      mcp: { type: "internal", reason: "public_indexing" },
      body: bodySchema,
      response: publicSanctionsResponseSchema,
    },
    async function* ({
      body,
    }): SafeHandlerGenerator<PublicSanctionsSearchResult> {
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
      if (
        activePublicScreenings >=
        API_RATE_LIMITS.publicSanctionsSearch.maxConcurrent
      ) {
        // Expected admission refusal: record only the bounded capacity, never identity.
        logger.warn("sanctions.search.busy", {
          maxConcurrent: API_RATE_LIMITS.publicSanctionsSearch.maxConcurrent,
        });
        return Result.ok(screeningBusy());
      }
      activePublicScreenings += 1;
      try {
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
              }),
            catch: screeningUnavailable,
          }),
        );
        return result.map(toPublicScreening).mapError(
          (error) =>
            new HandlerError({
              status: 400,
              code: "validation_error",
              message: SANCTIONS_SUBJECT_ERROR_MESSAGES[error.code],
            }),
        );
      } finally {
        activePublicScreenings -= 1;
      }
    },
  );

const publicSanctionsSearch = createPublicSanctionsSearchHandler();
export default publicSanctionsSearch;
