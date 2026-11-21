import { MAGYAR_KOZLONY_WORK_URN_PREFIX } from "./magyar-kozlony-designation";
import {
  isPublicCountry,
  type PublicCountry,
} from "./public-country-capability";

/**
 * How a country's statute publisher names a Work, which is the identifier
 * the corpus stores it under and an agent passes back as `eli`.
 *
 * - `eli`: `<origin>/eli/<jurisdiction>/<collection>/<year>/<number>`. A
 *   short spelling (`/eli/cz/sb/2012/89`) is read back under the origin.
 * - `magyar_kozlony`: the Magyar Közlöny states no ELIs; the Work is its
 *   act designation folded under a URN prefix
 *   (`urn:hu:magyar-kozlony:2013-evi-v-torveny`), read by
 *   `magyar-kozlony-designation`.
 * - `undeclared`: no statute of the country is public yet.
 *
 * Total over the public country list, so no country reaches the statute
 * readers without saying how its Works are named.
 */
export type StatuteWorkIdentifierForm =
  | { type: "eli"; jurisdiction: string; origin: string }
  | { type: "magyar_kozlony"; prefix: string }
  | { type: "undeclared"; reason: string };

const UNDECLARED = {
  type: "undeclared",
  reason: "No statute of this country is public yet.",
} as const satisfies StatuteWorkIdentifierForm;

export const STATUTE_WORK_IDENTIFIERS = {
  AUT: UNDECLARED,
  BRA: UNDECLARED,
  CZE: { type: "eli", jurisdiction: "cz", origin: "https://www.e-sbirka.cz" },
  EU: UNDECLARED,
  GBR: UNDECLARED,
  HUN: { type: "magyar_kozlony", prefix: MAGYAR_KOZLONY_WORK_URN_PREFIX },
  POL: UNDECLARED,
  SVK: { type: "eli", jurisdiction: "sk", origin: "https://www.slov-lex.sk" },
  USA: UNDECLARED,
} as const satisfies Record<PublicCountry, StatuteWorkIdentifierForm>;

const FORMS: readonly StatuteWorkIdentifierForm[] = Object.values(
  STATUTE_WORK_IDENTIFIERS,
);

/** ELI jurisdiction segment (`cz`) to the publisher origin its Works carry. */
export const STATUTE_ELI_PUBLISHER_ORIGINS: Readonly<Record<string, string>> =
  Object.fromEntries(
    FORMS.flatMap((form) =>
      form.type === "eli" ? [[form.jurisdiction, form.origin] as const] : [],
    ),
  );

/** The URN prefixes Works of publishers without ELIs are named under. */
export const STATUTE_WORK_URN_PREFIXES: readonly string[] = FORMS.flatMap(
  (form) => (form.type === "magyar_kozlony" ? [form.prefix] : []),
);

/**
 * How a stored country code's Works are named. A code outside the public
 * list holds no public statutes, so it is undeclared like a pending one.
 */
export const statuteWorkIdentifierForm = (
  country: string,
): StatuteWorkIdentifierForm => {
  const canonical = country.trim().toUpperCase();
  return isPublicCountry(canonical)
    ? STATUTE_WORK_IDENTIFIERS[canonical]
    : UNDECLARED;
};
