// ---------------------------------------------------------------------------
// Raw VIES REST API response shapes
// (https://ec.europa.eu/taxation_customs/vies/rest-api/ms/{COUNTRY}/vat/{VAT})
//
// VIES is the EU-wide VAT Information Exchange System. The REST endpoint
// always responds with HTTP 200 and a JSON body whose `userError` field
// is the real discriminator:
//
//   VALID         → the VAT is registered and validation succeeded
//   INVALID       → the VAT is well-formed but not registered
//   INVALID_INPUT → the input did not match the country's format rules
//   SERVICE_UNAVAILABLE / MS_UNAVAILABLE / TIMEOUT → upstream member-state
//     service was unreachable (validation could not be performed)
// ---------------------------------------------------------------------------

export type ViesUserError =
  | "VALID"
  | "INVALID"
  | "INVALID_INPUT"
  | "SERVICE_UNAVAILABLE"
  | "MS_UNAVAILABLE"
  | "TIMEOUT"
  | "GLOBAL_MAX_CONCURRENT_REQ"
  | "MS_MAX_CONCURRENT_REQ";

export type ViesApproximate = {
  name: string;
  street: string;
  postalCode: string;
  city: string;
  companyType: string;
  matchName: number;
  matchStreet: number;
  matchPostalCode: number;
  matchCity: number;
  matchCompanyType: number;
};

export type ViesRawResponse = {
  isValid: boolean;
  requestDate: string;
  userError: string;
  name: string;
  address: string;
  requestIdentifier: string;
  originalVatNumber: string;
  vatNumber: string;
  viesApproximate?: ViesApproximate;
};

// ---------------------------------------------------------------------------
// Domain output types
// ---------------------------------------------------------------------------

export type ViesVatNumber = {
  /** ISO 3166-1 alpha-2 country prefix (e.g. "DE", "IE"). VIES uses
   *  "EL" rather than ISO "GR" for Greece — we surface what the user
   *  passed in (after normalisation to uppercase) so they can map back
   *  to their input. */
  country: string;
  /** National VAT digits without the country prefix. */
  vat: string;
};

// Discriminated union over the request outcome.
//
//   valid               → registered VAT, member state returned a record
//   not-registered      → format ok, member state has no record
//   invalid-format      → input did not match the country's format rules
//   service-unavailable → member state's validation service was down
export type ViesValidationStatus =
  | { type: "valid" }
  | { type: "not-registered" }
  | { type: "invalid-format" }
  | { type: "service-unavailable"; userError: string };

export type ViesValidation = {
  vatNumber: ViesVatNumber;
  /** Convenience boolean — `true` iff status.type === "valid". */
  valid: boolean;
  status: ViesValidationStatus;
  /** ISO timestamp the upstream stamped on the validation. */
  requestDate: string;
  /**
   * Registered name as held by the member state. Several countries
   * (notably DE, ES, AT) suppress trader data even on valid records;
   * those responses come back as the literal "---" upstream, which we
   * normalise to `null` for callers that want to display the name.
   */
  name: string | null;
  /** Same null-on-"---" normalisation as `name`. */
  address: string | null;
};
