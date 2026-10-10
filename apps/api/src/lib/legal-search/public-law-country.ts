/**
 * The country a public law request names.
 *
 * Over HTTP a country arrives however the caller spelled it: `CZ` from a
 * hand-written link, `Česko` from an agent writing in Czech, `Czech Republic`
 * from one writing in English. The reading is `normalizeCountry`, the same
 * reader the MCP tools bind, so a spelling either surface accepts is accepted
 * by both. This module is only that reader's HTTP boundary: the declared
 * schema whose bound matches what can be read, the canonical alpha-3 the
 * corpus keys on, and the reader's own ask rendered as one message.
 *
 * Admission stays with the caller. `publicCaseLawCountry` and
 * `publicLegislationCountry` answer whether a country has a corpus here, and
 * non-admitted advertised countries answer with typed unavailability. That
 * answer is built here, status included, so no handler spells its status.
 */

import type { TSchema, TUnion } from "@sinclair/typebox";
import { status, t } from "elysia";

import type { CountryAlpha3 } from "@stll/agent-input";
import {
  askSentence,
  COUNTRY_INPUT_MAX_CHARS,
  normalizeCountry,
} from "@stll/agent-input";
import {
  PUBLIC_COUNTRY_UNAVAILABLE_STATUS,
  publicCountryUnavailable,
  publicCountryUnavailableSchema,
  type PublicCountryUnavailable,
} from "@stll/api-contract/public-country-capability";

import { PUBLIC_ERROR_TEXT_BYTES } from "@/api/lib/search/public-error-response";
import { boundedString } from "@/api/lib/search/response-text-bounds";

const unavailableFields = publicCountryUnavailableSchema.entries;
export const tPublicCountryUnavailable = t.Object(
  {
    code: t.Literal(unavailableFields.code.literal),
    status: t.Literal(unavailableFields.status.literal),
    country: t.Enum(
      Object.fromEntries(
        unavailableFields.country.options.map(
          (country) => [country, country] as const,
        ),
      ),
    ),
    reason: t.UnionEnum(unavailableFields.reason.options),
    message: boundedString(PUBLIC_ERROR_TEXT_BYTES.message),
    hint: boundedString(PUBLIC_ERROR_TEXT_BYTES.hint),
  } satisfies Record<keyof typeof unavailableFields, TSchema>,
  { additionalProperties: false },
);

/** The refusal as an HTTP answer, at the status the contract names. */
export const publicCountryUnavailableAnswer = (
  response: PublicCountryUnavailable,
) => status(PUBLIC_COUNTRY_UNAVAILABLE_STATUS, response);

export type PublicCountryUnavailableAnswer = ReturnType<
  typeof publicCountryUnavailableAnswer
>;

/** The answer for a country an HTTP route names, or null when it is admitted
 *  or not advertised at all. */
export const publicLawCountryUnavailable = (
  input: string,
): PublicCountryUnavailableAnswer | null => {
  const response = publicCountryUnavailable(input);
  return response === null ? null : publicCountryUnavailableAnswer(response);
};

type PublicCountryUnavailableStatus = typeof PUBLIC_COUNTRY_UNAVAILABLE_STATUS;

type WithPublicCountryUnavailable<
  TResponses extends { readonly [PUBLIC_COUNTRY_UNAVAILABLE_STATUS]: TSchema },
> = Omit<TResponses, PublicCountryUnavailableStatus> & {
  readonly [PUBLIC_COUNTRY_UNAVAILABLE_STATUS]: TUnion<
    [
      TResponses[PublicCountryUnavailableStatus],
      typeof tPublicCountryUnavailable,
    ]
  >;
};

/**
 * Declares the refusal on a route's response map, beside whatever else its
 * status already answers (a plain miss). Every route that can refuse a
 * country declares it through here, so it cannot be declared under any other
 * status.
 */
export const withPublicCountryUnavailable = <
  TResponses extends { readonly [PUBLIC_COUNTRY_UNAVAILABLE_STATUS]: TSchema },
>(
  responses: TResponses,
): WithPublicCountryUnavailable<TResponses> => ({
  ...responses,
  [PUBLIC_COUNTRY_UNAVAILABLE_STATUS]: t.Union([
    responses[PUBLIC_COUNTRY_UNAVAILABLE_STATUS],
    tPublicCountryUnavailable,
  ]),
});

/**
 * A declared country query property.
 *
 * The bound is the reader's, not a code's: capped at three characters, the
 * framework rejected `Czech Republic` with its own opaque 422 before the
 * handler could name the forms that are accepted. There is no lower bound for
 * the same reason: a blank or one-character country is a spelling the reader
 * can answer, and a length the framework refuses first is an answer that names
 * neither the accepted forms nor the admitted codes. The property stays
 * required, so an omitted one is still the framework's missing-parameter
 * error rather than a country read from nothing.
 */
export const tPublicLawCountry = t.String({
  maxLength: COUNTRY_INPUT_MAX_CHARS,
});

export type PublicLawCountryRead =
  | { kind: "read"; country: CountryAlpha3 }
  | { kind: "unreadable"; message: string }
  | { kind: "unavailable"; answer: PublicCountryUnavailableAnswer };

type PublicLawCountryOptions = {
  /** The canonical codes this surface holds law for, named in the ask so a
   *  caller that guessed wrong can see what there is to ask for. */
  admitted: readonly string[];
  /** The query property, which is `jurisdiction` on the provision surfaces. */
  parameter?: string;
};

/**
 * The canonical alpha-3 a request's country names, or the ask for a fix.
 *
 * Alpha-3 is fixed rather than chosen by the caller: every public law column
 * this boundary guards stores alpha-3, and the admission checks downstream
 * compare against it.
 */
export const readPublicLawCountry = (
  input: unknown,
  { admitted, parameter }: PublicLawCountryOptions,
): PublicLawCountryRead => {
  const normalized = normalizeCountry(input, {
    spelling: "alpha-3",
    admitted,
    parameter,
  });
  if (normalized.ok) {
    const answer = publicLawCountryUnavailable(normalized.value.alpha3);
    if (answer !== null) {
      return { kind: "unavailable", answer };
    }
    return { kind: "read", country: normalized.value.alpha3 };
  }
  return {
    kind: "unreadable",
    message: `${askSentence(normalized)} ${normalized.hint}`,
  };
};
