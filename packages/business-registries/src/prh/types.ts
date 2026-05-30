// ---------------------------------------------------------------------------
// Raw PRH AvoinData v3 response shapes
// (https://avoindata.prh.fi/ytj_en.html — REST endpoint, CC BY 4.0)
//
// Only the fields we surface today are typed. The PRH payload is much
// richer (registeredEntries, companySituations, websites, …); extend
// these declarations as we promote more fields into the domain output.
// ---------------------------------------------------------------------------

export type PrhRawLocalizedDescription = {
  languageCode: string;
  description: string;
};

export type PrhRawSourcedValue = {
  value: string;
  registrationDate?: string;
  endDate?: string;
  source: string;
};

export type PrhRawName = {
  name: string;
  type: string;
  registrationDate?: string;
  endDate?: string;
  version: number;
  source: string;
};

export type PrhRawCompanyForm = {
  type: string;
  descriptions: PrhRawLocalizedDescription[];
  registrationDate?: string;
  endDate?: string;
  version: number;
  source: string;
};

export type PrhRawBusinessLine = {
  type: string;
  descriptions: PrhRawLocalizedDescription[];
  typeCodeSet: string;
  registrationDate?: string;
  endDate?: string;
  source: string;
};

export type PrhRawPostOffice = {
  city: string;
  languageCode: string;
  municipalityCode?: string;
};

// `type` on addresses is a number (1 = street, 2 = postal), unlike the
// rest of the payload where discriminators are stringified digits.
//
// PRH supplies street addresses via two mutually exclusive shapes:
//
//   * structured atoms (`street` + `buildingNumber` + `entrance` + ...),
//     used for the vast majority of Finnish-registered entities; and
//   * a free-form `freeAddressLine`, used for foreign addresses and
//     for entries the registrar received as opaque strings (most
//     visible on overseas branches).
//
// Both surfaces feed the same `PrhAddress.textAddress` field — the
// raw schema keeps both arms typed so the parser can fall back.
export type PrhRawAddress = {
  type: number;
  street?: string;
  postCode?: string;
  postOffices?: PrhRawPostOffice[];
  postOfficeBox?: string;
  buildingNumber?: string;
  entrance?: string;
  apartmentNumber?: string;
  apartmentIdSuffix?: string;
  co?: string;
  country?: string;
  freeAddressLine?: string;
  registrationDate?: string;
  endDate?: string;
  source: string;
};

export type PrhRawCompanySituation = {
  type: string;
  descriptions: PrhRawLocalizedDescription[];
  registrationDate?: string;
  endDate?: string;
  source: string;
};

export type PrhRawCompany = {
  businessId: PrhRawSourcedValue;
  euId?: PrhRawSourcedValue;
  // Optional per the v3 schema even though every Finnish-registered
  // entity we have observed populates it. Foreign / minimal entries
  // can arrive without a names array; the parser falls back to the
  // business ID so a missing list does not produce a 500.
  names?: PrhRawName[];
  mainBusinessLine?: PrhRawBusinessLine;
  companyForms?: PrhRawCompanyForm[];
  companySituations?: PrhRawCompanySituation[];
  addresses?: PrhRawAddress[];
  // Top-level `status` values: "1" = unregistered, "2" = registered,
  // "3" = ended. `tradeRegisterStatus` mirrors the trade-register
  // membership: "1" = registered, "2" = not. Both surfaced separately
  // because they answer different questions.
  status: string;
  tradeRegisterStatus?: string;
  registrationDate?: string;
  endDate?: string;
  lastModified?: string;
};

export type PrhCompaniesResponse = {
  totalResults: number;
  companies: PrhRawCompany[];
};

export type PrhErrorResponse = {
  timestamp?: string;
  message?: string;
  errorcode?: number;
};

// ---------------------------------------------------------------------------
// Domain output types
// ---------------------------------------------------------------------------

export type PrhAddress = {
  street: string | null;
  postalCode: string | null;
  city: string | null;
  country: string | null;
  textAddress: string | null;
};

export type PrhBusinessLine = {
  code: string;
  description: string | null;
};

// Status discriminated union — same shape as Brreg's, mapped from
// PRH's numeric `status` field plus optional `endDate`. PRH does not
// expose a dedicated bankruptcy flag in v3 (it lives in
// `companySituations`), so we leave that to a future enrichment pass
// rather than fake it here.
export type PrhCompanyStatus =
  | { type: "registered" }
  | { type: "unregistered" }
  | { type: "ended"; endedAt: string | null };

export type PrhCompanyName = {
  name: string;
  isCurrent: boolean;
};

export type PrhCompany = {
  businessId: string;
  name: string;
  // Trade name and parallel names PRH lists alongside the primary
  // name. Empty when the entity has no aliases on file.
  alternateNames: PrhCompanyName[];
  legalForm: string | null;
  legalFormCode: string | null;
  streetAddress: PrhAddress | null;
  postalAddress: PrhAddress | null;
  mainBusinessLine: PrhBusinessLine | null;
  status: PrhCompanyStatus;
  tradeRegisterRegistered: boolean;
  registeredAt: string | null;
  endedAt: string | null;
  registryUrl: string;
};

export type PrhSearchResult = {
  businessId: string;
  name: string;
  address: string | null;
};
