// ---------------------------------------------------------------------------
// Raw Brreg Enhetsregisteret API response shapes
// (https://data.brreg.no/enhetsregisteret/api/docs/)
// ---------------------------------------------------------------------------

export type BrregRawAddress = {
  land?: string;
  landkode?: string;
  postnummer?: string;
  poststed?: string;
  adresse?: string[];
  kommune?: string;
  kommunenummer?: string;
};

export type BrregRawOrgForm = {
  kode?: string;
  beskrivelse?: string;
};

export type BrregRawNaeringskode = {
  kode?: string;
  beskrivelse?: string;
};

export type BrregRawInstitusjonellSektor = {
  kode?: string;
  beskrivelse?: string;
};

export type BrregRawEnhet = {
  organisasjonsnummer: string;
  navn: string;
  organisasjonsform?: BrregRawOrgForm;
  hjemmeside?: string;
  postadresse?: BrregRawAddress;
  forretningsadresse?: BrregRawAddress;
  /**
   * Physical address of a sub-entity (returned by `/underenheter`).
   * Parent entities (`/enheter`) use `forretningsadresse` instead;
   * sub-entities use this field.
   */
  beliggenhetsadresse?: BrregRawAddress;
  registreringsdatoEnhetsregisteret?: string;
  registrertIMvaregisteret?: boolean;
  registrertIFrivillighetsregisteret?: boolean;
  naeringskode1?: BrregRawNaeringskode;
  naeringskode2?: BrregRawNaeringskode;
  naeringskode3?: BrregRawNaeringskode;
  institusjonellSektorkode?: BrregRawInstitusjonellSektor;
  antallAnsatte?: number;
  konkurs?: boolean;
  konkursdato?: string;
  underAvvikling?: boolean;
  underAvviklingDato?: string;
  underTvangsavviklingEllerTvangsopplosning?: boolean;
  // Brreg splits "compulsory liquidation" into four reason-specific
  // date fields rather than a single `tvangsopplosningDato`. We treat
  // the first populated one as the opening date of the proceeding.
  tvangsopplostPgaManglendeRegnskapDato?: string;
  tvangsopplostPgaManglendeRevisorDato?: string;
  tvangsopplostPgaMangelfulltStyreDato?: string;
  tvangsavvikletPgaManglendeSlettingDato?: string;
  slettedato?: string;
  stiftelsesdato?: string;
  /**
   * Closure date for sub-entities (returned by `/underenheter`).
   * A populated `nedleggelsesdato` marks the sub-entity as closed even
   * when the parent `slettedato` / `konkurs` flags are absent.
   */
  nedleggelsesdato?: string;
};

export type BrregSearchResponse = {
  _embedded?: {
    enheter?: BrregRawEnhet[];
  };
  page?: {
    size: number;
    totalElements: number;
    totalPages: number;
    number: number;
  };
};

export type BrregErrorResponse = {
  tidspunkt?: string;
  status?: number;
  feilmelding?: string;
  hjelp?: string;
};

// ---------------------------------------------------------------------------
// Domain output types
// ---------------------------------------------------------------------------

export type BrregAddress = {
  street: string | null;
  postalCode: string | null;
  city: string | null;
  municipality: string | null;
  country: string | null;
  textAddress: string | null;
};

export type BrregIndustryCode = {
  code: string;
  description: string | null;
};

// Whether the entity is currently active. Modelled as a discriminated
// union so consumers exhaustively handle the wind-down states instead
// of relying on a soup of boolean flags.
//
// Brreg differentiates voluntary liquidation (`underAvvikling`,
// initiated by the shareholders) from compulsory liquidation
// (`underTvangsavviklingEllerTvangsopplosning`, initiated by the
// register or a court for failure-to-file accounts / missing auditor
// / etc.) — both surfaces as separate union arms so legal callers can
// tell the two regimes apart. `openedAt` carries the proceeding's
// start date when the upstream payload includes one (Brreg has no
// dedicated `/konkursdetaljer` endpoint; the date lives on the entity
// payload itself).
export type BrregEntityStatus =
  | { type: "active" }
  | { type: "bankruptcy"; openedAt: string | null }
  | { type: "voluntary_liquidation"; openedAt: string | null }
  | { type: "compulsory_liquidation"; openedAt: string | null }
  | { type: "deleted"; deletedAt: string };

export type BrregEntity = {
  orgnr: string;
  name: string;
  legalForm: string | null;
  legalFormCode: string | null;
  businessAddress: BrregAddress | null;
  postalAddress: BrregAddress | null;
  registeredAt: string | null;
  establishedAt: string | null;
  industryCodes: BrregIndustryCode[];
  numberOfEmployees: number | null;
  status: BrregEntityStatus;
  vatRegistered: boolean;
  registryUrl: string;
};

export type BrregSearchResult = {
  orgnr: string;
  name: string;
  address: string | null;
};
