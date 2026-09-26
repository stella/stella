// ---------------------------------------------------------------------------
// Raw Slovak Register právnických osôb, podnikateľov a orgánov verejnej moci
// (RPO) JSON shapes, operated by the Statistical Office of the Slovak Republic.
//
// Endpoints: https://api.statistics.sk/rpo/v1/search (IČO or name search) +
//            https://api.statistics.sk/rpo/v1/entity/{id} (full record).
//
// The API omits every attribute whose value is null, so every field is
// optional. Time-bounded records carry `validFrom` and, once superseded,
// `validTo`; a record without `validTo` is in force.
// ---------------------------------------------------------------------------

export type RpoRawCodeValue = {
  value?: string;
  code?: string;
  codelistCode?: string;
};

export type RpoRawTimed = {
  validFrom?: string;
  validTo?: string;
};

export type RpoRawTimedValue = RpoRawTimed & {
  value?: string;
};

export type RpoRawTimedCodeValue = RpoRawTimed & {
  value?: RpoRawCodeValue;
};

export type RpoRawAddress = RpoRawTimed & {
  formatedAddress?: string;
  street?: string;
  regNumber?: number;
  buildingNumber?: string;
  postalCodes?: string[];
  municipality?: RpoRawCodeValue;
  country?: RpoRawCodeValue;
  district?: RpoRawCodeValue;
};

export type RpoRawPersonName = {
  formatedName?: string;
  givenNames?: string[];
  familyNames?: string[];
  prefixes?: RpoRawCodeValue[];
  postfixes?: RpoRawCodeValue[];
};

/** A statutory-body member or another stakeholder (shareholder, proxy, ...). */
export type RpoRawStakeholder = RpoRawTimed & {
  stakeholderType?: RpoRawCodeValue;
  statutoryBodyMember?: RpoRawCodeValue;
  address?: RpoRawAddress;
  personName?: RpoRawPersonName;
  identifier?: string;
  fullName?: string;
};

export type RpoRawEquity = RpoRawTimed & {
  value?: number;
  valuePaid?: number;
  currency?: RpoRawCodeValue;
};

export type RpoRawSourceRegister = {
  value?: RpoRawCodeValue;
  registrationOffices?: RpoRawTimedValue[];
  registrationNumbers?: RpoRawTimedValue[];
};

/** A legal predecessor or successor. */
export type RpoRawRelatedEntity = RpoRawTimed & {
  identifier?: string;
  fullName?: string;
};

export type RpoRawActivity = RpoRawTimed & {
  economicActivityDescription?: string;
};

export type RpoRawStatisticalCodes = {
  mainActivity?: RpoRawCodeValue;
};

export type RpoRawSearchHit = {
  id: number;
  identifiers?: RpoRawTimedValue[];
  fullNames?: RpoRawTimedValue[];
  addresses?: RpoRawAddress[];
  establishment?: string;
  termination?: string;
  sourceRegister?: RpoRawSourceRegister;
};

export type RpoRawSearchResponse = {
  results: RpoRawSearchHit[];
};

export type RpoRawEntity = RpoRawSearchHit & {
  legalForms?: RpoRawTimedCodeValue[];
  legalStatuses?: RpoRawTimedCodeValue[];
  activities?: RpoRawActivity[];
  statutoryBodies?: RpoRawStakeholder[];
  stakeholders?: RpoRawStakeholder[];
  authorizations?: RpoRawTimedValue[];
  equities?: RpoRawEquity[];
  predecessors?: RpoRawRelatedEntity[];
  successors?: RpoRawRelatedEntity[];
  statisticalCodes?: RpoRawStatisticalCodes;
};

// ---------------------------------------------------------------------------
// Domain output types
// ---------------------------------------------------------------------------

/**
 * Which records an entity payload was requested with. `current` holds only
 * the records in force; `historical` adds every superseded record, so the
 * `validTo` of a person, activity, or capital entry can be set.
 */
export type RpoView = "current" | "historical";

export type RpoDated<Value> = {
  value: Value;
  validFrom: string | null;
  validTo: string | null;
};

export type RpoCodedValue = {
  code: string | null;
  label: string;
};

export type RpoAddress = {
  street: string | null;
  postalCode: string | null;
  city: string | null;
  country: string | null;
  textAddress: string | null;
};

export type RpoPerson = {
  name: string;
  /** Body or relationship, e.g. "Predstavenstvo", "Spoločník", "Rektor". */
  organName: string | null;
  /** Position within the body, e.g. "Predseda predstavenstva". */
  position: string | null;
  /** IČO when a legal person holds the role. */
  identifier: string | null;
  address: string | null;
  validFrom: string | null;
  validTo: string | null;
};

export type RpoMoney = {
  amount: number;
  currency: string | null;
};

/** The register the RPO record was taken over from, with its file number. */
export type RpoSourceRegister = {
  name: string;
  code: string | null;
  registrationOffice: string | null;
  registrationNumber: string | null;
};

export type RpoRelatedEntity = {
  ico: string | null;
  name: string;
  validFrom: string | null;
};

// `termination` is the canonical end-of-existence signal. Legal-status
// notes (liquidation, dissolution grounds) stay textual in `legalStatuses`.
export type RpoStatus =
  | { type: "active" }
  | { type: "terminated"; terminatedAt: string };

export type RpoEntity = {
  ico: string;
  name: string;
  /** Names the entity carried before, newest first. */
  formerNames: RpoDated<string>[];
  legalForm: RpoCodedValue | null;
  address: RpoAddress | null;
  /** Seats the entity had before, newest first. */
  formerAddresses: RpoDated<RpoAddress>[];
  establishedAt: string | null;
  terminatedAt: string | null;
  status: RpoStatus;
  legalStatuses: string[];
  sourceRegister: RpoSourceRegister | null;
  statutoryBodies: RpoPerson[];
  stakeholders: RpoPerson[];
  /** Filed wording on how the entity acts (acting clause, procuration). */
  authorizations: RpoDated<string>[];
  shareCapital: RpoMoney | null;
  shareCapitalPaid: RpoMoney | null;
  activities: RpoDated<string>[];
  mainActivity: RpoCodedValue | null;
  predecessors: RpoRelatedEntity[];
  successors: RpoRelatedEntity[];
  /** Public API record the data was read from. */
  registryUrl: string;
};

export type RpoSearchResult = {
  rpoId: number;
  ico: string;
  name: string;
  address: string | null;
  sourceRegister: string | null;
  status: RpoStatus;
};
