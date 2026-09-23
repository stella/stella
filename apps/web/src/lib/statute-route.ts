import { isPublicLegislationCountry } from "@stll/api-contract/legislation-publication";
import { createStatuteRouteParams } from "@stll/api-contract/statute-route";
import type { StatuteRouteInput } from "@stll/api-contract/statute-route";

import type { useFormatter } from "@/i18n/formatting-context";

/**
 * Jurisdictions the statutes browser covers, as route segments, with the
 * region code their names are rendered from. Order is the picker's order.
 */
export const STATUTE_COUNTRIES = {
  cze: { region: "CZ" },
  svk: { region: "SK" },
} as const satisfies Record<string, { region: string }>;

export type StatuteCountry = keyof typeof STATUTE_COUNTRIES;

export const isStatuteCountry = (value: string): value is StatuteCountry =>
  Object.hasOwn(STATUTE_COUNTRIES, value);

export const isPublicStatuteCountry = (
  value: string,
): value is StatuteCountry =>
  isStatuteCountry(value) && isPublicLegislationCountry(value.toUpperCase());

/**
 * A statute jurisdiction as a reader names it, from its route segment. One
 * helper, because the box and the top-bar menu have to say the same country
 * the same way.
 */
export const statuteCountryName = (
  format: ReturnType<typeof useFormatter>,
  segment: string,
): string =>
  format.displayName(
    isStatuteCountry(segment)
      ? STATUTE_COUNTRIES[segment].region
      : segment.toUpperCase(),
    { type: "region" },
  );

/**
 * One consolidation, as the props a `Link` needs. The `/v/` opening is always
 * named when the row has one: a citation means the wording that applied, and
 * the bare slug names whatever is latest. When the row turns out to be the
 * latest, the loader canonicalises the address; when it is not, this is the
 * only spelling that reaches the right text.
 */
export type StatuteLinkTarget =
  | {
      params: { country: string; slug: string };
      to: "/law/$country/statutes/$slug";
    }
  | {
      params: { country: string; slug: string; version: string };
      to: "/law/$country/statutes/$slug/v/$version";
    };

type CreateStatuteLinkTargetOptions = Omit<StatuteRouteInput, "version"> & {
  versionValidFrom: string | null;
};

export const createStatuteLinkTarget = ({
  country,
  documentId,
  eli,
  slug,
  versionValidFrom,
}: CreateStatuteLinkTargetOptions): StatuteLinkTarget => {
  const params = createStatuteRouteParams({
    country,
    documentId,
    eli,
    slug,
    version: versionValidFrom,
  });

  return params.version === undefined
    ? {
        params: { country: params.country, slug: params.slug },
        to: "/law/$country/statutes/$slug",
      }
    : {
        params: {
          country: params.country,
          slug: params.slug,
          version: params.version,
        },
        to: "/law/$country/statutes/$slug/v/$version",
      };
};
