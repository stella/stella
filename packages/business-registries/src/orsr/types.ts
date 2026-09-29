// ---------------------------------------------------------------------------
// Raw Slovak Obchodný register (Ministry of Justice) JSON shapes.
//
// Endpoint: https://sluzby.orsr.sk/api/legal-person (search) +
//           https://sluzby.orsr.sk/api/legal-person/extract (full record).
//
// The upstream payload is a verbatim XML→JSON projection of an internal
// XSD; many fields use the `{item: ...}` or `{item: {codelistItem: ...}}`
// wrapping that the XML schema generated. Only the fields the parser
// consumes today are typed. Extend as new fields are surfaced.
// ---------------------------------------------------------------------------

export type OrsrRawCodelistItem = {
  itemCode?: string;
  itemName?: string;
};

export type OrsrRawCodelistRef = {
  codelistCode?: string;
  codelistItem?: OrsrRawCodelistItem;
};

export type OrsrRawWrappedCodelist = {
  item?: OrsrRawCodelistRef | string;
};

// Common envelope wrapping every historical record on the corporate body
// (legal form, address, equity, statutory body, ...). `current === true`
// marks the record the registry treats as in force; superseded versions
// stay in the array for the audit trail.
export type OrsrRawTemporal = {
  current?: boolean;
  effectiveFrom?: string;
  effectiveTo?: string;
  effectiveToSpecified?: boolean;
};

export type OrsrRawValueTemporal = OrsrRawTemporal & {
  value?: string;
};

export type OrsrRawLegalForm = OrsrRawTemporal & {
  item?: OrsrRawCodelistRef;
};

export type OrsrRawDeliveryAddress = {
  postalCode?: string;
  postOfficeBox?: string;
  recipient?: string;
};

export type OrsrRawAddress = OrsrRawTemporal & {
  addressLine?: string;
  country?: OrsrRawWrappedCodelist;
  region?: OrsrRawWrappedCodelist;
  county?: OrsrRawWrappedCodelist;
  municipality?: OrsrRawWrappedCodelist;
  district?: OrsrRawWrappedCodelist;
  streetName?: string;
  buildingNumber?: string;
  propertyRegistrationNumber?: string;
  deliveryAddress?: OrsrRawDeliveryAddress;
};

export type OrsrRawCurrency = {
  item?: OrsrRawCodelistRef | string;
};

export type OrsrRawEquity = OrsrRawTemporal & {
  currency?: OrsrRawCurrency;
  equityValue?: number;
  equityValueSpecified?: boolean;
  equityValuePaid?: number;
  equityValuePaidSpecified?: boolean;
};

export type OrsrRawDeposit = OrsrRawTemporal & {
  stakeholder?: OrsrRawValueTemporal[];
  depositValue?: number | null;
  depositPayedValue?: number | null;
  currency?: OrsrRawCurrency;
};

export type OrsrRawIdentifier = OrsrRawTemporal & {
  identifierType?: OrsrRawWrappedCodelist;
  identifierValue?: string;
};

export type OrsrRawPersonName = {
  formattedName?: string;
  legalName?: string;
};

export type OrsrRawPhysicalPerson = {
  personName?: OrsrRawPersonName;
};

export type OrsrRawCorporateBodyRef = {
  corporateBodyFullName?: string;
};

export type OrsrRawPersonData = {
  physicalPerson?: OrsrRawPhysicalPerson | null;
  corporateBody?: OrsrRawCorporateBodyRef | null;
  physicalAddress?: OrsrRawAddress[];
  id?: OrsrRawIdentifier[];
};

export type OrsrRawStatutoryBodyMember = OrsrRawTemporal & {
  personData?: OrsrRawPersonData;
  function?: string | null;
  functionCreationDate?: string | null;
  functionTerminationDate?: string | null;
};

export type OrsrRawStakeholderMember = OrsrRawTemporal & {
  stakeholderType?: OrsrRawWrappedCodelist;
  personData?: OrsrRawPersonData;
  function?: string | null;
  functionCreationDate?: string | null;
  functionTerminationDate?: string | null;
};

export type OrsrRawStatutoryBodyType = OrsrRawValueTemporal;

export type OrsrRawAuthorization = OrsrRawValueTemporal;

// A legal-status event (merger, dissolution, liquidation) recorded on the
// full extract.
type OrsrRawLegalStatusEvent = OrsrRawTemporal & {
  type?: string | null;
  text?: string | null;
};

export type OrsrRawCorporateBody = {
  legalStatusEvents?: OrsrRawLegalStatusEvent[];
  corporateBodyFullName?: OrsrRawValueTemporal[];
  legalForm?: OrsrRawLegalForm[];
  establishment?: string;
  termination?: string | null;
  equity?: OrsrRawEquity[];
  deposits?: OrsrRawDeposit[];
  statutoryBodyType?: OrsrRawStatutoryBodyType[];
  statutoryBody?: OrsrRawStatutoryBodyMember[];
  authorizationToExecute?: OrsrRawAuthorization[];
  stakeholder?: OrsrRawStakeholderMember[];
};

export type OrsrRawLegalPerson = {
  corporateBody?: OrsrRawCorporateBody;
  physicalAddress?: OrsrRawAddress[];
  id?: OrsrRawIdentifier[];
};

export type OrsrRawFileReference = {
  section?: string;
  insertNumber?: number | string;
  court?: string;
  formattedValueSpaced?: string;
  formattedValueUrlSafe?: string;
};

export type OrsrRawExtractResponse = {
  createDateTime?: string;
  dataSyncDate?: string;
  fileReference?: OrsrRawFileReference;
  legalForm?: string;
  courtName?: string;
  legalPerson?: OrsrRawLegalPerson;
};

export type OrsrRawSearchHit = {
  id: number;
  section?: number | string;
  insertNumber?: number | string;
  court?: number | string;
  fileReference?: OrsrRawFileReference;
  corporateBodyFullName?: string;
  corporateBodyFullNames?: string[];
  registrationNumber?: string;
  physicalAddressLine1?: string;
  physicalAddressLine2?: string;
  documentsCount?: number;
  physicalPersonName?: string | null;
};

export type OrsrRawSearchResponse = {
  filteredCount?: number;
  data?: OrsrRawSearchHit[];
};

/** One filed document (`/legal-person/documents`, the collection of deeds). */
export type OrsrRawDocument = {
  serialNumber?: number;
  name?: string;
  type?: number;
  deliveryDate?: string;
  pageCount?: number;
  isElectronic?: boolean;
};

/**
 * One row of `/legal-person/related`. The register's own portal reads these
 * fields from each row; every entity probed while building the adapter
 * returned an empty list.
 */
export type OrsrRawRelatedHit = {
  corporateBodyFullName?: string;
  registrationNumber?: string;
  physicalAddressLine1?: string;
  physicalAddressLine2?: string;
  relatedPersonName?: string | null;
  fileReference?: OrsrRawFileReference;
};

export type OrsrRawRelatedResponse = {
  filteredCount?: number;
  data?: OrsrRawRelatedHit[];
};

export type OrsrRawErrorResponse = {
  title?: string;
  errors?: Record<string, unknown>;
};

// ---------------------------------------------------------------------------
// Domain output types
// ---------------------------------------------------------------------------

export type OrsrAddress = {
  street: string | null;
  postalCode: string | null;
  city: string | null;
  country: string | null;
  textAddress: string | null;
};

export type OrsrCourtFile = {
  /** Trade-register court abbreviation (e.g. "B" = Mestský súd Bratislava III). */
  court: string;
  /** Full court name supplied by the extract endpoint. */
  courtName: string | null;
  /** Register section, e.g. "Sro", "Sa". */
  section: string;
  /** Insert (vložka) number — globally unique within (section, court). */
  insertNumber: string;
};

export type OrsrStatutoryMember = {
  name: string;
  position: string | null;
  /** Address rendered as a single line, or `null` when the registry omitted it. */
  address: string | null;
  since: string | null;
};

export type OrsrStatutoryBody = {
  organName: string;
  members: OrsrStatutoryMember[];
};

export type OrsrStakeholder = {
  /** Mapped Slovak organ heading (e.g. "Spoločníci", "Dozorná rada"). */
  organName: string;
  /** Mapped Slovak role label (e.g. "Spoločník", "Akcionár"). */
  position: string;
  name: string;
  address: string | null;
  identifier: string | null;
  /** `Výška vkladu / Rozsah splatenia` summary for shareholders, when present. */
  share: string | null;
};

// Status discriminated union — `termination` presence on the upstream
// corporate body is the canonical signal. The `unknown` arm covers
// records where the extract payload is missing or malformed.
export type OrsrCompanyStatus =
  | { type: "active" }
  | { type: "terminated"; terminatedAt: string }
  | { type: "unknown" };

export type OrsrCompany = {
  ico: string;
  name: string;
  legalForm: string | null;
  address: OrsrAddress | null;
  courtFile: OrsrCourtFile | null;
  establishedAt: string | null;
  terminatedAt: string | null;
  /** `Výška vkladu` (registered share capital), formatted with currency. */
  shareCapital: string | null;
  /** `Rozsah splatenia` (paid-up portion), formatted with currency. */
  shareCapitalPaid: string | null;
  /** `Spôsob konania` (acting clause) describing how the entity binds itself. */
  actingClause: string | null;
  status: OrsrCompanyStatus;
  statutoryBodies: OrsrStatutoryBody[];
  stakeholders: OrsrStakeholder[];
  /** Deep link to the public `sluzby.orsr.sk/Subjekt` portal page. */
  registryUrl: string;
};

export type OrsrSearchResult = {
  ico: string;
  name: string;
  address: string | null;
};

/** The trade-register file an entity is filed under, e.g. `Sro 3586/B`. */
export type OrsrFileReference = Pick<
  OrsrCourtFile,
  "court" | "section" | "insertNumber"
>;

type OrsrHistoryDates = {
  validFrom: string | null;
  validTo: string | null;
};

/**
 * A superseded entry of the full extract: a record the register closed with
 * an end date (a former name, seat, officer, shareholder, capital, ...).
 */
export type OrsrHistoryEntry =
  | (OrsrHistoryDates & {
      kind:
        | "name"
        | "legal-form"
        | "address"
        | "share-capital"
        | "acting-clause"
        | "legal-status";
      value: string;
    })
  | (OrsrHistoryDates & {
      kind: "statutory-body-member" | "stakeholder";
      name: string;
      role: string | null;
    });

type OrsrDocumentMedium = "electronic" | "paper";

/** A document filed in the collection of deeds (zbierka listín). */
export type OrsrDocument = {
  serialNumber: number;
  name: string;
  /** Register's document type code, as the portal lists it (`typ`). */
  typeCode: number | null;
  deliveredOn: string | null;
  pageCount: number | null;
  medium: OrsrDocumentMedium;
};

/** A legal person the register links to this entity. */
export type OrsrRelatedLegalPerson = {
  name: string;
  ico: string | null;
  address: string | null;
  /** The person through whom the entities are connected. */
  connectedThrough: string | null;
  fileReference: OrsrFileReference | null;
};

/**
 * A supplementary part of the full record, fetched on its own request. A
 * failed part does not fail the lookup; it states why it is missing.
 */
export type OrsrRecordPart<Value> =
  | { status: "loaded"; value: Value }
  | { status: "unavailable"; reason: string };

/** The current extract plus the register's history, filings, and links. */
export type OrsrFullRecord = {
  company: OrsrCompany;
  history: OrsrRecordPart<OrsrHistoryEntry[]>;
  documents: OrsrRecordPart<OrsrDocument[]>;
  related: OrsrRecordPart<OrsrRelatedLegalPerson[]>;
};
