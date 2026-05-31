import type {
  CompaniesHouseAccounts,
  CompaniesHouseAddress,
  CompaniesHouseCompany,
  CompaniesHouseConfirmationStatement,
  CompaniesHouseEntityStatus,
  CompaniesHouseOfficer,
  CompaniesHousePreviousName,
  CompaniesHouseRawAccounts,
  CompaniesHouseRawAddress,
  CompaniesHouseRawCompanyProfile,
  CompaniesHouseRawConfirmationStatement,
  CompaniesHouseRawOfficer,
  CompaniesHouseRawOfficersResponse,
  CompaniesHouseRawPreviousName,
  CompaniesHouseRawSearchItem,
  CompaniesHouseRawSearchResponse,
  CompaniesHouseSearchResult,
} from "./types.js";

const COMPANIES_HOUSE_PROFILE_URL =
  "https://find-and-update.company-information.service.gov.uk/company/";

const nonEmpty = (value: string | null | undefined): string | null => {
  if (value === null || value === undefined) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const parseIntOrNull = (
  value: string | number | null | undefined,
): number | null => {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? Math.trunc(value) : null;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isFinite(parsed) ? parsed : null;
};

export const parseAddress = (
  raw: CompaniesHouseRawAddress,
): CompaniesHouseAddress => {
  const premises = nonEmpty(raw.premises);
  const addressLine1 = nonEmpty(raw.address_line_1);
  const addressLine2 = nonEmpty(raw.address_line_2);
  const locality = nonEmpty(raw.locality);
  const region = nonEmpty(raw.region);
  const postalCode = nonEmpty(raw.postal_code);
  const country = nonEmpty(raw.country);
  const poBox = nonEmpty(raw.po_box);
  const careOf = nonEmpty(raw.care_of);

  // Compose a single-line address in UK postal order:
  //   care_of, po_box, premises + address_line_1, address_line_2,
  //   locality, region, postal_code, country.
  // Companies House does not always set every field — small companies
  // routinely file just a single address line + postcode, and
  // agent / PO-box-only filings can omit the structured street
  // entirely, so the c/o + po_box prefixes are the only delivery
  // identifier in those cases.
  const streetParts = [premises, addressLine1].filter(Boolean);
  const composite = [
    careOf ? `c/o ${careOf}` : null,
    poBox ? `PO Box ${poBox}` : null,
    streetParts.length > 0 ? streetParts.join(" ") : null,
    addressLine2,
    locality,
    region,
    postalCode,
    country,
  ]
    .filter(Boolean)
    .join(", ");

  return {
    premises,
    addressLine1,
    addressLine2,
    locality,
    region,
    postalCode,
    country,
    poBox,
    careOf,
    textAddress: composite.length > 0 ? composite : null,
  };
};

const parseStatus = (
  raw: CompaniesHouseRawCompanyProfile,
): CompaniesHouseEntityStatus => {
  // company_status is documented but optional on the wire; treat
  // missing as "unknown" rather than guessing from related fields.
  const code = nonEmpty(raw.company_status);
  if (!code) {
    return { type: "unknown" };
  }
  switch (code) {
    case "active": {
      return { type: "active" };
    }
    case "dissolved": {
      return {
        type: "dissolved",
        dissolvedAt: nonEmpty(raw.date_of_cessation),
      };
    }
    case "liquidation": {
      return { type: "liquidation" };
    }
    case "administration": {
      return { type: "administration" };
    }
    case "receivership": {
      return { type: "receivership" };
    }
    case "voluntary-arrangement": {
      return { type: "voluntary-arrangement" };
    }
    case "insolvency-proceedings": {
      return { type: "insolvency-proceedings" };
    }
    case "converted-closed": {
      return {
        type: "converted-closed",
        closedAt: nonEmpty(raw.date_of_cessation),
      };
    }
    case "open": {
      return { type: "open" };
    }
    case "closed": {
      return { type: "closed" };
    }
    case "registered": {
      return { type: "registered" };
    }
    case "removed": {
      return { type: "removed" };
    }
    default: {
      return { type: "unknown" };
    }
  }
};

const parseAccounts = (
  raw: CompaniesHouseRawAccounts | undefined,
): CompaniesHouseAccounts | null => {
  if (!raw) {
    return null;
  }
  const lastMadeUpTo = nonEmpty(raw.last_accounts?.made_up_to);
  // Prefer the explicit `next_made_up_to` (the date the next set of
  // accounts must cover up to); fall back to the deprecated alias on
  // the legacy top-level surface.
  const nextMadeUpTo = nonEmpty(raw.next_made_up_to);
  const nextDue = nonEmpty(raw.next_due) ?? nonEmpty(raw.next_accounts?.due_on);
  const overdue = raw.next_accounts?.overdue ?? raw.overdue ?? false;
  if (
    lastMadeUpTo === null &&
    nextMadeUpTo === null &&
    nextDue === null &&
    !overdue
  ) {
    return null;
  }
  return { lastMadeUpTo, nextMadeUpTo, nextDue, overdue };
};

const parseConfirmationStatement = (
  raw: CompaniesHouseRawConfirmationStatement | undefined,
): CompaniesHouseConfirmationStatement | null => {
  if (!raw) {
    return null;
  }
  return {
    lastMadeUpTo: nonEmpty(raw.last_made_up_to),
    nextMadeUpTo: nonEmpty(raw.next_made_up_to),
    nextDue: nonEmpty(raw.next_due),
    overdue: raw.overdue ?? false,
  };
};

const parsePreviousName = (
  raw: CompaniesHouseRawPreviousName,
): CompaniesHousePreviousName => ({
  name: raw.name,
  effectiveFrom: nonEmpty(raw.effective_from),
  ceasedOn: nonEmpty(raw.ceased_on),
});

const profileUrl = (companyNumber: string): string =>
  `${COMPANIES_HOUSE_PROFILE_URL}${encodeURIComponent(companyNumber)}`;

export const parseCompanyProfile = (
  raw: CompaniesHouseRawCompanyProfile,
): CompaniesHouseCompany => ({
  companyNumber: raw.company_number,
  name: raw.company_name,
  status: parseStatus(raw),
  statusDetail: nonEmpty(raw.company_status_detail),
  type: nonEmpty(raw.type),
  subtype: nonEmpty(raw.subtype),
  jurisdiction: nonEmpty(raw.jurisdiction),
  dateOfCreation: nonEmpty(raw.date_of_creation),
  dateOfCessation: nonEmpty(raw.date_of_cessation),
  registeredOfficeAddress: raw.registered_office_address
    ? parseAddress(raw.registered_office_address)
    : null,
  serviceAddress: raw.service_address
    ? parseAddress(raw.service_address)
    : null,
  sicCodes: raw.sic_codes ?? [],
  accounts: parseAccounts(raw.accounts),
  confirmationStatement: parseConfirmationStatement(raw.confirmation_statement),
  hasCharges: raw.has_charges ?? null,
  hasInsolvencyHistory: raw.has_insolvency_history ?? null,
  hasBeenLiquidated: raw.has_been_liquidated ?? null,
  previousNames: (raw.previous_company_names ?? []).map(parsePreviousName),
  registryUrl: profileUrl(raw.company_number),
});

// ---------------------------------------------------------------------------
// Search result parsing
// ---------------------------------------------------------------------------

const parseSearchStatus = (
  raw: CompaniesHouseRawSearchItem,
): CompaniesHouseEntityStatus => {
  // Build a minimal profile-shaped payload to reuse `parseStatus`.
  // Search rows carry the same `company_status` enum and a direct
  // `date_of_cessation` field, so the same enum mapper applies.
  const profile: CompaniesHouseRawCompanyProfile = {
    company_name: "",
    company_number: "",
  };
  if (raw.company_status !== undefined) {
    profile.company_status = raw.company_status;
  }
  if (raw.date_of_cessation !== undefined) {
    profile.date_of_cessation = raw.date_of_cessation;
  }
  return parseStatus(profile);
};

export const parseSearchItem = (
  raw: CompaniesHouseRawSearchItem,
): CompaniesHouseSearchResult => ({
  companyNumber: raw.company_number,
  name: raw.title,
  status: parseSearchStatus(raw),
  type: nonEmpty(raw.company_type),
  dateOfCreation: nonEmpty(raw.date_of_creation),
  dateOfCessation: nonEmpty(raw.date_of_cessation),
  // Prefer the upstream-formatted snippet; fall back to composing one
  // from the structured `address` block when present. Search rows
  // routinely set only `address_snippet`.
  address:
    nonEmpty(raw.address_snippet) ??
    (raw.address ? parseAddress(raw.address).textAddress : null),
  registryUrl: profileUrl(raw.company_number),
});

export const parseSearchResponse = (
  raw: CompaniesHouseRawSearchResponse,
): CompaniesHouseSearchResult[] => (raw.items ?? []).map(parseSearchItem);

// ---------------------------------------------------------------------------
// Officer parsing
// ---------------------------------------------------------------------------

const pickOfficerAddress = (
  raw: CompaniesHouseRawOfficer,
): CompaniesHouseAddress | null => {
  if (raw.address) {
    return parseAddress(raw.address);
  }
  if (raw.principal_office_address) {
    return parseAddress(raw.principal_office_address);
  }
  return null;
};

export const parseOfficer = (
  raw: CompaniesHouseRawOfficer,
): CompaniesHouseOfficer => {
  const month = parseIntOrNull(raw.date_of_birth?.month);
  const year = parseIntOrNull(raw.date_of_birth?.year);
  // We only surface month + year when BOTH are present and valid;
  // half-populated DOBs are useless and risk implying a precision the
  // upstream did not provide.
  const dateOfBirth =
    month !== null && year !== null && month >= 1 && month <= 12
      ? { month, year }
      : null;
  const ident = raw.identification;
  return {
    name: raw.name,
    role: {
      code: raw.officer_role,
      // Companies House surfaces a human title via the
      // api-enumerations bundle, not the JSON; consumers that need a
      // localised title look the code up against that file. We carry
      // null here rather than echoing the raw code as a title.
      title: null,
    },
    appointedOn: nonEmpty(raw.appointed_on),
    // Pre-1992 officers carry their appointment as a bound date rather
    // than an exact day (`is_pre_1992_appointment: true`). Surfacing
    // `appointedOn` as null without `appointedBefore` would falsely
    // imply Companies House had no appointment data on file.
    appointedBefore: nonEmpty(raw.appointed_before),
    resignedOn: nonEmpty(raw.resigned_on),
    isResigned: Boolean(nonEmpty(raw.resigned_on)),
    occupation: nonEmpty(raw.occupation),
    nationality: nonEmpty(raw.nationality),
    countryOfResidence: nonEmpty(raw.country_of_residence),
    // Corporate / managing officers for registered-overseas entities
    // ship their location as `principal_office_address` instead of
    // the usual correspondence `address` — both are documented and
    // mutually exclusive in practice.
    address: pickOfficerAddress(raw),
    dateOfBirth,
    identification: ident
      ? {
          type: nonEmpty(ident.identification_type),
          legalAuthority: nonEmpty(ident.legal_authority),
          legalForm: nonEmpty(ident.legal_form),
          placeRegistered: nonEmpty(ident.place_registered),
          registrationNumber: nonEmpty(ident.registration_number),
        }
      : null,
  };
};

export const parseOfficersResponse = (
  raw: CompaniesHouseRawOfficersResponse,
): CompaniesHouseOfficer[] => (raw.items ?? []).map(parseOfficer);
