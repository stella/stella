import { panic } from "better-result";

import {
  isPublicCountry,
  type PublicCountry,
} from "./public-country-capability";

/**
 * The zone whose calendar day a jurisdiction's law takes effect on: "today"
 * for a statute read (which amendments are still pending, which act a title
 * names now) is that zone's date, not the server's or the reader's.
 *
 * Total over the public country list, so a country cannot be advertised for
 * any domain without its legal day being stated. A federal or multi-zone
 * jurisdiction names the zone its official gazette is published in.
 */
export const PUBLIC_COUNTRY_LEGAL_DAY_TIME_ZONE = {
  AUT: "Europe/Vienna",
  BRA: "America/Sao_Paulo",
  CZE: "Europe/Prague",
  EU: "Europe/Luxembourg",
  GBR: "Europe/London",
  HUN: "Europe/Budapest",
  POL: "Europe/Warsaw",
  SVK: "Europe/Bratislava",
  USA: "America/New_York",
} as const satisfies Record<PublicCountry, string>;

/**
 * The legal-day zone of a public country, spelled as the corpus stores it
 * (`HUN`) or as a route segment carries it (`hun`).
 */
export const legalDayTimeZone = (
  country: PublicCountry | Lowercase<PublicCountry>,
): string => {
  const canonical = country.toUpperCase();
  return isPublicCountry(canonical)
    ? PUBLIC_COUNTRY_LEGAL_DAY_TIME_ZONE[canonical]
    : panic(`Public country ${country} has no canonical spelling`);
};
