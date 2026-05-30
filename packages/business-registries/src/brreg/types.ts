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
  underAvvikling?: boolean;
  underTvangsavviklingEllerTvangsopplosning?: boolean;
  slettedato?: string;
  stiftelsesdato?: string;
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
// union so consumers exhaustively handle the "winding-up" and
// "deleted" states instead of relying on a soup of boolean flags.
export type BrregEntityStatus =
  | { type: "active" }
  | { type: "bankruptcy" }
  | { type: "winding_up" }
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
