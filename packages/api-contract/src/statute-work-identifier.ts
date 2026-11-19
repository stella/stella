import { MAGYAR_KOZLONY_WORK_URN_PREFIX } from "./magyar-kozlony-designation";
import type { PublicCountry } from "./public-country-capability";

/**
 * How a country's statute publisher names a Work, which is the identifier
 * the corpus stores it under and an agent passes back as `eli`.
 *
 * - `eli`: `<origin>/eli/<jurisdiction>/<collection>/<year>/<number>`. A
 *   short spelling (`/eli/cz/sb/2012/89`) is read back under the origin.
 * - `urn`: a publisher without ELIs; the Work is a slug under a URN prefix
 *   (`urn:hu:magyar-kozlony:2013-evi-v-torveny`).
 * - `undeclared`: no statute of the country is public yet.
 *
 * Total over the public country list, so no country reaches the statute
 * readers without saying how its Works are named.
 */
type StatuteWorkIdentifierForm =
  | { type: "eli"; jurisdiction: string; origin: string }
  | { type: "urn"; prefix: string }
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
  HUN: { type: "urn", prefix: MAGYAR_KOZLONY_WORK_URN_PREFIX },
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
  (form) => (form.type === "urn" ? [form.prefix] : []),
);
