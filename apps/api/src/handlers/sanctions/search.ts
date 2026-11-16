import { panic, Result } from "better-result";
import * as v from "valibot";

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
import { publicScreeningBusyAnswer } from "@/api/lib/lists/sanctions/screening-failure";
import { SANCTIONS_SUBJECT_ERROR_MESSAGES } from "@/api/lib/lists/sanctions/screening-service";
import type {
  SanctionsScreening,
  SanctionsScreeningSubject,
  screenSanctionsSubject,
} from "@/api/lib/lists/sanctions/screening-service";

const bodySchema = v.strictObject({
  subject: v.union([
    v.strictObject({
      type: v.literal("organization"),
      name: v.pipe(v.string(), v.minLength(1), v.maxLength(512)),
      companyId: v.optional(
        v.pipe(v.string(), v.minLength(1), v.maxLength(32)),
      ),
    }),
    v.strictObject({
      type: v.literal("person"),
      firstName: v.pipe(v.string(), v.minLength(1), v.maxLength(100)),
      lastName: v.pipe(v.string(), v.minLength(1), v.maxLength(100)),
      dateOfBirth: v.optional(dateOfBirthSchema),
      nationalityCodes: v.optional(nationalityCodesSchema),
    }),
  ]),
});

type PublicSanctionsBody = v.InferOutput<typeof bodySchema>;

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

const screeningBusy = publicScreeningBusyAnswer;

type PublicSanctionsSearchResult =
  PublicSanctionsScreening | ReturnType<typeof screeningBusy>;

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
      contract: "patch",
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
