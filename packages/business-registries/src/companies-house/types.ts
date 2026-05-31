// ---------------------------------------------------------------------------
// Raw Companies House API response shapes
// (https://api.company-information.service.gov.uk/)
//
// Companies House ships JSON with a stable, documented shape but a
// wide surface — most fields are optional, some are deprecated, and
// every nested resource may be absent depending on the entity type
// (private limited, LLP, overseas, dissolved, …). Only the fields the
// domain layer consumes are typed here; the parser tolerates absent
// keys.
//
// See: https://developer-specs.company-information.service.gov.uk/companies-house-public-data-api/resources/companyprofile
// ---------------------------------------------------------------------------

export type CompaniesHouseRawAddress = {
  address_line_1?: string;
  address_line_2?: string;
  care_of?: string;
  country?: string;
  locality?: string;
  po_box?: string;
  postal_code?: string;
  premises?: string;
  region?: string;
};

export type CompaniesHouseRawAccounts = {
  next_due?: string;
  next_made_up_to?: string;
  last_accounts?: {
    made_up_to?: string;
    period_start_on?: string;
    period_end_on?: string;
    type?: string;
  };
  next_accounts?: {
    due_on?: string;
    period_start_on?: string;
    period_end_on?: string;
    overdue?: boolean;
  };
  accounting_reference_date?: {
    day?: string | number;
    month?: string | number;
  };
  overdue?: boolean;
};

export type CompaniesHouseRawConfirmationStatement = {
  last_made_up_to?: string;
  next_due?: string;
  next_made_up_to?: string;
  overdue?: boolean;
};

export type CompaniesHouseRawPreviousName = {
  name: string;
  effective_from?: string;
  ceased_on?: string;
};

export type CompaniesHouseRawCompanyProfile = {
  company_name: string;
  company_number: string;
  company_status?: string;
  company_status_detail?: string;
  date_of_creation?: string;
  date_of_cessation?: string;
  jurisdiction?: string;
  type?: string;
  subtype?: string;
  sic_codes?: string[];
  has_charges?: boolean;
  has_insolvency_history?: boolean;
  has_been_liquidated?: boolean;
  registered_office_address?: CompaniesHouseRawAddress;
  service_address?: CompaniesHouseRawAddress;
  accounts?: CompaniesHouseRawAccounts;
  confirmation_statement?: CompaniesHouseRawConfirmationStatement;
  previous_company_names?: CompaniesHouseRawPreviousName[];
  links?: {
    self?: string;
    filing_history?: string;
    officers?: string;
    charges?: string;
    persons_with_significant_control?: string;
  };
  registered_office_is_in_dispute?: boolean;
  undeliverable_registered_office_address?: boolean;
};

// ---------------------------------------------------------------------------
// Raw search response shapes (`/search/companies?q=`)
// ---------------------------------------------------------------------------

export type CompaniesHouseRawSearchItem = {
  company_number: string;
  title: string;
  company_status?: string;
  company_type?: string;
  date_of_creation?: string;
  date_of_cessation?: string;
  address_snippet?: string;
  address?: CompaniesHouseRawAddress;
  description?: string;
  description_identifier?: string[];
  kind?: string;
  links?: { self?: string };
};

export type CompaniesHouseRawSearchResponse = {
  etag?: string;
  items?: CompaniesHouseRawSearchItem[];
  items_per_page?: number;
  kind?: string;
  start_index?: number;
  total_results?: number;
};

// ---------------------------------------------------------------------------
// Raw officers response shapes (`/company/{number}/officers`)
// ---------------------------------------------------------------------------

export type CompaniesHouseRawOfficerDateOfBirth = {
  // Day is suppressed by Companies House for natural persons; the
  // upstream response carries it for some legacy records, but our
  // parser drops it on the way out so the domain shape never exposes
  // the full birth date of a private individual.
  day?: string | number;
  month?: string | number;
  year?: string | number;
};

export type CompaniesHouseRawOfficer = {
  name: string;
  officer_role: string;
  appointed_on?: string;
  resigned_on?: string;
  occupation?: string;
  nationality?: string;
  country_of_residence?: string;
  date_of_birth?: CompaniesHouseRawOfficerDateOfBirth;
  address?: CompaniesHouseRawAddress;
  principal_office_address?: CompaniesHouseRawAddress;
  identification?: {
    identification_type?: string;
    legal_authority?: string;
    legal_form?: string;
    place_registered?: string;
    registration_number?: string;
  };
  links?: { officer?: { appointments?: string } };
};

export type CompaniesHouseRawOfficersResponse = {
  active_count?: number | string;
  inactive_count?: number | string;
  resigned_count?: number | string;
  items?: CompaniesHouseRawOfficer[];
  items_per_page?: number;
  start_index?: number;
  total_results?: number;
  kind?: string;
  etag?: string;
  links?: { self?: string };
};

// ---------------------------------------------------------------------------
// Domain output types
// ---------------------------------------------------------------------------

export type CompaniesHouseAddress = {
  premises: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  locality: string | null;
  region: string | null;
  postalCode: string | null;
  country: string | null;
  poBox: string | null;
  careOf: string | null;
  textAddress: string | null;
};

export type CompaniesHouseAccounts = {
  nextDue: string | null;
  nextMadeUpTo: string | null;
  lastMadeUpTo: string | null;
  overdue: boolean;
};

export type CompaniesHouseConfirmationStatement = {
  lastMadeUpTo: string | null;
  nextDue: string | null;
  nextMadeUpTo: string | null;
  overdue: boolean;
};

export type CompaniesHousePreviousName = {
  name: string;
  effectiveFrom: string | null;
  ceasedOn: string | null;
};

// Companies House company_status surface; see
// https://github.com/companieshouse/api-enumerations/blob/master/constants.yml
// (`company_status`). Mapping is exhaustive over the documented enum
// values; anything new from upstream falls through to `unknown`.
export type CompaniesHouseEntityStatus =
  | { type: "active" }
  | { type: "dissolved"; dissolvedAt: string | null }
  | { type: "liquidation" }
  | { type: "administration" }
  | { type: "receivership" }
  | { type: "voluntary-arrangement" }
  | { type: "insolvency-proceedings" }
  | { type: "converted-closed"; closedAt: string | null }
  | { type: "open" }
  | { type: "closed" }
  | { type: "registered" }
  | { type: "removed" }
  | { type: "unknown" };

export type CompaniesHouseCompany = {
  companyNumber: string;
  name: string;
  status: CompaniesHouseEntityStatus;
  statusDetail: string | null;
  type: string | null;
  subtype: string | null;
  jurisdiction: string | null;
  dateOfCreation: string | null;
  dateOfCessation: string | null;
  registeredOfficeAddress: CompaniesHouseAddress | null;
  serviceAddress: CompaniesHouseAddress | null;
  sicCodes: string[];
  accounts: CompaniesHouseAccounts | null;
  confirmationStatement: CompaniesHouseConfirmationStatement | null;
  hasCharges: boolean | null;
  hasInsolvencyHistory: boolean | null;
  hasBeenLiquidated: boolean | null;
  previousNames: CompaniesHousePreviousName[];
  registryUrl: string;
};

export type CompaniesHouseSearchResult = {
  companyNumber: string;
  name: string;
  status: CompaniesHouseEntityStatus;
  type: string | null;
  dateOfCreation: string | null;
  dateOfCessation: string | null;
  address: string | null;
  registryUrl: string;
};

export type CompaniesHouseOfficer = {
  name: string;
  role: { code: string; title: string | null };
  appointedOn: string | null;
  resignedOn: string | null;
  isResigned: boolean;
  occupation: string | null;
  nationality: string | null;
  countryOfResidence: string | null;
  address: CompaniesHouseAddress | null;
  /**
   * Birth month and year only. Companies House redacts the day for
   * natural persons; we drop the day on the way out so the domain
   * shape never carries finer granularity than the upstream contract.
   */
  dateOfBirth: { month: number; year: number } | null;
  identification: {
    type: string | null;
    legalAuthority: string | null;
    legalForm: string | null;
    placeRegistered: string | null;
    registrationNumber: string | null;
  } | null;
};
