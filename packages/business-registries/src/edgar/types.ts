// ---------------------------------------------------------------------------
// Raw SEC EDGAR submissions API response shapes
// (https://data.sec.gov/submissions/CIK{padded10}.json)
//
// EDGAR ships JSON with a stable shape but a wide surface — most
// fields are nullable, may be the empty string, or may be omitted
// entirely. Only the fields the domain layer consumes are typed
// here; the parser tolerates absent keys.
// ---------------------------------------------------------------------------

export type EdgarRawAddress = {
  street1?: string | null;
  street2?: string | null;
  city?: string | null;
  stateOrCountry?: string | null;
  zipCode?: string | null;
  stateOrCountryDescription?: string | null;
  isForeignLocation?: number | null;
  foreignStateTerritory?: string | null;
  country?: string | null;
  countryCode?: string | null;
};

export type EdgarRawAddresses = {
  mailing?: EdgarRawAddress;
  business?: EdgarRawAddress;
};

export type EdgarRawFormerName = {
  name: string;
  from?: string | null;
  to?: string | null;
};

// `filings.recent` is a columnar (structure-of-arrays) layout: each
// field is an array, and entry `i` of the filing lives at index `i`
// in every array. The parser zips these into per-filing records.
export type EdgarRawRecentFilings = {
  accessionNumber?: string[];
  filingDate?: string[];
  reportDate?: string[];
  acceptanceDateTime?: string[];
  form?: string[];
  primaryDocument?: string[];
  primaryDocDescription?: string[];
};

export type EdgarRawFilings = {
  recent?: EdgarRawRecentFilings;
};

export type EdgarRawSubmission = {
  cik: string;
  entityType?: string;
  sic?: string;
  sicDescription?: string;
  name: string;
  tickers?: string[];
  exchanges?: string[];
  ein?: string;
  category?: string;
  fiscalYearEnd?: string;
  stateOfIncorporation?: string;
  addresses?: EdgarRawAddresses;
  formerNames?: EdgarRawFormerName[];
  filings?: EdgarRawFilings;
};

// ---------------------------------------------------------------------------
// Domain output types
// ---------------------------------------------------------------------------

export type EdgarAddress = {
  street: string | null;
  city: string | null;
  region: string | null;
  postalCode: string | null;
  country: string | null;
  textAddress: string | null;
};

export type EdgarFiling = {
  accessionNumber: string;
  form: string;
  filingDate: string;
  reportDate: string | null;
  acceptanceDateTime: string | null;
  primaryDocument: string | null;
  primaryDocDescription: string | null;
};

export type EdgarFormerName = {
  name: string;
  from: string | null;
  to: string | null;
};

// SEC entity-status surface. EDGAR keeps every issuer it has ever
// listed forever, including delisted, dissolved, and shell companies,
// but the submissions feed does not prove a lifecycle event. We only
// mark fresh operating filers as active; stale filing history is a
// review signal rather than a delisting inference.
export type EdgarEntityStatus =
  | { type: "active" }
  | { type: "stale"; lastFilingDate: string }
  | { type: "unknown" };

export type EdgarCompany = {
  cik: string;
  name: string;
  sic: string | null;
  sicDescription: string | null;
  tickers: string[];
  exchanges: string[];
  ein: string | null;
  addresses: {
    mailing: EdgarAddress | null;
    business: EdgarAddress | null;
  };
  formerNames: EdgarFormerName[];
  recentFilings: EdgarFiling[];
  status: EdgarEntityStatus;
  registryUrl: string;
};
