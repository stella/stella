// parser-output-unchanged: public admission metadata does not change parsed decision records.
import * as v from "valibot";

export type PublicCountryCapability =
  | "admitted"
  | "pending_public"
  | "withdrawn";

/** Public admission, independent of whether ingestion holds rows for a country. */
export const PUBLIC_COUNTRY_CAPABILITIES = {
  AUT: "pending_public",
  CZE: "admitted",
  EU: "pending_public",
  HUN: "pending_public",
  POL: "pending_public",
  SVK: "pending_public",
  USA: "pending_public",
} as const satisfies Record<string, PublicCountryCapability>;

export type PublicCountry = keyof typeof PUBLIC_COUNTRY_CAPABILITIES;

export const isPublicCountry = (country: string): country is PublicCountry =>
  Object.hasOwn(PUBLIC_COUNTRY_CAPABILITIES, country);

/** Advertising a country requires a capability: the keys are the only list. */
export const PUBLIC_COUNTRIES = Object.keys(PUBLIC_COUNTRY_CAPABILITIES).filter(
  isPublicCountry,
);

type AdmittedPublicCountry = {
  [
    Country in PublicCountry
  ]: (typeof PUBLIC_COUNTRY_CAPABILITIES)[Country] extends "admitted"
    ? Country
    : never;
}[PublicCountry];

export const ADMITTED_PUBLIC_COUNTRIES = PUBLIC_COUNTRIES.filter(
  (country): country is AdmittedPublicCountry =>
    PUBLIC_COUNTRY_CAPABILITIES[country] === "admitted",
);

export const PUBLIC_COUNTRY_UNAVAILABLE_CODE = "public_country_unavailable";

// parser-output-unchanged: the refusal's HTTP status affects responses only, not parsed records.
/**
 * The HTTP status the refusal answers with. The country is advertised but
 * holds no public law: an answered client outcome, like any other unavailable
 * public resource, never a server fault. `code` tells it apart from a miss.
 */
export const PUBLIC_COUNTRY_UNAVAILABLE_STATUS = 404;

export const publicCountryUnavailableSchema = v.strictObject({
  code: v.literal(PUBLIC_COUNTRY_UNAVAILABLE_CODE),
  status: v.literal("unavailable"),
  country: v.picklist(PUBLIC_COUNTRIES),
  reason: v.picklist(["pending_public", "withdrawn"]),
  message: v.string(),
  hint: v.string(),
});

export type PublicCountryUnavailable = v.InferOutput<
  typeof publicCountryUnavailableSchema
>;

/** Unknown countries remain input errors; advertised countries explain admission. */
export const publicCountryUnavailable = (
  input: string,
): PublicCountryUnavailable | null => {
  const country = input.trim().toUpperCase();
  if (!isPublicCountry(country)) {
    return null;
  }
  const capability = PUBLIC_COUNTRY_CAPABILITIES[country];
  if (capability === "admitted") {
    return null;
  }
  return {
    code: PUBLIC_COUNTRY_UNAVAILABLE_CODE,
    status: "unavailable",
    country,
    reason: capability,
    message: "Public law for this country is not available.",
    hint: `Choose an admitted country: ${ADMITTED_PUBLIC_COUNTRIES.join(", ")}.`,
  };
};
