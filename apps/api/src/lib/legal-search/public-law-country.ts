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
 * that answer is a `not_found`, not a complaint about spelling.
 */

import { t } from "elysia";

import type { CountryAlpha3 } from "@stll/agent-input";
import {
  askSentence,
  COUNTRY_INPUT_MAX_CHARS,
  normalizeCountry,
} from "@stll/agent-input";

/**
 * A declared country query property.
 *
 * The bound is the reader's, not a code's: capped at three characters, the
 * framework rejected `Czech Republic` with its own opaque 422 before the
 * handler could name the forms that are accepted.
 */
export const tPublicLawCountry = t.String({
  minLength: 2,
  maxLength: COUNTRY_INPUT_MAX_CHARS,
});

export type PublicLawCountryRead =
  | { kind: "read"; country: CountryAlpha3 }
  | { kind: "unreadable"; message: string };

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
    return { kind: "read", country: normalized.value.alpha3 };
  }
  return {
    kind: "unreadable",
    message: `${askSentence(normalized)} ${normalized.hint}`,
  };
};
