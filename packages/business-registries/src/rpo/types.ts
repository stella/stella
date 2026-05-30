// ---------------------------------------------------------------------------
// Raw RPO v1 response shapes
// (https://api.statistics.sk/rpo/v1/ — REST endpoint, CC BY 4.0)
//
// Only the fields we surface today are typed. The RPO payload is much
// richer (otherLegalFacts, authorizations, equities, deposits,
// predecessors, statisticalCodes, …); extend these declarations as we
// promote more fields into the domain output.
// ---------------------------------------------------------------------------

/** Codelist-backed value entries — most RPO enums look like this. */
export type RpoCodelistValue = {
  value: string;
  code?: string;
  codelistCode?: string;
};

/** Time-bounded text or codelist value. `validTo` absent ⇒ current. */
export type RpoValidityWindow = {
  validFrom?: string;
  validTo?: string;
};

export type RpoIdentifier = RpoValidityWindow & {
  value: string;
};

export type RpoName = RpoValidityWindow & {
  value: string;
};

export type RpoAddress = RpoValidityWindow & {
  street?: string;
  regNumber?: number;
  buildingNumber?: string;
  postalCodes?: string[];
  municipality?: RpoCodelistValue;
  country?: RpoCodelistValue;
};

export type RpoLegalForm = RpoValidityWindow & {
  value: RpoCodelistValue;
};

export type RpoActivity = RpoValidityWindow & {
  economicActivityDescription?: string;
};

export type RpoPersonName = {
  formatedName?: string;
  familyNames?: string[];
  givenNames?: string[];
};

export type RpoStatutoryBody = RpoValidityWindow & {
  stakeholderType?: RpoCodelistValue;
  address?: RpoAddress;
  personName?: RpoPersonName;
};

export type RpoRegistrationOffice = RpoValidityWindow & {
  value: string;
};

export type RpoRegistrationNumber = RpoValidityWindow & {
  value: string;
};

export type RpoSourceRegister = {
  value?: RpoCodelistValue;
  registrationOffices?: RpoRegistrationOffice[];
  registrationNumbers?: RpoRegistrationNumber[];
};

export type RpoStatisticalCodes = {
  statCodesActualization?: string;
  mainActivity?: RpoCodelistValue;
  esa2010?: RpoCodelistValue;
};

// Top-level entity record. Returned in two shapes:
//   * the search payload (`/v1/search`) embeds a thin row with a
//     subset of fields (identifiers, fullNames, addresses, sourceRegister);
//   * the detail payload (`/v1/entity/{id}`) returns the full record
//     including statutoryBodies, activities, legalForms, etc.
// Both share the same field names, so a single type covers both with
// the bulk of the fields marked optional.
export type RpoRawEntity = {
  id: number;
  dbModificationDate?: string;
  identifiers: RpoIdentifier[];
  fullNames?: RpoName[];
  addresses?: RpoAddress[];
  legalForms?: RpoLegalForm[];
  activities?: RpoActivity[];
  statutoryBodies?: RpoStatutoryBody[];
  sourceRegister?: RpoSourceRegister;
  statisticalCodes?: RpoStatisticalCodes;
  establishment?: string;
  /** ISO date when the entity was struck off the register. */
  termination?: string;
};

export type RpoSearchResponse = {
  results: RpoRawEntity[];
  license?: string;
};

export type RpoErrorResponse = {
  code?: number;
  message?: string;
};

// ---------------------------------------------------------------------------
// Domain output types
// ---------------------------------------------------------------------------

export type RpoDomainAddress = {
  street: string | null;
  postalCode: string | null;
  city: string | null;
  country: string | null;
  textAddress: string | null;
};

export type RpoDomainName = {
  name: string;
  isCurrent: boolean;
};

export type RpoDomainActivity = {
  description: string;
  registeredAt: string | null;
};

export type RpoDomainStatutoryBody = {
  role: string | null;
  personName: string | null;
  address: RpoDomainAddress | null;
};

export type RpoDomainCourtFile = {
  court: string | null;
  fileNumber: string | null;
};

// Status discriminated union — mapped from RPO's optional `termination`
// date. RPO does not expose a richer status enum (no bankruptcy /
// liquidation flag in the v1 surface), so the boundary representation
// stays minimal: present termination date ⇒ dissolved, otherwise
// registered. The `unknown` arm is reserved for future codelist
// additions to prevent silent misclassification.
export type RpoCompanyStatus =
  | { type: "registered" }
  | { type: "dissolved"; dissolvedAt: string | null }
  | { type: "unknown" };

export type RpoCompany = {
  /** 8-digit IČO. */
  ico: string;
  name: string;
  /** Historical and parallel names; primary current name is `name`. */
  alternateNames: RpoDomainName[];
  legalForm: string | null;
  legalFormCode: string | null;
  address: RpoDomainAddress | null;
  /** Trade-register file (court + Sro/Sa file number) when present. */
  courtFile: RpoDomainCourtFile | null;
  /** Most recent statisticalCodes.mainActivity (SK NACE). */
  mainActivity: { code: string; description: string | null } | null;
  /** Trade activities (živnosti). May be empty. */
  activities: RpoDomainActivity[];
  statutoryBodies: RpoDomainStatutoryBody[];
  status: RpoCompanyStatus;
  establishedAt: string | null;
  dissolvedAt: string | null;
  registryUrl: string;
};

export type RpoSearchResult = {
  ico: string;
  name: string;
  address: string | null;
};
